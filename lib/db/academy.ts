// Academy (LMS) data layer. Server-role only (deny-by-default RLS) — every read/
// write is BOLA-guarded (ownership / instructor-assignment / clearance), and all
// list reads are capped. Mutations emit an id-only `academy_update` on the
// realtime channel. Single-org: there is NO organization_id — the tenant
// dimension is gone; every OTHER assert (instructor assignment, enrolment
// ownership, capacity, the cert-award double gate) stays.
import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { SecurityDenial } from '../errors.js';
import { log as baseLog } from '../log.js';
import { sanitizeTiptapJson, tryParseTiptapJson } from '../tiptapValidate.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import { stripHtml } from '../textSanitize.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { awardCertification } from './system.js';
import { createNotification } from './notifications.js';
import { requireClientRoleId } from './clientRoleLock.js';
import {
    toAcademyCourse, toAcademyModule, toAcademyLesson, toAcademyOutcome,
    toAcademySession, toAcademyEnrollment, toAcademyLessonProgress,
    toAcademyOutcomeResult,
} from './mappers.js';
import type {
    AcademyCourse, AcademyModule, AcademySession, AcademyEnrollment, AcademyEnrollmentRequest,
    AcademyUserRef, AcademyOutcomeVerdict, AcademySessionStatus, AcademyCourseDelivery,
    AcademyCourseStatus, AcademyCertHolder, AcademyCertHoldersReport, AcademyCompletionRow,
    AcademyCourseActivityReport, AcademyTranscript, AcademyTranscriptRow,
} from '../../types.js';

const log = baseLog.child({ module: 'db.academy' });

// ── Explicit column selectors (Rule 1) ──────────────────────────────────────
const COURSE_COLS = 'id, title, description, icon, image_url, status, access, delivery, certification_id, created_by, approved_by, published_at, sort_order, created_at, updated_at';
const COURSE_GUARD_COLS = 'id, title, status, access, delivery, certification_id, created_by';
const MODULE_COLS = 'id, course_id, title, description, sort_order, created_at';
const LESSON_COLS = 'id, module_id, title, content, video_url, sort_order, estimated_minutes, created_at';
const OUTCOME_COLS = 'id, course_id, title, description, sort_order, required, created_at';
const SESSION_COLS = 'id, course_id, title, status, starts_at, ends_at, location, capacity, enrollment_open, is_implicit, created_by, created_at, updated_at';
const SESSION_GUARD_COLS = 'id, course_id, status, capacity, enrollment_open';
const ENROLLMENT_COLS = 'id, session_id, student_id, source, status, assigned_by, recommended_by, recommended_at, certified_by, completed_at, enrolled_at';
const ENROLLMENT_GUARD_COLS = 'id, session_id, student_id, status';
const LESSON_PROGRESS_COLS = 'id, enrollment_id, lesson_id, completed_by, completed_at';
const OUTCOME_RESULT_COLS = 'id, enrollment_id, outcome_id, verdict, assessed_by, assessed_at';
const USER_REF_COLS = 'id, name, avatar_url, rsi_handle';
const CERT_REF_COLS = 'id, name, icon, image_url';

const MAX_LIST = 500;
const MAX_AGG = 5000; // hard backstop for fan-out .in(...) aggregate reads

// ── video_url: public link restricted to a YouTube/Vimeo host allowlist ──────
const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
function sanitizeVideoUrl(raw: unknown): string | null {
    const url = sanitizePublicLinkUrl(raw);
    if (!url) return null;
    try {
        return VIDEO_HOSTS.has(new URL(url).hostname.toLowerCase()) ? url : null;
    } catch { return null; }
}

// Lesson content is authored in the minimal Tiptap editor and stored as a
// validated Tiptap-JSON string: parse -> sanitize (minimal allowlist) -> stringify.
// Whatever the client sends can only ever persist as a clean, allow-listed doc.
function sanitizeLessonContent(raw: unknown): string | null {
    if (raw == null) return null;
    const doc = typeof raw === 'string' ? tryParseTiptapJson(raw) : (typeof raw === 'object' ? raw as Record<string, unknown> : null);
    if (!doc) return null;
    try {
        return JSON.stringify(sanitizeTiptapJson(doc, 'minimal'));
    } catch {
        return null; // not a valid Tiptap document
    }
}

// ── User-ref hydration (batch; avoids fragile FK-embed strings) ──────────────
async function fetchUserRefs(ids: Array<number | null | undefined>): Promise<Map<number, AcademyUserRef>> {
    const map = new Map<number, AcademyUserRef>();
    const unique = [...new Set(ids)].filter((n): n is number => typeof n === 'number');
    if (unique.length === 0) return map;
    const { data, error } = await supabase.from('users').select(USER_REF_COLS).in('id', unique);
    if (error && error.code === '42P01') return map;
    handleSupabaseError({ error, message: 'Failed to load academy user refs' });
    for (const u of data || []) {
        map.set(u.id, { id: u.id, name: u.name ?? '', avatarUrl: u.avatar_url ?? '', rsiHandle: u.rsi_handle ?? '' });
    }
    return map;
}

// ── Resource-existence / BOLA guards ─────────────────────────────────────────
// Single-org: "does this resource exist" IS the tenant boundary. A missing id and
// a would-be foreign id are indistinguishable (same opaque denial) — no existence oracle.
interface CourseGuard { id: string; title: string; status: string; access: string; delivery: string; certificationId: number | null; createdBy: number; }
async function loadCourse(courseId: string): Promise<CourseGuard> {
    const { data, error } = await supabase.from('academy_courses')
        .select(COURSE_GUARD_COLS).eq('id', courseId).maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to load course' });
    if (!data) throw new SecurityDenial('This course is not available.', { auditEvent: 'authz.resource.denied', fields: { courseId } });
    return { id: data.id, title: data.title, status: data.status, access: data.access, delivery: data.delivery, certificationId: data.certification_id ?? null, createdBy: data.created_by };
}

interface SessionGuard { id: string; courseId: string; status: string; capacity: number | null; enrollmentOpen: boolean; }
async function loadSession(sessionId: string): Promise<SessionGuard> {
    const { data, error } = await supabase.from('academy_sessions')
        .select(SESSION_GUARD_COLS).eq('id', sessionId).maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to load session' });
    if (!data) throw new SecurityDenial('This session is not available.', { auditEvent: 'authz.resource.denied', fields: { sessionId } });
    return { id: data.id, courseId: data.course_id, status: data.status, capacity: data.capacity ?? null, enrollmentOpen: data.enrollment_open !== false };
}

interface EnrollmentGuard { id: string; sessionId: string; studentId: number; status: string; }
async function loadEnrollment(enrollmentId: string): Promise<EnrollmentGuard> {
    const { data, error } = await supabase.from('academy_enrollments')
        .select(ENROLLMENT_GUARD_COLS).eq('id', enrollmentId).maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to load enrolment' });
    if (!data) throw new SecurityDenial('This enrolment is not available.', { auditEvent: 'authz.resource.denied', fields: { enrollmentId } });
    return { id: data.id, sessionId: data.session_id, studentId: data.student_id, status: data.status };
}

async function isCourseInstructor(courseId: string, userId: number): Promise<boolean> {
    const { data } = await supabase.from('academy_course_instructors').select('id').eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    return !!data;
}
async function isSessionInstructor(sessionId: string, userId: number): Promise<boolean> {
    const { data } = await supabase.from('academy_session_instructors').select('id').eq('session_id', sessionId).eq('user_id', userId).maybeSingle();
    return !!data;
}

/** Course exists AND (actor holds academy:manage OR is an assigned course instructor). */
async function assertCanEditCourse(courseId: string, userId: number, canManage: boolean): Promise<CourseGuard> {
    const course = await loadCourse(courseId);
    if (canManage || await isCourseInstructor(courseId, userId)) return course;
    throw new SecurityDenial('You are not an instructor of this course.', { auditEvent: 'authz.permission_denied', fields: { courseId, userId } });
}

/** Session exists AND (manage OR session instructor OR the course's instructor). */
async function assertCanRunSession(sessionId: string, userId: number, canManage: boolean): Promise<SessionGuard> {
    const session = await loadSession(sessionId);
    if (canManage || await isSessionInstructor(sessionId, userId) || await isCourseInstructor(session.courseId, userId)) return session;
    throw new SecurityDenial('You are not an instructor of this session.', { auditEvent: 'authz.permission_denied', fields: { sessionId, userId } });
}

// Resolve a child row's owning course, asserting it exists.
async function moduleCourse(moduleId: number): Promise<string> {
    const { data } = await supabase.from('academy_modules').select('course_id').eq('id', moduleId).maybeSingle();
    // Same opaque message as loadCourse's denial branch, so a not-found id is
    // indistinguishable from a foreign one (no existence oracle).
    if (!data) throw new SecurityDenial('This course is not available.', { auditEvent: 'authz.resource.denied', fields: { moduleId } });
    await loadCourse(data.course_id);
    return data.course_id;
}
async function lessonCourse(lessonId: number): Promise<{ courseId: string; moduleId: number }> {
    const { data } = await supabase.from('academy_lessons').select('module_id').eq('id', lessonId).maybeSingle();
    if (!data) throw new SecurityDenial('This course is not available.', { auditEvent: 'authz.resource.denied', fields: { lessonId } });
    const courseId = await moduleCourse(data.module_id);
    return { courseId, moduleId: data.module_id };
}
async function outcomeCourse(outcomeId: number): Promise<string> {
    const { data } = await supabase.from('academy_outcomes').select('course_id').eq('id', outcomeId).maybeSingle();
    if (!data) throw new SecurityDenial('This course is not available.', { auditEvent: 'authz.resource.denied', fields: { outcomeId } });
    await loadCourse(data.course_id);
    return data.course_id;
}

async function assertUserExists(userId: number, label: string): Promise<void> {
    const { data } = await supabase.from('users').select('id').eq('id', userId).is('deleted_at', null).maybeSingle();
    if (!data) throw new SecurityDenial(`${label} is not a valid member.`, { auditEvent: 'authz.invalid_target', fields: { userId } });
}

function notify(payload: Record<string, unknown>): void {
    void broadcastToOrg('academy_update', payload);
}

// ── Notification Center wiring (best-effort: persist + realtime + web-push) ──
/** User ids whose role grants `permission` — routes a recommendation to the
 *  people who can action it. Capped. */
async function usersWithPermission(permission: string): Promise<number[]> {
    const { data: perms } = await supabase.from('permissions').select('id').eq('name', permission).order('id', { ascending: true }).limit(50);
    const permIds = (perms || []).map(p => p.id);
    if (permIds.length === 0) return [];
    // Ordered by role_id, not id: role_permissions has a COMPOSITE primary key
    // (role_id, permission_id) and no id column, so role_id is the tiebreak available.
    // Without it the 2000-row cap truncates a different arbitrary slice on each call, and
    // this feeds a notification fan-out — a nondeterministic cut means a different person
    // misses the notification each time.
    const { data: rp } = await supabase.from('role_permissions').select('role_id').in('permission_id', permIds).order('role_id', { ascending: true }).limit(2000);
    const grantRoleIds = [...new Set((rp || []).map(r => r.role_id))];
    if (grantRoleIds.length === 0) return [];
    const { data: users } = await supabase.from('users').select('id').in('role_id', grantRoleIds).is('deleted_at', null).order('id', { ascending: true }).limit(500);
    return (users || []).map(u => u.id);
}

/** Resolve a session's course id + title for notification copy. */
async function academyCourseContext(sessionId: string): Promise<{ courseId: string; courseTitle: string } | null> {
    const { data: sess } = await supabase.from('academy_sessions').select('course_id').eq('id', sessionId).maybeSingle();
    if (!sess) return null;
    const { data: course } = await supabase.from('academy_courses').select('title').eq('id', sess.course_id).maybeSingle();
    if (!course) return null;
    return { courseId: sess.course_id, courseTitle: course.title };
}

const MAX_COURSE_INSTRUCTORS_NOTIFIED = 50;

/**
 * The instructors to tell about a course decision: the course's own instructor rows plus its
 * author, MINUS client-tier and soft-deleted accounts.
 *
 * The client-tier filter is not defensive decoration. The notification body carries the
 * course TITLE, which is exactly the academy content a Client is denied everywhere else
 * (api/query.ts denies the academy_my subset, api/services.ts denies the whole `academy:`
 * namespace) — and `notifications` IS a client-reachable subset, so a durable row written to
 * a demoted-to-Client account is readable by that external customer and rides an OS push to
 * them. A stale academy_course_instructors row is all it takes.
 *
 * Skips silently rather than refusing, unlike the enrolment path: a stale instructor row must
 * not block a course approval. But every failure to establish the tier resolves to "notify
 * nobody", never "notify anyway".
 *
 * The `.order('id')` is required, not cosmetic — a capped read with no total order fails
 * tests/listReadOrderRatchet.test.ts.
 */
async function courseInstructorIds(courseId: string, authorId: number): Promise<number[]> {
    const { data, error } = await supabase.from('academy_course_instructors')
        .select('user_id').eq('course_id', courseId)
        .order('id', { ascending: true })
        .limit(MAX_COURSE_INSTRUCTORS_NOTIFIED);
    if (error) return [];
    const ids = [...new Set([authorId, ...(data || []).map((r: { user_id: number }) => r.user_id)])]
        .filter((n): n is number => typeof n === 'number' && n > 0);
    if (ids.length === 0) return [];

    let clientRoleId: number;
    try {
        clientRoleId = await requireClientRoleId();
    } catch {
        return [];   // tier unresolvable → notify nobody
    }
    // Capped and ordered: ids is already bounded above, so limit(ids.length) is an exact
    // ceiling that can never truncate — but it keeps this off the uncapped-read budget and
    // satisfies the absolute total-order rule (tests/listReadOrderRatchet.test.ts).
    const { data: members, error: memberErr } = await supabase.from('users')
        .select('id, role_id').in('id', ids).is('deleted_at', null)
        .order('id', { ascending: true }).limit(ids.length);
    if (memberErr) return [];
    return (members || []).filter((m: { id: number; role_id: number }) => m.role_id !== clientRoleId).map((m) => m.id);
}

/** Fan an academy notification to each recipient (deduped), best-effort — a
 *  notification failure never blocks the underlying mutation. link is always 'academy'. */
async function pushAcademyNotifications(userIds: number[], payload: { type: string; title: string; body: string; metadata: Record<string, unknown> }): Promise<void> {
    const ids = [...new Set(userIds)].filter((n): n is number => typeof n === 'number');
    if (ids.length === 0) return;
    await Promise.all(ids.map(uid => createNotification(uid, {
        type: payload.type, title: payload.title, body: payload.body, link: 'academy', metadata: payload.metadata,
    }).catch(() => { /* best-effort */ })));
}

// ════════════════════════════════════════════════════════════════════════════
// COURSES
// ════════════════════════════════════════════════════════════════════════════
export interface CourseInput { title?: string; description?: string | null; icon?: string | null; imageUrl?: string | null; sortOrder?: number; delivery?: AcademyCourseDelivery; }

export async function createCourse(userId: number, input: CourseInput): Promise<AcademyCourse> {
    const title = (input.title || '').trim();
    if (!title) throw new Error('Course title is required.');
    const delivery: AcademyCourseDelivery = input.delivery === 'self_paced' ? 'self_paced' : 'cohort';
    const { data, error } = await supabase.from('academy_courses').insert({
        title,
        description: input.description?.trim() || null,
        icon: input.icon?.trim() || null,
        image_url: sanitizeImageUrl(input.imageUrl),
        status: 'draft',
        // Self-paced courses are open-access so members can enrol straight from the catalogue.
        access: delivery === 'self_paced' ? 'open' : 'gated',
        delivery,
        created_by: userId,
    }).select(COURSE_COLS).single();
    handleSupabaseError({ error, message: 'Failed to create course' });
    if (!data) throw new Error('Failed to create course');
    // The creator is the first course instructor.
    await supabase.from('academy_course_instructors').insert({ course_id: data.id, user_id: userId, assigned_by: userId });
    notify({ courseId: data.id });
    return toAcademyCourse(data);
}

export async function updateCourse(courseId: string, userId: number, canManage: boolean, input: CourseInput): Promise<AcademyCourse> {
    const course = await assertCanEditCourse(courseId, userId, canManage);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.title !== undefined) { const t = input.title.trim(); if (!t) throw new Error('Course title is required.'); patch.title = t; }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.icon !== undefined) patch.icon = input.icon?.trim() || null;
    if (input.imageUrl !== undefined) patch.image_url = sanitizeImageUrl(input.imageUrl);
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
    if (input.delivery !== undefined) {
        // Delivery mode is structural (a self-paced course grows an implicit session on
        // publish), so it may only change while the course is still a draft.
        if (course.status !== 'draft') throw new Error('Delivery mode can only be changed while the course is a draft.');
        const delivery: AcademyCourseDelivery = input.delivery === 'self_paced' ? 'self_paced' : 'cohort';
        patch.delivery = delivery;
        patch.access = delivery === 'self_paced' ? 'open' : 'gated';
    }
    const { data, error } = await supabase.from('academy_courses').update(patch)
        .eq('id', courseId).select(COURSE_COLS).single();
    handleSupabaseError({ error, message: 'Failed to update course' });
    if (!data) throw new Error('Failed to update course');
    notify({ courseId });
    return toAcademyCourse(data);
}

/** Deletable only while draft/archived (never mid-run). Cascade removes children. */
export async function deleteCourse(courseId: string, userId: number, canManage: boolean): Promise<void> {
    const course = await assertCanEditCourse(courseId, userId, canManage);
    if (course.status !== 'draft' && course.status !== 'archived') throw new Error('Only draft or archived courses can be deleted.');
    const { error } = await supabase.from('academy_courses').delete().eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to delete course' });
    notify({ courseId });
}

/** Link/unlink the reward certification. Requires cert-award authority (privilege gate). */
export async function setCourseCertification(courseId: string, certificationId: number | null, userId: number, canAward: boolean): Promise<void> {
    await loadCourse(courseId);
    if (!canAward) throw new SecurityDenial('Linking a certification requires the Award Certification permission.', { auditEvent: 'authz.escalation.denied', fields: { courseId } });
    if (certificationId != null) {
        const { data } = await supabase.from('certifications').select('id').eq('id', certificationId).maybeSingle();
        if (!data) throw new SecurityDenial('That certification does not exist.', { auditEvent: 'authz.invalid_target', fields: { certId: certificationId } });
    }
    const { error } = await supabase.from('academy_courses').update({ certification_id: certificationId, updated_at: new Date().toISOString() })
        .eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to set course certification' });
    notify({ courseId });
}

/** Instructor submits a draft for Learning-Admin approval. */
export async function submitCourseForApproval(courseId: string, userId: number, canManage: boolean): Promise<void> {
    const course = await assertCanEditCourse(courseId, userId, canManage);
    if (course.status !== 'draft') throw new Error('Only draft courses can be submitted for approval.');
    const { error } = await supabase.from('academy_courses').update({ status: 'pending_approval', updated_at: new Date().toISOString() })
        .eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to submit course' });
    notify({ courseId });
}

/** A self-paced course is backed by one hidden, auto-managed session that members
 *  enrol into directly from the catalogue. Idempotent: created once, on publish. */
async function ensureImplicitSession(courseId: string, userId: number): Promise<void> {
    const { data: existing } = await supabase.from('academy_sessions')
        .select('id').eq('course_id', courseId).eq('is_implicit', true).limit(1).maybeSingle();
    if (existing) return;
    const { error } = await supabase.from('academy_sessions').insert({
        course_id: courseId,
        title: 'Self-paced',
        status: 'in_progress',
        enrollment_open: true,
        capacity: null,
        is_implicit: true,
        created_by: userId,
    });
    handleSupabaseError({ error, message: 'Failed to create self-paced session' });
}

/** Learning Admin (academy:manage, dispatcher-gated) approves + publishes. */
export async function approveCourse(courseId: string, userId: number, note?: unknown): Promise<void> {
    const course = await loadCourse(courseId);
    if (course.status !== 'pending_approval') throw new Error('Only courses pending approval can be approved.');
    const { error } = await supabase.from('academy_courses').update({ status: 'published', approved_by: userId, published_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to approve course' });
    // Recorded AFTER the status change here, unlike reject: an approval carries no
    // mandatory note, so a trail failure must not block a decision that is already
    // fully expressed by the published status.
    await recordCourseReview(courseId, 'approved', stripHtml(note, 2000) || null, userId);
    // Self-paced courses need their evergreen enrolment session to exist once published.
    if (course.delivery === 'self_paced') await ensureImplicitSession(courseId, userId);
    const approveRecipients = (await courseInstructorIds(courseId, course.createdBy)).filter((id) => id !== userId);
    await pushAcademyNotifications(approveRecipients, {
        type: 'academy_course_approved',
        title: 'Course approved',
        body: `${course.title} has been approved and published.`,
        metadata: { courseId },
    });
    notify({ courseId });
}

/**
 * Record an approve/reject decision, with the reviewer's note.
 *
 * THROWS on a missing table rather than swallowing 42P01, and that is a deliberate
 * departure from hosted, whose comment says "losing the audit row is better than
 * blocking the workflow". It is not, once the note is mandatory: in the window where
 * the code is deployed and schema.sql has not been re-applied, a swallow means the
 * note guard passes, the insert vanishes, the course flips to draft, and the author is
 * notified that feedback exists — then opens the course and finds nothing. The feature
 * destroys the one thing it exists to deliver while claiming it succeeded.
 *
 * Same cause and the same answer as the seat claim: an operator-actionable refusal.
 */
async function recordCourseReview(courseId: string, decision: 'approved' | 'rejected', note: string | null, reviewerId: number): Promise<void> {
    const { error } = await supabase.from('academy_course_reviews')
        .insert({ course_id: courseId, decision, note, reviewed_by: reviewerId });
    if (error) {
        const code = (error as { code?: string }).code;
        if (code === '42P01' || code === 'PGRST205') {
            throw new Error('Course review history is unavailable until the database schema is re-applied (schema.sql). Ask an administrator to run it.');
        }
        handleSupabaseError({ error, message: 'Failed to record the review decision' });
    }
}

/** The decision trail for one course, newest first. Author- and manager-visible. */
export async function listCourseReviews(courseId: string): Promise<Array<{ id: number; decision: 'approved' | 'rejected'; note: string | null; reviewedBy: number; createdAt: string }>> {
    const { data, error } = await supabase.from('academy_course_reviews')
        .select('id, decision, note, reviewed_by, created_at')
        .eq('course_id', courseId)
        // created_at is not unique — two decisions can share a timestamp — so id is
        // what makes this a total order, as the absolute rule requires of a capped read.
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(50);
    if (error && ((error as { code?: string }).code === '42P01' || (error as { code?: string }).code === 'PGRST205')) return [];
    handleSupabaseError({ error, message: 'Failed to load course reviews' });
    return ((data || []) as Array<{ id: number; decision: string; note: string | null; reviewed_by: number; created_at: string }>).map((r) => ({
        id: r.id,
        decision: r.decision === 'approved' ? 'approved' : 'rejected',
        note: r.note,
        reviewedBy: r.reviewed_by,
        createdAt: r.created_at,
    }));
}

export async function rejectCourse(courseId: string, userId: number, note?: unknown): Promise<void> {
    const course = await loadCourse(courseId);
    // STATUS GUARD, matching approveCourse's. Without it a manager can "reject" a
    // published course and silently unpublish it — a takedown wearing a review's
    // clothes, with members already enrolled.
    if (course.status !== 'pending_approval') throw new Error('Only courses pending approval can be returned for revision.');
    // MANDATORY. A course bouncing back to draft with no statement of what was wrong
    // is the defect this whole part exists to fix; an optional note would leave it in
    // place for anyone who skips the field.
    const reason = stripHtml(note, 2000);
    if (!reason) throw new Error('A reason is required when returning a course for revision.');

    // The trail FIRST: if it cannot be written the course must not move, or the author
    // gets a status change with no explanation attached to it.
    await recordCourseReview(courseId, 'rejected', reason, userId);

    const { error } = await supabase.from('academy_courses').update({ status: 'draft', updated_at: new Date().toISOString() })
        .eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to reject course' });
    const rejectRecipients = (await courseInstructorIds(courseId, course.createdBy)).filter((id) => id !== userId);
    await pushAcademyNotifications(rejectRecipients, {
        type: 'academy_course_rejected',
        title: 'Course returned for revision',
        // Generic BY NECESSITY, like every other notification body in this build: a
        // durable notification row and an OS push tray are not permission-filtered at
        // read time, and the reviewer's note is staff commentary on someone's work.
        body: `${course.title} was returned to draft with reviewer feedback.`,
        metadata: { courseId },
    });
    notify({ courseId });
}

export async function setCourseArchived(courseId: string, archived: boolean): Promise<void> {
    const course = await loadCourse(courseId);
    const status = archived ? 'archived' : (course.status === 'archived' ? 'draft' : course.status);
    const { error } = await supabase.from('academy_courses').update({ status, updated_at: new Date().toISOString() })
        .eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to archive course' });
    notify({ courseId });
}

export async function setCourseAccess(courseId: string, access: 'open' | 'gated'): Promise<void> {
    if (access !== 'open' && access !== 'gated') throw new Error('Invalid access value.');
    await loadCourse(courseId);
    const { error } = await supabase.from('academy_courses').update({ access, updated_at: new Date().toISOString() })
        .eq('id', courseId);
    handleSupabaseError({ error, message: 'Failed to set course access' });
    notify({ courseId });
}

// ── Course instructors ──────────────────────────────────────────────────────
export async function addCourseInstructor(courseId: string, targetUserId: number, actorUserId: number, canManage: boolean): Promise<void> {
    await assertCanEditCourse(courseId, actorUserId, canManage);
    await assertUserExists(targetUserId, 'Instructor');
    const { error } = await supabase.from('academy_course_instructors').insert({ course_id: courseId, user_id: targetUserId, assigned_by: actorUserId });
    if (error && error.code !== '23505') handleSupabaseError({ error, message: 'Failed to add instructor' });
    notify({ courseId });
}
/** Batch-add course instructors: one edit-authority check + one existence check + one insert. */
export async function addCourseInstructors(courseId: string, targetUserIds: number[], actorUserId: number, canManage: boolean): Promise<number> {
    await assertCanEditCourse(courseId, actorUserId, canManage);
    const ids = [...new Set(targetUserIds)].filter((n): n is number => typeof n === 'number').slice(0, 100);
    if (ids.length === 0) return 0;
    const { data: members } = await supabase.from('users').select('id').in('id', ids).is('deleted_at', null);
    const valid = new Set((members || []).map(m => m.id));
    const invalid = ids.find(id => !valid.has(id));
    if (invalid !== undefined) throw new SecurityDenial('Instructor is not a valid member.', { auditEvent: 'authz.invalid_target', fields: { userId: invalid } });
    const { data: existingInstr } = await supabase.from('academy_course_instructors').select('user_id').eq('course_id', courseId).in('user_id', ids);
    const already = new Set((existingInstr || []).map(r => r.user_id));
    const toAdd = ids.filter(id => !already.has(id));
    if (toAdd.length === 0) { notify({ courseId }); return 0; }
    const { error } = await supabase.from('academy_course_instructors').insert(
        toAdd.map(uid => ({ course_id: courseId, user_id: uid, assigned_by: actorUserId })),
    );
    if (error && error.code !== '23505') handleSupabaseError({ error, message: 'Failed to add instructors' });
    notify({ courseId });
    return toAdd.length;
}

/** Bulk-withdraw enrolments within one session (one session guard + one scoped update).
 *  The update is session-scoped so a spoofed id from elsewhere is a silent no-op. */
export async function withdrawEnrollmentsBulk(sessionId: string, enrollmentIds: string[], actorUserId: number, canManage: boolean): Promise<number> {
    await assertCanRunSession(sessionId, actorUserId, canManage);
    const ids = [...new Set(enrollmentIds)].filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 500);
    if (ids.length === 0) return 0;
    const { data, error } = await supabase.from('academy_enrollments').update({ status: 'withdrawn' })
        .eq('session_id', sessionId).in('id', ids).neq('status', 'withdrawn').select('id');
    handleSupabaseError({ error, message: 'Failed to withdraw enrolments' });
    notify({ sessionId });
    return (data || []).length;
}

/** Bulk-recommend enrolments in one session for certification. Only enrolments whose
 *  required outcomes are all competent are recommended; returns { recommended, skipped }. */
export async function recommendEnrollmentsBulk(sessionId: string, enrollmentIds: string[], actorUserId: number, canManage: boolean): Promise<{ recommended: number; skipped: number }> {
    const session = await assertCanRunSession(sessionId, actorUserId, canManage);
    const ids = [...new Set(enrollmentIds)].filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 500);
    if (ids.length === 0) return { recommended: 0, skipped: 0 };
    // Only enrolments that really are in this session (session-scoped) and still active.
    const { data: enrRows } = await supabase.from('academy_enrollments').select('id, status')
        .eq('session_id', sessionId).in('id', ids);
    const active = (enrRows || []).filter(e => e.status === 'enrolled' || e.status === 'in_progress').map(e => e.id);
    if (active.length === 0) return { recommended: 0, skipped: ids.length };
    // Required outcomes are identical for every enrolment in the course — fetch once.
    const { data: outcomes } = await supabase.from('academy_outcomes').select('id, required').eq('course_id', session.courseId);
    const required = (outcomes || []).filter(o => o.required !== false).map(o => o.id);
    let eligible: string[];
    if (required.length === 0) {
        eligible = active;
    } else {
        const { data: results } = await supabase.from('academy_outcome_results').select('enrollment_id, outcome_id, verdict').in('enrollment_id', active).order('id', { ascending: true }).limit(MAX_AGG);
        const competentByEnr = new Map<string, Set<number>>();
        for (const r of results || []) {
            if (r.verdict !== 'competent') continue;
            const set = competentByEnr.get(r.enrollment_id) || new Set<number>();
            set.add(r.outcome_id); competentByEnr.set(r.enrollment_id, set);
        }
        eligible = active.filter(id => { const s = competentByEnr.get(id); return !!s && required.every(o => s.has(o)); });
    }
    if (eligible.length === 0) return { recommended: 0, skipped: ids.length };
    const { error } = await supabase.from('academy_enrollments').update({ recommended_by: actorUserId, recommended_at: new Date().toISOString() })
        .eq('session_id', sessionId).in('id', eligible);
    handleSupabaseError({ error, message: 'Failed to recommend enrolments' });
    notify({ sessionId });
    // One batched notification to the learning managers who can certify.
    const [ctx, managers] = await Promise.all([academyCourseContext(sessionId), usersWithPermission('academy:manage')]);
    if (ctx && managers.length) {
        await pushAcademyNotifications(managers, { type: 'academy_recommended', title: 'Ready for certification', body: `${eligible.length} student${eligible.length === 1 ? '' : 's'} recommended for certification in ${ctx.courseTitle}.`, metadata: { courseId: ctx.courseId, sessionId, count: eligible.length } });
    }
    return { recommended: eligible.length, skipped: ids.length - eligible.length };
}

export async function removeCourseInstructor(courseId: string, targetUserId: number, actorUserId: number, canManage: boolean): Promise<void> {
    await assertCanEditCourse(courseId, actorUserId, canManage);
    const { error } = await supabase.from('academy_course_instructors').delete().eq('course_id', courseId).eq('user_id', targetUserId);
    handleSupabaseError({ error, message: 'Failed to remove instructor' });
    notify({ courseId });
}

// ════════════════════════════════════════════════════════════════════════════
// MODULES · LESSONS · OUTCOMES  (curriculum; edits gated to course instructors)
// ════════════════════════════════════════════════════════════════════════════

// ── Curriculum ordering ─────────────────────────────────────────────────────
// Rows are spaced by SORT_STEP so inserting between two of them does not require
// rewriting the whole list. The 10 is mirrored in academy_apply_order() in
// schema.sql; tests/academyCurriculum.test.ts pins the pair.
//
// sortOrderOf VALIDATES rather than coerces. 0 is a MEANINGFUL position — the front
// of the list — so substituting it for a bad value silently moves a lesson and
// returns 200. The upper bound keeps `max(sort_order) + SORT_STEP` far below the
// int4 ceiling: one row parked at 2147483647 would otherwise wedge every later
// create on that parent with an opaque 22003.
const SORT_STEP = 10;
const MAX_SORT = 1_000_000;
const sortOrderOf = (raw: unknown): number | undefined =>
    (Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= MAX_SORT) ? raw as number : undefined;
/** Validate a client-supplied sortOrder, or throw. Never defaults. */
function requireSortOrder(raw: unknown): number {
    const n = sortOrderOf(raw);
    if (n === undefined) throw new Error(`sortOrder must be a whole number between 0 and ${MAX_SORT}.`);
    return n;
}

// New rows APPEND after the current maximum within the same parent. Before this,
// every create wrote sort_order 0, so a course's modules came back in whatever order
// the planner felt like and could differ between two loads of the same page.
//
// Each runs only AFTER its caller has proven the actor may edit the parent course, so
// the parent-id filter alone is sufficient scope. A real read failure must NOT be
// swallowed: falling back to SORT_STEP would tie the new row with the FIRST existing
// one, which is the same nondeterminism in a smaller box.
async function nextModuleSortOrder(courseId: string): Promise<number> {
    const { data, error } = await supabase.from('academy_modules').select('sort_order')
        .eq('course_id', courseId).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    handleSupabaseError({ error, message: 'Failed to resolve module order' });
    return (data?.sort_order ?? 0) + SORT_STEP;
}
async function nextLessonSortOrder(moduleId: number): Promise<number> {
    const { data, error } = await supabase.from('academy_lessons').select('sort_order')
        .eq('module_id', moduleId).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    handleSupabaseError({ error, message: 'Failed to resolve lesson order' });
    return (data?.sort_order ?? 0) + SORT_STEP;
}
async function nextOutcomeSortOrder(courseId: string): Promise<number> {
    const { data, error } = await supabase.from('academy_outcomes').select('sort_order')
        .eq('course_id', courseId).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    handleSupabaseError({ error, message: 'Failed to resolve outcome order' });
    return (data?.sort_order ?? 0) + SORT_STEP;
}
export interface ModuleInput { title?: string; description?: string | null; sortOrder?: number; }
export async function createModule(courseId: string, userId: number, canManage: boolean, input: ModuleInput): Promise<AcademyModule> {
    await assertCanEditCourse(courseId, userId, canManage);
    const title = (input.title || '').trim();
    if (!title) throw new Error('Module title is required.');
    const { data, error } = await supabase.from('academy_modules').insert({
        course_id: courseId, title, description: input.description?.trim() || null,
        // An explicitly supplied position is VALIDATED, not silently replaced by the
        // append default — that is the same "never write a position the caller did not
        // ask for" rule the update path follows.
        sort_order: input.sortOrder !== undefined ? requireSortOrder(input.sortOrder) : await nextModuleSortOrder(courseId),
    }).select(MODULE_COLS).single();
    handleSupabaseError({ error, message: 'Failed to create module' });
    if (!data) throw new Error('Failed to create module');
    notify({ courseId });
    return toAcademyModule(data);
}
export async function updateModule(moduleId: number, userId: number, canManage: boolean, input: ModuleInput): Promise<void> {
    const courseId = await moduleCourse(moduleId);
    await assertCanEditCourse(courseId, userId, canManage);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) { const t = input.title.trim(); if (!t) throw new Error('Module title is required.'); patch.title = t; }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.sortOrder !== undefined) patch.sort_order = requireSortOrder(input.sortOrder);
    const { error } = await supabase.from('academy_modules').update(patch).eq('id', moduleId);
    handleSupabaseError({ error, message: 'Failed to update module' });
    notify({ courseId });
}
export async function deleteModule(moduleId: number, userId: number, canManage: boolean): Promise<void> {
    const courseId = await moduleCourse(moduleId);
    await assertCanEditCourse(courseId, userId, canManage);
    const { error } = await supabase.from('academy_modules').delete().eq('id', moduleId);
    handleSupabaseError({ error, message: 'Failed to delete module' });
    notify({ courseId });
}

export interface LessonInput { title?: string; content?: string | null; videoUrl?: string | null; sortOrder?: number; estimatedMinutes?: number | null; }
export async function createLesson(moduleId: number, userId: number, canManage: boolean, input: LessonInput): Promise<void> {
    const courseId = await moduleCourse(moduleId);
    await assertCanEditCourse(courseId, userId, canManage);
    const title = (input.title || '').trim();
    if (!title) throw new Error('Lesson title is required.');
    const { error } = await supabase.from('academy_lessons').insert({
        module_id: moduleId, title,
        content: sanitizeLessonContent(input.content),
        video_url: sanitizeVideoUrl(input.videoUrl),
        sort_order: input.sortOrder !== undefined ? requireSortOrder(input.sortOrder) : await nextLessonSortOrder(moduleId),
        estimated_minutes: input.estimatedMinutes ?? null,
    });
    handleSupabaseError({ error, message: 'Failed to create lesson' });
    notify({ courseId });
}
export async function updateLesson(lessonId: number, userId: number, canManage: boolean, input: LessonInput): Promise<void> {
    const { courseId } = await lessonCourse(lessonId);
    await assertCanEditCourse(courseId, userId, canManage);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) { const t = input.title.trim(); if (!t) throw new Error('Lesson title is required.'); patch.title = t; }
    if (input.content !== undefined) patch.content = sanitizeLessonContent(input.content);
    if (input.videoUrl !== undefined) patch.video_url = sanitizeVideoUrl(input.videoUrl);
    if (input.sortOrder !== undefined) patch.sort_order = requireSortOrder(input.sortOrder);
    if (input.estimatedMinutes !== undefined) patch.estimated_minutes = input.estimatedMinutes ?? null;
    const { error } = await supabase.from('academy_lessons').update(patch).eq('id', lessonId);
    handleSupabaseError({ error, message: 'Failed to update lesson' });
    notify({ courseId });
}
export async function deleteLesson(lessonId: number, userId: number, canManage: boolean): Promise<void> {
    const { courseId } = await lessonCourse(lessonId);
    await assertCanEditCourse(courseId, userId, canManage);
    const { error } = await supabase.from('academy_lessons').delete().eq('id', lessonId);
    handleSupabaseError({ error, message: 'Failed to delete lesson' });
    notify({ courseId });
}

export interface OutcomeInput { title?: string; description?: string | null; sortOrder?: number; required?: boolean; }
export async function createOutcome(courseId: string, userId: number, canManage: boolean, input: OutcomeInput): Promise<void> {
    await assertCanEditCourse(courseId, userId, canManage);
    const title = (input.title || '').trim();
    if (!title) throw new Error('Outcome title is required.');
    const { error } = await supabase.from('academy_outcomes').insert({
        course_id: courseId, title, description: input.description?.trim() || null,
        sort_order: input.sortOrder !== undefined ? requireSortOrder(input.sortOrder) : await nextOutcomeSortOrder(courseId),
        required: input.required !== false,
    });
    handleSupabaseError({ error, message: 'Failed to create outcome' });
    notify({ courseId });
}
export async function updateOutcome(outcomeId: number, userId: number, canManage: boolean, input: OutcomeInput): Promise<void> {
    const courseId = await outcomeCourse(outcomeId);
    await assertCanEditCourse(courseId, userId, canManage);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) { const t = input.title.trim(); if (!t) throw new Error('Outcome title is required.'); patch.title = t; }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.sortOrder !== undefined) patch.sort_order = requireSortOrder(input.sortOrder);
    if (input.required !== undefined) patch.required = !!input.required;
    const { error } = await supabase.from('academy_outcomes').update(patch).eq('id', outcomeId);
    handleSupabaseError({ error, message: 'Failed to update outcome' });
    notify({ courseId });
}
export async function deleteOutcome(outcomeId: number, userId: number, canManage: boolean): Promise<void> {
    const courseId = await outcomeCourse(outcomeId);
    await assertCanEditCourse(courseId, userId, canManage);
    const { error } = await supabase.from('academy_outcomes').delete().eq('id', outcomeId);
    handleSupabaseError({ error, message: 'Failed to delete outcome' });
    notify({ courseId });
}

// ── Reordering ───────────────────────────────────────────────────────────────
// ONE batched action per entity rather than N per-item nudges. A per-item
// `update_module {sortOrder}` costs two guard round-trips EACH (moduleCourse →
// assertCanEditCourse) times N per drag, fires N broadcasts, and cannot express
// "here is the whole intended order" — which is precisely what the write needs.
const MAX_REORDER = 200;

/**
 * Validate a client-supplied ordered id list. REJECTS rather than repairs:
 *  - over the cap it throws instead of slicing. Truncating a reorder array corrupts
 *    the very order it was asked to write (unlike the bulk-withdraw slice, where
 *    dropping ids just withdraws fewer people).
 *  - duplicates throw instead of being deduped: a deduped list is not the order the
 *    caller asked for, and quietly writing a different one is worse than refusing.
 */
function normalizeOrder(raw: unknown, label: string): number[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label}: an ordered list of ids is required.`);
    if (raw.length > MAX_REORDER) throw new Error(`${label}: cannot reorder more than ${MAX_REORDER} items at once.`);
    const ids = raw.filter((n): n is number => Number.isInteger(n) && (n as number) > 0);
    if (ids.length !== raw.length) throw new Error(`${label}: the ordered list contained something that is not an id.`);
    if (new Set(ids).size !== ids.length) throw new Error(`${label}: the ordered list contained duplicates.`);
    return ids;
}

/**
 * Re-space one parent's whole child list, atomically, in the database.
 *
 * There is deliberately NO TypeScript-side "prove every id belongs to this parent"
 * pre-check. It would be a second round trip that establishes a fact the write then
 * re-establishes anyway, with a TOCTOU window in between — academy_apply_order()
 * counts the siblings, writes, and compares ROW_COUNT inside one transaction, so a
 * foreign id, a duplicate, or a concurrent insert all roll the whole thing back.
 *
 * Fails CLOSED when the function is absent (42883 / PGRST202 on an un-migrated
 * database): silently falling back to N updates would reintroduce exactly the
 * partial-write behaviour this exists to remove.
 */
async function applyOrder(entity: 'modules' | 'lessons' | 'outcomes', parent: string, ids: number[], fields: Record<string, unknown>): Promise<void> {
    const { error } = await supabase.rpc('academy_apply_order', { p_entity: entity, p_parent: parent, p_ids: ids });
    if (!error) return;
    const code = String((error as { code?: string }).code || '');
    if (code === '42883' || code === 'PGRST202') {
        throw new Error('Curriculum reordering is unavailable until schema.sql is re-applied (academy_apply_order is missing).');
    }
    const message = String((error as { message?: string }).message || '');
    if (message.includes('ACADEMY_ORDER_INCOMPLETE')) {
        throw new Error('Reordering needs the complete list for this parent — send every sibling, not a subset.');
    }
    if (message.includes('ACADEMY_ORDER_FOREIGN')) {
        throw new SecurityDenial('Those items do not all belong to this course.', { auditEvent: 'authz.resource.denied', fields });
    }
    handleSupabaseError({ error, message: 'Failed to reorder' });
}

export async function reorderModules(courseId: string, orderedIds: unknown, userId: number, canManage: boolean): Promise<void> {
    await assertCanEditCourse(courseId, userId, canManage);
    const ids = normalizeOrder(orderedIds, 'reorderModules');
    await applyOrder('modules', courseId, ids, { courseId });
    notify({ courseId });
}

export async function reorderLessons(moduleId: number, orderedIds: unknown, userId: number, canManage: boolean): Promise<void> {
    // moduleCourse resolves the owning course with the same opaque denial as a missing
    // one, so a foreign module id is not an existence oracle.
    if (!Number.isInteger(moduleId) || moduleId <= 0) throw new Error('reorderLessons: a module id is required.');
    const courseId = await moduleCourse(moduleId);
    await assertCanEditCourse(courseId, userId, canManage);
    const ids = normalizeOrder(orderedIds, 'reorderLessons');
    await applyOrder('lessons', String(moduleId), ids, { moduleId });
    notify({ courseId });
}

export async function reorderOutcomes(courseId: string, orderedIds: unknown, userId: number, canManage: boolean): Promise<void> {
    await assertCanEditCourse(courseId, userId, canManage);
    const ids = normalizeOrder(orderedIds, 'reorderOutcomes');
    await applyOrder('outcomes', courseId, ids, { courseId });
    notify({ courseId });
}

// ════════════════════════════════════════════════════════════════════════════
// SESSIONS (cohorts)
// ════════════════════════════════════════════════════════════════════════════
export interface SessionInput { title?: string; startsAt?: string | null; endsAt?: string | null; location?: string | null; capacity?: number | null; enrollmentOpen?: boolean; }
export async function createSession(courseId: string, userId: number, canManage: boolean, input: SessionInput): Promise<AcademySession> {
    const course = await assertCanEditCourse(courseId, userId, canManage);
    if (course.status !== 'published') throw new Error('Only published courses can be run as a session.');
    const title = (input.title || '').trim();
    if (!title) throw new Error('Session title is required.');
    const { data, error } = await supabase.from('academy_sessions').insert({
        course_id: courseId, title, status: 'scheduled',
        starts_at: input.startsAt || null, ends_at: input.endsAt || null,
        location: input.location?.trim() || null,
        capacity: input.capacity != null && input.capacity > 0 ? Math.floor(input.capacity) : null,
        enrollment_open: input.enrollmentOpen !== false, created_by: userId,
    }).select(SESSION_COLS).single();
    handleSupabaseError({ error, message: 'Failed to create session' });
    if (!data) throw new Error('Failed to create session');
    await supabase.from('academy_session_instructors').insert({ session_id: data.id, user_id: userId, assigned_by: userId });
    notify({ sessionId: data.id });
    return toAcademySession(data);
}
export async function updateSession(sessionId: string, userId: number, canManage: boolean, input: SessionInput): Promise<void> {
    await assertCanRunSession(sessionId, userId, canManage);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.title !== undefined) { const t = input.title.trim(); if (!t) throw new Error('Session title is required.'); patch.title = t; }
    if (input.startsAt !== undefined) patch.starts_at = input.startsAt || null;
    if (input.endsAt !== undefined) patch.ends_at = input.endsAt || null;
    if (input.location !== undefined) patch.location = input.location?.trim() || null;
    if (input.capacity !== undefined) patch.capacity = input.capacity != null && input.capacity > 0 ? Math.floor(input.capacity) : null;
    if (input.enrollmentOpen !== undefined) patch.enrollment_open = !!input.enrollmentOpen;
    const { error } = await supabase.from('academy_sessions').update(patch).eq('id', sessionId);
    handleSupabaseError({ error, message: 'Failed to update session' });
    notify({ sessionId });
}
const SESSION_TRANSITIONS: Record<string, AcademySessionStatus[]> = {
    scheduled: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
};
export async function setSessionStatus(sessionId: string, status: AcademySessionStatus, userId: number, canManage: boolean): Promise<void> {
    const session = await assertCanRunSession(sessionId, userId, canManage);
    if (!(SESSION_TRANSITIONS[session.status] || []).includes(status)) throw new Error(`Cannot move a ${session.status} session to ${status}.`);
    const { error } = await supabase.from('academy_sessions').update({ status, updated_at: new Date().toISOString() }).eq('id', sessionId);
    handleSupabaseError({ error, message: 'Failed to update session status' });
    notify({ sessionId });
}
export async function addSessionInstructor(sessionId: string, targetUserId: number, actorUserId: number, canManage: boolean): Promise<void> {
    await assertCanRunSession(sessionId, actorUserId, canManage);
    await assertUserExists(targetUserId, 'Instructor');
    const { error } = await supabase.from('academy_session_instructors').insert({ session_id: sessionId, user_id: targetUserId, assigned_by: actorUserId });
    if (error && error.code !== '23505') handleSupabaseError({ error, message: 'Failed to add session instructor' });
    notify({ sessionId });
}
export async function removeSessionInstructor(sessionId: string, targetUserId: number, actorUserId: number, canManage: boolean): Promise<void> {
    await assertCanRunSession(sessionId, actorUserId, canManage);
    const { error } = await supabase.from('academy_session_instructors').delete().eq('session_id', sessionId).eq('user_id', targetUserId);
    handleSupabaseError({ error, message: 'Failed to remove session instructor' });
    notify({ sessionId });
}

// ════════════════════════════════════════════════════════════════════════════
// ENROLMENTS
// ════════════════════════════════════════════════════════════════════════════
/**
 * Student self-enrols: course published + open, session accepting + not full.
 *
 * The capacity check and the insert used to be two statements with nothing between
 * them. The UNIQUE (session_id, student_id) stops the same student twice; it does
 * nothing about two DIFFERENT students racing for the last seat, so a capped session
 * could be overfilled by exactly the number of concurrent claimants. The claim now
 * happens inside academy_claim_seat, which takes the session row FOR UPDATE.
 *
 * The course-level gates stay HERE rather than moving into SQL: they are
 * authorization (published + open access), they raise SecurityDenial with an audit
 * event, and duplicating them in plpgsql would be a second copy to keep in sync.
 * The function owns exactly the thing that needs a lock.
 */
export async function selfEnroll(sessionId: string, studentId: number): Promise<void> {
    const session = await loadSession(sessionId);
    const course = await loadCourse(session.courseId);
    if (course.status !== 'published' || course.access !== 'open') throw new SecurityDenial('This course is not open for self-enrolment.', { auditEvent: 'authz.permission_denied', fields: { sessionId } });
    if (!session.enrollmentOpen || session.status === 'completed' || session.status === 'cancelled') throw new Error('This session is not accepting enrolments.');

    const { error } = await supabase.rpc('academy_claim_seat', {
        p_session_id: sessionId, p_student_id: studentId, p_source: 'self',
    });
    if (error) {
        // FAIL CLOSED on a missing function. The alternative — falling back to the
        // count-then-insert this replaced — would silently reinstate the race on
        // exactly the deployments that have not applied the schema, which are the
        // ones nobody is watching. An operator-actionable refusal instead.
        if (error.code === '42883' || error.code === 'PGRST202') {
            throw new Error('Enrolment is unavailable until the database schema is re-applied (schema.sql). Ask an administrator to run it.');
        }
        // The function raises its own user-facing messages ('This session is full.',
        // 'This session is not accepting enrolments.'), and they are the useful thing
        // to show — but only for a RAISE, never for a raw engine error.
        const msg = String(error.message || '');
        if (/session is full|not accepting enrolments|Session not found/i.test(msg)) throw new Error(msg.replace(/^.*?:\s*/, ''));
        handleSupabaseError({ error, message: 'Failed to enrol' });
    }
    notify({ sessionId });
    const ctx = await academyCourseContext(sessionId);
    if (ctx) await pushAcademyNotifications([studentId], { type: 'academy_enrolled', title: 'Enrolled in a course', body: `You're enrolled in ${ctx.courseTitle}.`, metadata: { courseId: ctx.courseId, sessionId } });
}

/** Instructor/admin batch-assigns students into a session. */
export async function assignStudents(sessionId: string, studentIds: number[], actorUserId: number, canManage: boolean): Promise<number> {
    await assertCanRunSession(sessionId, actorUserId, canManage);
    const ids = [...new Set(studentIds)].filter((n): n is number => typeof n === 'number').slice(0, 200);
    if (ids.length === 0) return 0;
    // Fail CLOSED on an unresolvable Client slot: "I could not tell whether this target is
    // a customer" must block the enrolment, not create it. Same instrument and the same
    // operator-actionable message as assertRoleIsNotClient.
    const clientRoleId = await requireClientRoleId();
    // Batched existence guard: every id must be a live member (one query, not N).
    // role_id is ENUMERATED, never wildcarded (CLAUDE.md security rule 1 — the
    // tests/wildcardSelectRatchet.test.ts baseline is EMPTY and stays that way).
    const { data: members } = await supabase.from('users').select('id, role_id').in('id', ids).is('deleted_at', null);
    const valid = new Set((members || []).map(m => m.id));
    const invalid = ids.find(id => !valid.has(id));
    if (invalid !== undefined) throw new SecurityDenial('Student is not a valid member.', { auditEvent: 'authz.invalid_target', fields: { userId: invalid } });
    // A client account can never OPEN an enrolment — api/query.ts denies academy_my and
    // api/services.ts denies the whole academy: namespace — and the notification pushed
    // below carries the course TITLE, which is exactly the academy content they are
    // denied, through the self-scoped notifications subset a Client still receives.
    // Refuse rather than create a row nobody can act on.
    //
    // ALL-OR-NOTHING, not a silent skip like `toAdd`'s already-enrolled filter below:
    // this function returns a count the instructor is shown, and a partial success (asked
    // for 20, got 19, told nothing) is worse than a refusal under this project's
    // fail-closed rule. The picker (components/views/academy/AcademyInstructorTabs.tsx
    // UserPicker) is fed the UNFILTERED roster and marks nothing, so the message must NAME
    // the refused accounts or the instructor cannot act on it. The ids are safe to return:
    // the caller holds academy:instruct, which is in STAFF_VIEW_PERMS, so mayReceiveRoster
    // already gave them the roster these ids came from.
    //
    // Do NOT "fix" this by filtering the picker on the display tier: inferUserRoleTier
    // (lib/db/mappers.ts) collapses a permissionless "Recruit" role to UserRole.Client,
    // and that role is precisely the population this whole boundary exists to keep
    // enrollable.
    const clientTargets = (members || []).filter(m => m.role_id === clientRoleId).map(m => m.id);
    if (clientTargets.length > 0) {
        throw new SecurityDenial(
            `Client accounts cannot be enrolled in courses (user id${clientTargets.length === 1 ? '' : 's'} ${clientTargets.join(', ')}). Remove them and retry.`,
            { auditEvent: 'authz.invalid_target', fields: { userIds: clientTargets } },
        );
    }
    // Skip already-enrolled students so we insert once and notify only the newcomers.
    const { data: existing } = await supabase.from('academy_enrollments').select('student_id').eq('session_id', sessionId).in('student_id', ids);
    const already = new Set((existing || []).map(e => e.student_id));
    const toAdd = ids.filter(id => !already.has(id));
    if (toAdd.length === 0) { notify({ sessionId }); return 0; }
    const { error } = await supabase.from('academy_enrollments').insert(
        toAdd.map(sid => ({ session_id: sessionId, student_id: sid, source: 'assigned', assigned_by: actorUserId, status: 'enrolled' })),
    );
    if (error && error.code !== '23505') handleSupabaseError({ error, message: 'Failed to assign students' });
    notify({ sessionId });
    const ctx = await academyCourseContext(sessionId);
    if (ctx) await pushAcademyNotifications(toAdd, { type: 'academy_enrolled', title: 'Enrolled in a course', body: `You've been enrolled in ${ctx.courseTitle}.`, metadata: { courseId: ctx.courseId, sessionId } });
    return toAdd.length;
}

/** Student self-withdraws, or an instructor/admin removes them. */
export async function withdrawEnrollment(enrollmentId: string, actorUserId: number, canManage: boolean): Promise<void> {
    const enr = await loadEnrollment(enrollmentId);
    const isSelf = enr.studentId === actorUserId;
    if (!isSelf) {
        // Non-self withdrawal requires instructor/admin authority over the session.
        await assertCanRunSession(enr.sessionId, actorUserId, canManage);
    }
    const { error } = await supabase.from('academy_enrollments').update({ status: 'withdrawn' }).eq('id', enrollmentId);
    handleSupabaseError({ error, message: 'Failed to withdraw enrolment' });
    notify({ sessionId: enr.sessionId });
}


// ════════════════════════════════════════════════════════════════════════════
// ENROLMENT REQUESTS — asking for a seat on a GATED course
// ════════════════════════════════════════════════════════════════════════════
// Self-enrolment covers open courses. This is the ask-first path for everything
// else, so a member can put their hand up rather than waiting to be noticed.
//
// THE FAN-OUT IS ONCE-EVER PER PAIRING, and that is the load-bearing detail.
// academy:request_enrollment is user:manage:self — every authenticated member has
// it — and the CALLER supplies the sessionId, which selects a recipient set of up
// to MAX_APPROVERS_NOTIFIED staff, each getting a durable notification row and a
// web push. The partial unique index bounds only concurrent PENDING duplicates:
// withdraw-then-re-ask clears it, and deny-then-re-ask is deliberate behaviour, so
// neither is a rate limit. Without notified_at one ordinary member sustains
// thousands of notifications a minute against the org's entire instructor
// population, throttled only by the global per-IP request cap.
//
// The request itself stays re-askable — that is the feature. Only the
// ANNOUNCEMENT is once.

const MAX_APPROVERS_NOTIFIED = 50;
const MAX_REQUEST_MESSAGE = 500;

const REQUEST_COLS = 'id, session_id, student_id, status, message, decided_by, decision_reason, decided_at, created_at';

interface RequestRow {
    id: string; session_id: string; student_id: number; status: string; message: string | null;
    decided_by: number | null; decision_reason: string | null; decided_at: string | null; created_at: string;
}
const toRequest = (r: RequestRow): AcademyEnrollmentRequest => ({
    id: r.id, sessionId: r.session_id, studentId: r.student_id,
    status: (['pending', 'approved', 'denied', 'withdrawn'].includes(r.status) ? r.status : 'pending') as AcademyEnrollmentRequest['status'],
    message: r.message, decidedBy: r.decided_by, decisionReason: r.decision_reason,
    decidedAt: r.decided_at, createdAt: r.created_at,
});

/**
 * Who can action a request: the session's instructors, the course's instructors, and
 * every academy:manage holder.
 *
 * Runs through the SAME client-tier filter as courseInstructorIds, because the
 * notification body carries the course title — the exact academy content a Client
 * account is denied everywhere else in this build.
 */
async function requestApprovers(sessionId: string, courseId: string, authorId: number): Promise<number[]> {
    const { data: sessionInstructors } = await supabase.from('academy_session_instructors')
        .select('user_id').eq('session_id', sessionId)
        .order('id', { ascending: true }).limit(MAX_APPROVERS_NOTIFIED);
    const { data: managers } = await supabase.from('users')
        .select('id').in('role_id', await roleIdsWithAcademyManage())
        .is('deleted_at', null)
        .order('id', { ascending: true }).limit(MAX_APPROVERS_NOTIFIED);

    const fromCourse = await courseInstructorIds(courseId, authorId);
    const raw = [
        ...fromCourse,
        ...((sessionInstructors || []) as Array<{ user_id: number }>).map((r) => r.user_id),
        ...((managers || []) as Array<{ id: number }>).map((r) => r.id),
    ];
    // courseInstructorIds already dropped client-tier recipients from its own half;
    // the other two halves have to be filtered too or the tier boundary has a gap.
    let clientRoleId: number;
    try {
        clientRoleId = await requireClientRoleId();
    } catch {
        return [];   // tier unresolvable ⇒ notify nobody, same call courseInstructorIds makes
    }
    const ids = [...new Set(raw)].filter((n): n is number => typeof n === 'number' && n > 0);
    if (ids.length === 0) return [];
    const { data: rows } = await supabase.from('users')
        .select('id, role_id').in('id', ids).is('deleted_at', null)
        .order('id', { ascending: true }).limit(MAX_APPROVERS_NOTIFIED);
    return ((rows || []) as Array<{ id: number; role_id: number | null }>)
        .filter((u) => u.role_id !== clientRoleId)
        .map((u) => u.id)
        .slice(0, MAX_APPROVERS_NOTIFIED);
}

/** Role ids holding academy:manage. Empty on a read fault — notify nobody, never everybody. */
async function roleIdsWithAcademyManage(): Promise<number[]> {
    const { data: perm } = await supabase.from('permissions')
        .select('id').eq('name', 'academy:manage').order('id', { ascending: true }).limit(1).maybeSingle();
    const permId = (perm as { id: number } | null)?.id;
    if (!permId) return [];
    const { data: rp } = await supabase.from('role_permissions')
        .select('role_id').eq('permission_id', permId)
        .order('role_id', { ascending: true }).limit(200);
    return [...new Set(((rp || []) as Array<{ role_id: number }>).map((r) => r.role_id))];
}

/** A member asks for a seat. `studentId` is dispatcher-forced — never a target. */
export async function requestEnrollment(sessionId: string, studentId: number, message?: unknown): Promise<AcademyEnrollmentRequest> {
    const session = await loadSession(sessionId);
    const course = await loadCourse(session.courseId);
    if (course.status !== 'published') throw new SecurityDenial('This course is not available.', { auditEvent: 'authz.resource.denied', fields: { sessionId } });
    if (!session.enrollmentOpen || session.status === 'completed' || session.status === 'cancelled') {
        throw new Error('This session is not accepting enrolments.');
    }
    // An open course needs no request — self-enrol. Refusing here keeps the two paths
    // from drifting into "ask for something you could just take".
    if (course.access === 'open') throw new Error('This course is open — enrol directly rather than requesting a seat.');

    const { data: existingEnrolment } = await supabase.from('academy_enrollments')
        .select('id, status').eq('session_id', sessionId).eq('student_id', studentId).maybeSingle();
    if (existingEnrolment && (existingEnrolment as { status: string }).status !== 'withdrawn') {
        throw new Error('You are already enrolled in this session.');
    }

    // Has this pairing EVER been announced? Asked before the insert so the answer is
    // about history, not about the row we are creating.
    //
    // Asked as an EXISTENCE question over every historical row, not as "read one row
    // and look at it". The earlier form was `.select('id, notified_at').order('id').limit(1)`,
    // and `id` is `uuid PRIMARY KEY DEFAULT gen_random_uuid()` (schema.sql:2629) — a
    // RANDOM key, so ordering by it picks an arbitrary row rather than the earliest.
    // A member who withdraws and re-asks builds up rows whose stamps differ, and each
    // new request re-rolled the dice on which one was read: draw an unstamped row and
    // `alreadyAnnounced` came back false, re-firing a fan-out to every approver. That
    // turns a once-ever notice into a member-triggerable notification amplifier.
    // Filtering on the stamp instead makes the ordering irrelevant.
    //
    // FAILS CLOSED, and closed here means SUPPRESS. The read gates an amplifier, so an
    // unreadable history must not read as "never announced" — that is the direction
    // that spams every approver on a DB blip. A missed notice costs one ping; the
    // request itself is still persisted and visible in the approval queue.
    const { data: prior, error: priorErr } = await supabase.from('academy_enrollment_requests')
        .select('id').eq('session_id', sessionId).eq('student_id', studentId)
        .not('notified_at', 'is', null)
        .order('id', { ascending: true }).limit(1);
    if (priorErr) log.error('enrolment announce-history read failed; suppressing fan-out', { sessionId, studentId, err: priorErr });
    const alreadyAnnounced = priorErr ? true : ((prior || []) as Array<{ id: string }>).length > 0;

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase.from('academy_enrollment_requests').insert({
        session_id: sessionId,
        student_id: studentId,
        status: 'pending',
        message: stripHtml(message, MAX_REQUEST_MESSAGE) || null,
        // Stamped on the FIRST request for this pairing, so the fan-out below runs once
        // ever regardless of how many times the member withdraws and re-asks.
        notified_at: alreadyAnnounced ? null : nowIso,
    }).select(REQUEST_COLS).single();
    if (error && (error as { code?: string }).code === '23505') {
        throw new Error('You already have a pending request for this session.');
    }
    handleSupabaseError({ error, message: 'Failed to request enrolment' });

    if (!alreadyAnnounced) {
        const approvers = await requestApprovers(sessionId, session.courseId, course.createdBy);
        await pushAcademyNotifications(approvers.filter((id) => id !== studentId), {
            type: 'academy_enrollment_requested',
            title: 'Enrolment request',
            // Generic, like every academy notification body: a durable row and a push
            // tray are not permission-filtered at read time.
            body: 'A member has asked to join a course session.',
            metadata: { sessionId, courseId: session.courseId },
        });
    }
    notify({ sessionId });
    return toRequest(data as unknown as RequestRow);
}

/** The member takes their own request back. Self-scoped by construction. */
export async function withdrawEnrollmentRequest(requestId: string, actorUserId: number): Promise<void> {
    const { data } = await supabase.from('academy_enrollment_requests')
        .select('id, student_id, status, session_id').eq('id', requestId).maybeSingle();
    const req = data as { id: string; student_id: number; status: string; session_id: string } | null;
    if (!req || req.student_id !== actorUserId) {
        throw new SecurityDenial('Request not found.', { auditEvent: 'authz.resource.denied', fields: { requestId } });
    }
    if (req.status !== 'pending') throw new Error('Only a pending request can be withdrawn.');
    const { error } = await supabase.from('academy_enrollment_requests')
        .update({ status: 'withdrawn' }).eq('id', requestId).eq('status', 'pending');
    handleSupabaseError({ error, message: 'Failed to withdraw the request' });
    notify({ sessionId: req.session_id });
}

/** Staff decide. Approving claims a seat through the SAME atomic path as self-enrol. */
export async function decideEnrollmentRequest(
    requestId: string, decision: 'approve' | 'deny', actorUserId: number, canManage: boolean, reason?: unknown,
): Promise<void> {
    const { data } = await supabase.from('academy_enrollment_requests')
        .select('id, session_id, student_id, status').eq('id', requestId).maybeSingle();
    const req = data as { id: string; session_id: string; student_id: number; status: string } | null;
    if (!req) throw new SecurityDenial('Request not found.', { auditEvent: 'authz.resource.denied', fields: { requestId } });
    await assertCanRunSession(req.session_id, actorUserId, canManage);
    if (req.status !== 'pending') throw new Error('This request has already been decided.');

    // CAS on the pending status: two approvers clicking at once must not both claim a
    // seat and both notify. The loser gets the already-decided message.
    // The payload is built FIRST so the update() call sits within a couple of lines
    // of the returning select(). The order ratchet decides whether a select is a
    // write's returning projection by looking a bounded distance BACKWARDS for an
    // insert/update/delete, so a long inline payload pushes the update out of that
    // window and the projection reads as an uncapped list read that is not one.
    const decisionPatch = {
        status: decision === 'approve' ? 'approved' : 'denied',
        decided_by: actorUserId,
        decision_reason: stripHtml(reason, 500) || null,
        decided_at: new Date().toISOString(),
    };
    const { data: claimed, error: claimErr } = await supabase.from('academy_enrollment_requests')
        .update(decisionPatch).eq('id', requestId).eq('status', 'pending').select('id');
    handleSupabaseError({ error: claimErr, message: 'Failed to record the decision' });
    if (!Array.isArray(claimed) || claimed.length === 0) throw new Error('This request has already been decided.');

    if (decision === 'approve') {
        // Through academy_claim_seat, not a bare insert: an approval is a seat like any
        // other and must obey the same capacity lock.
        const { error } = await supabase.rpc('academy_claim_seat', {
            p_session_id: req.session_id, p_student_id: req.student_id, p_source: 'assigned',
        });
        if (error) {
            const code = (error as { code?: string }).code;
            if (code === '42883' || code === 'PGRST202') {
                throw new Error('Enrolment is unavailable until the database schema is re-applied (schema.sql). Ask an administrator to run it.');
            }
            const msg = String(error.message || '');
            if (/session is full|not accepting enrolments|Session not found/i.test(msg)) throw new Error(msg.replace(/^.*?:\s*/, ''));
            handleSupabaseError({ error, message: 'Failed to enrol the requester' });
        }
    }

    const ctx = await academyCourseContext(req.session_id);
    // TWO calls, not one with a ternary payload. Beyond being clearer, the
    // notification parity ratchet finds a type by looking a bounded distance after a
    // send call — a branch buried inside one payload is invisible to it, and a type
    // nothing can be seen to write is exactly what that ratchet exists to catch.
    if (decision === 'approve') {
        await pushAcademyNotifications([req.student_id], {
            type: 'academy_enrolled',
            title: 'Enrolment request approved',
            body: ctx ? `You're enrolled in ${ctx.courseTitle}.` : 'Your enrolment request was approved.',
            metadata: { sessionId: req.session_id, ...(ctx ? { courseId: ctx.courseId } : {}) },
        });
    } else {
        await pushAcademyNotifications([req.student_id], {
            type: 'academy_enrollment_denied',
            title: 'Enrolment request declined',
            body: 'Your request to join a course session was declined.',
            metadata: { sessionId: req.session_id },
        });
    }
    notify({ sessionId: req.session_id });
}

/** Pending requests for one session. Staff-only — the caller proves session authority. */
export async function listEnrollmentRequests(sessionId: string, actorUserId: number, canManage: boolean): Promise<AcademyEnrollmentRequest[]> {
    await assertCanRunSession(sessionId, actorUserId, canManage);
    const { data, error } = await supabase.from('academy_enrollment_requests')
        .select(REQUEST_COLS).eq('session_id', sessionId).eq('status', 'pending')
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .limit(MAX_LIST);
    if (error && ((error as { code?: string }).code === '42P01' || (error as { code?: string }).code === 'PGRST205')) return [];
    handleSupabaseError({ error, message: 'Failed to load enrolment requests' });
    return ((data || []) as unknown as RequestRow[]).map(toRequest);
}

/** The caller's own requests. Self-scoped: studentId is dispatcher-forced. */
export async function listMyEnrollmentRequests(studentId: number): Promise<AcademyEnrollmentRequest[]> {
    const { data, error } = await supabase.from('academy_enrollment_requests')
        .select(REQUEST_COLS).eq('student_id', studentId)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(MAX_LIST);
    if (error && ((error as { code?: string }).code === '42P01' || (error as { code?: string }).code === 'PGRST205')) return [];
    handleSupabaseError({ error, message: 'Failed to load your enrolment requests' });
    return ((data || []) as unknown as RequestRow[]).map(toRequest);
}

// ── Lesson progress (self-paced; student-markable, instructor-overridable) ────
export async function markLesson(enrollmentId: string, lessonId: number, completed: boolean, actorUserId: number, canManage: boolean): Promise<void> {
    const enr = await loadEnrollment(enrollmentId);
    const { courseId } = await lessonCourse(lessonId);
    // The lesson must belong to the enrolment's session's course.
    const session = await loadSession(enr.sessionId);
    if (session.courseId !== courseId) throw new SecurityDenial('Lesson does not belong to this enrolment.', { auditEvent: 'authz.resource.denied', fields: { enrollmentId, lessonId } });
    const isSelf = enr.studentId === actorUserId;
    if (!isSelf && !canManage && !(await isSessionInstructor(enr.sessionId, actorUserId)) && !(await isCourseInstructor(courseId, actorUserId))) {
        throw new SecurityDenial('Not authorised to mark this lesson.', { auditEvent: 'authz.permission_denied', fields: { enrollmentId, lessonId } });
    }
    if (completed) {
        const { error } = await supabase.from('academy_lesson_progress').insert({ enrollment_id: enrollmentId, lesson_id: lessonId, completed_by: actorUserId });
        if (error && error.code !== '23505') handleSupabaseError({ error, message: 'Failed to mark lesson' });
        if (enr.status === 'enrolled') await supabase.from('academy_enrollments').update({ status: 'in_progress' }).eq('id', enrollmentId);
    } else {
        const { error } = await supabase.from('academy_lesson_progress').delete().eq('enrollment_id', enrollmentId).eq('lesson_id', lessonId);
        handleSupabaseError({ error, message: 'Failed to unmark lesson' });
    }
    notify({ sessionId: enr.sessionId });
}

// ── Competency assessment (instructor-only; students can never write these) ───
export async function assessOutcome(enrollmentId: string, outcomeId: number, verdict: AcademyOutcomeVerdict, actorUserId: number, canManage: boolean): Promise<void> {
    if (verdict !== 'competent' && verdict !== 'not_yet_competent') throw new Error('Invalid verdict.');
    const [enr, courseId] = await Promise.all([loadEnrollment(enrollmentId), outcomeCourse(outcomeId)]);
    const session = await loadSession(enr.sessionId);
    if (session.courseId !== courseId) throw new SecurityDenial('Outcome does not belong to this enrolment.', { auditEvent: 'authz.resource.denied', fields: { enrollmentId, outcomeId } });
    if (!canManage && !(await isSessionInstructor(enr.sessionId, actorUserId)) && !(await isCourseInstructor(courseId, actorUserId))) {
        throw new SecurityDenial('Only an instructor can assess competency.', { auditEvent: 'authz.permission_denied', fields: { enrollmentId, outcomeId } });
    }
    // Single upsert on the (enrolment, outcome) unique key.
    const { error } = await supabase.from('academy_outcome_results').upsert(
        { enrollment_id: enrollmentId, outcome_id: outcomeId, verdict, assessed_by: actorUserId, assessed_at: new Date().toISOString() },
        { onConflict: 'enrollment_id,outcome_id' },
    );
    handleSupabaseError({ error, message: 'Failed to assess outcome' });
    notify({ sessionId: enr.sessionId });
}

/** Instructor recommends a student for certification (all required outcomes competent). */
export async function recommendForCertification(enrollmentId: string, actorUserId: number, canManage: boolean): Promise<void> {
    const enr = await loadEnrollment(enrollmentId);
    const session = await loadSession(enr.sessionId);
    if (!canManage && !(await isSessionInstructor(enr.sessionId, actorUserId)) && !(await isCourseInstructor(session.courseId, actorUserId))) {
        throw new SecurityDenial('Only an instructor can recommend for certification.', { auditEvent: 'authz.permission_denied', fields: { enrollmentId } });
    }
    if (!(await allRequiredOutcomesCompetent(enrollmentId, session.courseId))) throw new Error('All required outcomes must be assessed competent before recommending.');
    const { error } = await supabase.from('academy_enrollments').update({ recommended_by: actorUserId, recommended_at: new Date().toISOString() }).eq('id', enrollmentId);
    handleSupabaseError({ error, message: 'Failed to recommend for certification' });
    notify({ sessionId: enr.sessionId });
    // Notify the learning managers who can action the recommendation (certify queue).
    const [ctx, managers, refs] = await Promise.all([
        academyCourseContext(enr.sessionId),
        usersWithPermission('academy:manage'),
        fetchUserRefs([enr.studentId]),
    ]);
    if (ctx && managers.length) {
        const studentName = refs.get(enr.studentId)?.name || 'A student';
        await pushAcademyNotifications(managers, { type: 'academy_recommended', title: 'Ready for certification', body: `${studentName} has been recommended for certification in ${ctx.courseTitle}.`, metadata: { courseId: ctx.courseId, sessionId: enr.sessionId, enrollmentId, studentId: enr.studentId } });
    }
}

async function allRequiredOutcomesCompetent(enrollmentId: string, courseId: string): Promise<boolean> {
    const { data: outcomes } = await supabase.from('academy_outcomes').select('id, required').eq('course_id', courseId);
    const required = (outcomes || []).filter(o => o.required !== false).map(o => o.id);
    if (required.length === 0) return true;
    const { data: results } = await supabase.from('academy_outcome_results').select('outcome_id, verdict').eq('enrollment_id', enrollmentId);
    const competent = new Set((results || []).filter(r => r.verdict === 'competent').map(r => r.outcome_id));
    return required.every(id => competent.has(id));
}

/**
 * Learning Admin (academy:manage) certifies + completes an enrolment. If the
 * course awards a certification, this ADDITIONALLY requires cert-award authority
 * (canAward = admin:award:certification) and grants the cert idempotently.
 */
export async function certifyAndComplete(enrollmentId: string, adminId: number, canAward: boolean): Promise<void> {
    const enr = await loadEnrollment(enrollmentId);
    const session = await loadSession(enr.sessionId);
    const course = await loadCourse(session.courseId);
    if (enr.status === 'withdrawn') throw new Error('Cannot certify a withdrawn enrolment.');
    // Certifying an already-completed enrolment is a no-op (button-spam safe; the
    // user_certifications composite PK is the belt-and-braces DB guard, and
    // awardCertification upserts ON CONFLICT DO NOTHING).
    if (enr.status === 'completed') { notify({ sessionId: enr.sessionId }); return; }
    if (!(await allRequiredOutcomesCompetent(enrollmentId, session.courseId))) throw new Error('All required outcomes must be competent before certifying.');

    // OWNER DECISION D12 — do not leave this hole open by omission. A LEGACY Client
    // enrolment (created before the assignStudents guard above, or arriving through an org
    // import) is otherwise still certifiable, and certifying it (a) awards a real org
    // certification to an external customer and (b) pushes the course TITLE plus certId to
    // them through pushAcademyNotifications below — the self-scoped `notifications` subset
    // a Client DOES receive, whose rows hard-code link: 'academy' and which
    // components/layout/HeaderNotificationsBell.tsx navigates on verbatim. That is exactly
    // the content the assignStudents guard is justified by, so leaving it reachable would
    // make the two guards contradict each other. An instructor removes the enrolment
    // through the existing non-self withdrawEnrollment path instead.
    //
    // Runs AFTER the withdrawn / already-completed early returns so a no-op certify pays
    // no extra query, and BEFORE the cert-award privilege gate so the tier boundary is the
    // highest-precedence refusal here, matching the dispatcher's and the read path's
    // ordering. Fail CLOSED on an unresolvable Client slot, same instrument as
    // assertRoleIsNotClient. academy_enrollments.student_id is NOT NULL REFERENCES
    // users(id) ON DELETE CASCADE, so a live enrolment always has a row; deleted_at is
    // deliberately NOT filtered — the question is "is this a customer?", not "is this
    // account live".
    const certifyClientRoleId = await requireClientRoleId();
    // BOTH legs fail closed, and the row read is the leg that is easy to get wrong.
    // Discarding `error` here and testing `studentRow?.role_id === certifyClientRoleId`
    // reads a transient DB fault as "not a customer" and lets the certification through —
    // the exact inversion of what this guard is for. handleSupabaseError turns the fault
    // into a throw, and the explicit null check covers a row that resolved to nothing.
    // assignStudents above gets this for free (an empty result set makes every id
    // invalid); this path is single-row, so it has to say it.
    const { data: studentRow, error: studentErr } = await supabase.from('users').select('id, role_id').eq('id', enr.studentId).maybeSingle();
    handleSupabaseError({ error: studentErr, message: 'Failed to resolve student tier' });
    if (!studentRow) {
        throw new SecurityDenial('Could not resolve the student on this enrolment.', { auditEvent: 'authz.invalid_target', fields: { enrollmentId, userId: enr.studentId } });
    }
    if (studentRow.role_id === certifyClientRoleId) {
        throw new SecurityDenial('Client accounts cannot be certified. Withdraw the enrolment instead.', { auditEvent: 'authz.invalid_target', fields: { enrollmentId, userId: enr.studentId } });
    }

    // Privilege gate: awarding a real certification needs cert-award authority.
    if (course.certificationId != null && !canAward) {
        throw new SecurityDenial('Awarding this course’s certification requires the Award Certification permission.', { auditEvent: 'authz.escalation.denied', fields: { enrollmentId, certId: course.certificationId } });
    }

    const { error } = await supabase.from('academy_enrollments').update({ status: 'completed', certified_by: adminId, completed_at: new Date().toISOString() }).eq('id', enrollmentId);
    handleSupabaseError({ error, message: 'Failed to complete enrolment' });

    let certName: string | null = null;
    if (course.certificationId != null) {
        const { data: held } = await supabase.from('user_certifications').select('user_id').eq('user_id', enr.studentId).eq('certification_id', course.certificationId).maybeSingle();
        if (!held) {
            await awardCertification(enr.studentId, course.certificationId, adminId); // idempotent upsert, re-hydrates recipient
            log.info('academy certification awarded', { studentId: enr.studentId, certId: course.certificationId, awardedBy: adminId, enrollmentId });
        }
        const { data: certRow } = await supabase.from('certifications').select('name').eq('id', course.certificationId).maybeSingle();
        certName = certRow?.name ?? null;
    }
    notify({ sessionId: enr.sessionId });
    // Notify the student of completion (and the certification they earned, if any).
    const ctx = await academyCourseContext(enr.sessionId);
    const courseTitle = ctx?.courseTitle || 'your course';
    const body = certName ? `You've completed ${courseTitle} and earned the ${certName} certification.` : `You've completed ${courseTitle}.`;
    await pushAcademyNotifications([enr.studentId], { type: 'academy_completed', title: 'Course completed', body, metadata: { courseId: course.id, sessionId: enr.sessionId, enrollmentId, certId: course.certificationId ?? null } });
}

// ════════════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════════════

async function attachCourseInstructors(courses: AcademyCourse[]): Promise<void> {
    if (courses.length === 0) return;
    const { data } = await supabase.from('academy_course_instructors').select('course_id, user_id').in('course_id', courses.map(c => c.id)).order('id', { ascending: true }).limit(MAX_AGG);
    const rows = data || [];
    const refs = await fetchUserRefs(rows.map(r => r.user_id));
    const byCourse = new Map<string, AcademyUserRef[]>();
    for (const r of rows) {
        const ref = refs.get(r.user_id);
        if (!ref) continue;
        const arr = byCourse.get(r.course_id) || [];
        arr.push(ref);
        byCourse.set(r.course_id, arr);
    }
    for (const c of courses) c.instructors = byCourse.get(c.id) || [];
}

/** Staff management bundle: all courses (+ instructors) and all sessions (+ context). */
export async function getAcademyStaffState(): Promise<{ academyCourses: AcademyCourse[]; academySessions: AcademySession[] }> {
    const { data: courseRows, error: cErr } = await supabase.from('academy_courses').select(COURSE_COLS)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MAX_LIST);
    if (cErr && cErr.code === '42P01') return { academyCourses: [], academySessions: [] };
    handleSupabaseError({ error: cErr, message: 'Failed to load courses' });
    const courses = (courseRows || []).map(toAcademyCourse);
    await attachCourseInstructors(courses);

    const { data: sessionRows, error: sErr } = await supabase.from('academy_sessions').select(SESSION_COLS)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MAX_LIST);
    if (sErr && sErr.code === '42P01') return { academyCourses: courses, academySessions: [] };
    handleSupabaseError({ error: sErr, message: 'Failed to load sessions' });
    const sessions = (sessionRows || []).map(toAcademySession);
    const courseTitle = new Map(courses.map(c => [c.id, c.title]));
    for (const s of sessions) s.courseTitle = courseTitle.get(s.courseId) ?? null;
    // Enrolment counts per session (single grouped-ish pass).
    if (sessions.length > 0) {
        const { data: enr } = await supabase.from('academy_enrollments').select('session_id, status').in('session_id', sessions.map(s => s.id)).order('id', { ascending: true }).limit(MAX_AGG);
        const counts = new Map<string, number>();
        for (const e of enr || []) { if (e.status !== 'withdrawn') counts.set(e.session_id, (counts.get(e.session_id) || 0) + 1); }
        for (const s of sessions) s.enrollmentCount = counts.get(s.id) || 0;
    }
    return { academyCourses: courses, academySessions: sessions };
}

/** Certify queue: enrolments recommended for certification but not yet completed,
 *  newest recommendation last. Gated academy:manage. */
export async function listRecommendedEnrollments(): Promise<AcademyEnrollment[]> {
    const { data: enrRows, error } = await supabase.from('academy_enrollments').select(ENROLLMENT_COLS)
        .not('recommended_at', 'is', null)
        .in('status', ['enrolled', 'in_progress'])
        .order('recommended_at', { ascending: true }).order('id', { ascending: true })
        .limit(MAX_LIST);
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load certify queue' });
    const enrollments = (enrRows || []).map(toAcademyEnrollment);
    if (enrollments.length === 0) return [];
    await attachEnrollmentContext(enrollments);
    const studentRefs = await fetchUserRefs(enrollments.map(e => e.studentId));
    for (const e of enrollments) e.student = studentRefs.get(e.studentId) ?? null;
    return enrollments;
}

// ════════════════════════════════════════════════════════════════════════════
// LEARNING-MANAGER REPORTS  (every one gated academy:manage)
// ════════════════════════════════════════════════════════════════════════════
// These read back the sign-off trail the rest of the module writes and nothing has
// ever displayed: completed_at, certified_by, recommended_at. Each returns a NAMED
// projection built field-by-field — no row is passed through, and nothing beyond the
// roster-safe identity fields (name, avatar, RSI handle) crosses the wire.

/**
 * Every member holding a given certification, newest award first.
 *
 * The permission entry ('academy:report_cert_holders' → 'academy:manage') is the
 * authorization. The lookup below is an EXISTENCE check whose job is to give a bad
 * certificationId the same shape of answer as a deleted one — it is not, and must
 * not be described as, the access control.
 */
export async function reportCertificationHolders(certificationId: number): Promise<AcademyCertHoldersReport> {
    if (!Number.isInteger(certificationId) || certificationId <= 0) {
        throw new Error('reportCertificationHolders: certificationId is required');
    }
    const { data: cert, error: cErr } = await supabase.from('certifications')
        .select('id, name, icon, image_url').eq('id', certificationId).maybeSingle();
    if (cErr && cErr.code === '42P01') return { certification: { id: certificationId, name: '', icon: null, imageUrl: null }, holders: [] };
    handleSupabaseError({ error: cErr, message: 'Failed to load certification' });
    if (!cert) throw new SecurityDenial('Certification not found.', { auditEvent: 'authz.resource.denied', fields: { certificationId } });
    const certification = { id: cert.id, name: cert.name, icon: cert.icon ?? null, imageUrl: cert.image_url ?? null };

    // user_certifications has NO id column — its PK is (user_id, certification_id).
    // certification_id is pinned by the .eq above, so user_id is the half that
    // completes the key and is a genuine tiebreak here.
    const { data: rows, error } = await supabase.from('user_certifications')
        .select('user_id, awarded_at, awarded_by')
        .eq('certification_id', certificationId)
        .order('awarded_at', { ascending: false }).order('user_id', { ascending: true })
        .limit(MAX_AGG);
    if (error && error.code === '42P01') return { certification, holders: [] };
    handleSupabaseError({ error, message: 'Failed to load certification holders' });
    const list = (rows || []) as Array<{ user_id: number; awarded_at: string | null; awarded_by: number | null }>;
    if (list.length === 0) return { certification, holders: [] };

    const refs = await fetchUserRefs([...list.map(r => r.user_id), ...list.map(r => r.awarded_by)]);
    const holders: AcademyCertHolder[] = list.map(r => {
        const who = refs.get(r.user_id);
        const by = r.awarded_by != null ? refs.get(r.awarded_by) : undefined;
        return {
            userId: r.user_id,
            name: who?.name ?? '',
            avatarUrl: who?.avatarUrl ?? '',
            rsiHandle: who?.rsiHandle ?? '',
            awardedAt: r.awarded_at ?? null,
            awardedByName: by?.name ?? null,
        };
    });
    return { certification, holders };
}

/** Everyone who completed a course in a recent window. Caller-supplied paging is
 *  CLAMPED server-side with a hard default — the client asks, it does not decide. */
export async function reportCompletions(opts?: { sinceDays?: unknown; limit?: unknown }): Promise<AcademyCompletionRow[]> {
    const rawDays = Number(opts?.sinceDays);
    const rawLimit = Number(opts?.limit);
    const sinceDays = Math.min(Math.max(Math.floor(Number.isFinite(rawDays) ? rawDays : 90), 1), 730);
    const limit = Math.min(Math.max(Math.floor(Number.isFinite(rawLimit) ? rawLimit : 200), 1), MAX_LIST);
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

    const { data, error } = await supabase.from('academy_enrollments').select(ENROLLMENT_COLS)
        .eq('status', 'completed')
        .not('completed_at', 'is', null).gte('completed_at', since)
        .order('completed_at', { ascending: false }).order('id', { ascending: false })
        .limit(limit);
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load completions' });
    const enrollments = (data || []).map(toAcademyEnrollment);
    if (enrollments.length === 0) return [];

    await attachEnrollmentContext(enrollments);
    const refs = await fetchUserRefs([
        ...enrollments.map(e => e.studentId),
        ...enrollments.map(e => e.certifiedBy),
    ]);
    return enrollments.map(e => ({
        enrollmentId: e.id,
        studentId: e.studentId,
        studentName: refs.get(e.studentId)?.name ?? '',
        rsiHandle: refs.get(e.studentId)?.rsiHandle ?? '',
        courseTitle: e.courseTitle ?? '',
        sessionTitle: e.sessionTitle ?? '',
        completedAt: e.completedAt,
        certifiedByName: e.certifiedBy != null ? (refs.get(e.certifiedBy)?.name ?? null) : null,
    }));
}

/** Per-course rollup: which courses are actually being used, and which are stuck at
 *  sign-off. ONE capped fact scan aggregated in JS, not N per-course counts. */
export async function reportCourseActivity(): Promise<AcademyCourseActivityReport> {
    const { data: courseRows, error: cErr } = await supabase.from('academy_courses')
        .select('id, title, status, delivery')
        .order('title', { ascending: true }).order('id', { ascending: true }).limit(MAX_LIST);
    if (cErr && cErr.code === '42P01') return { courses: [], totalEnrollments: 0, truncated: false };
    handleSupabaseError({ error: cErr, message: 'Failed to load course activity' });
    const courses = (courseRows || []) as Array<{ id: string; title: string; status: string; delivery: string | null }>;
    if (courses.length === 0) return { courses: [], totalEnrollments: 0, truncated: false };

    const { data: sessionRows } = await supabase.from('academy_sessions')
        .select('id, course_id, is_implicit').order('id', { ascending: true }).limit(MAX_AGG);
    const sessions = (sessionRows || []) as Array<{ id: string; course_id: string; is_implicit: boolean | null }>;
    const courseOfSession = new Map(sessions.map(s => [s.id, s.course_id]));

    // Minimal projection: only the three columns actually aggregated.
    const { data: enrRows } = await supabase.from('academy_enrollments')
        .select('session_id, status, recommended_at').order('id', { ascending: true }).limit(MAX_AGG);
    const enrolments = (enrRows || []) as Array<{ session_id: string; status: string; recommended_at: string | null }>;
    // A truncated scan makes every number below a FLOOR, not a total. Say so rather
    // than presenting a capped count as the answer.
    const truncated = enrolments.length >= MAX_AGG;

    const blank = () => ({ sessions: 0, enrolled: 0, inProgress: 0, completed: 0, awaitingCertification: 0 });
    const acc = new Map(courses.map(c => [c.id, blank()]));
    for (const s of sessions) {
        if (s.is_implicit) continue; // an implicit self-paced pool is not a scheduled session
        const a = acc.get(s.course_id);
        if (a) a.sessions += 1;
    }
    for (const e of enrolments) {
        const courseId = courseOfSession.get(e.session_id);
        const a = courseId ? acc.get(courseId) : undefined;
        if (!a) continue;
        if (e.status === 'enrolled') a.enrolled += 1;
        else if (e.status === 'in_progress') a.inProgress += 1;
        else if (e.status === 'completed') a.completed += 1;
        // The SAME predicate as listRecommendedEnrollments, so this number reconciles
        // with the sign-off queue rather than quietly disagreeing with it.
        if (e.recommended_at && (e.status === 'enrolled' || e.status === 'in_progress')) a.awaitingCertification += 1;
    }

    return {
        courses: courses.map(c => ({
            courseId: c.id,
            courseTitle: c.title,
            status: c.status as AcademyCourseStatus,
            delivery: (c.delivery as AcademyCourseDelivery) || 'cohort',
            ...(acc.get(c.id) ?? blank()),
        })),
        totalEnrollments: enrolments.length,
        truncated,
    };
}

/** One member's full training record. The ONLY report taking a client-supplied target
 *  identity — targetUserId is NOT an ACTOR_ID_FIELD, so it arrives as the caller sent
 *  it and is proved to be a real, live member before a single row is read. */
export async function reportMemberTranscript(targetUserId: number): Promise<AcademyTranscript> {
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error('reportMemberTranscript: targetUserId is required');
    }
    await assertUserExists(targetUserId, 'Member');

    const refs = await fetchUserRefs([targetUserId]);
    const member = refs.get(targetUserId) ?? { id: targetUserId, name: '', avatarUrl: '', rsiHandle: '' };

    const { data: enrRows, error } = await supabase.from('academy_enrollments').select(ENROLLMENT_COLS)
        .eq('student_id', targetUserId)
        .order('enrolled_at', { ascending: false }).order('id', { ascending: false })
        .limit(MAX_LIST);
    if (error && error.code === '42P01') return { member, rows: [], certifications: [] };
    handleSupabaseError({ error, message: 'Failed to load transcript' });
    const enrollments = (enrRows || []).map(toAcademyEnrollment);
    await attachEnrollmentContext(enrollments);

    const rows: AcademyTranscriptRow[] = [];
    if (enrollments.length > 0) {
        const enrIds = enrollments.map(e => e.id);
        const courseIds = [...new Set(enrollments.map(e => e.courseId).filter((c): c is string => !!c))];
        const [{ data: results }, { data: outcomes }] = await Promise.all([
            supabase.from('academy_outcome_results').select('enrollment_id, outcome_id, verdict').in('enrollment_id', enrIds).order('id', { ascending: true }).limit(MAX_AGG),
            courseIds.length
                ? supabase.from('academy_outcomes').select('id, course_id, title').in('course_id', courseIds).order('sort_order', { ascending: true }).order('id', { ascending: true }).limit(MAX_AGG)
                : Promise.resolve({ data: [] as Array<{ id: number; course_id: string; title: string }> }),
        ]);
        const verdictOf = new Map<string, AcademyOutcomeVerdict>();
        for (const r of (results || []) as Array<{ enrollment_id: string; outcome_id: number; verdict: string }>) {
            verdictOf.set(`${r.enrollment_id}:${r.outcome_id}`, r.verdict as AcademyOutcomeVerdict);
        }
        const outcomesByCourse = new Map<string, Array<{ id: number; title: string }>>();
        for (const o of (outcomes || []) as Array<{ id: number; course_id: string; title: string }>) {
            const arr = outcomesByCourse.get(o.course_id) || [];
            arr.push({ id: o.id, title: o.title });
            outcomesByCourse.set(o.course_id, arr);
        }
        for (const e of enrollments) {
            rows.push({
                enrollmentId: e.id,
                courseTitle: e.courseTitle ?? '',
                sessionTitle: e.sessionTitle ?? '',
                status: e.status,
                enrolledAt: e.enrolledAt,
                completedAt: e.completedAt,
                lessonsCompleted: e.lessonsCompleted ?? 0,
                lessonsTotal: e.lessonsTotal ?? 0,
                outcomes: (e.courseId ? outcomesByCourse.get(e.courseId) ?? [] : []).map(o => ({
                    title: o.title,
                    verdict: verdictOf.get(`${e.id}:${o.id}`) ?? null,
                })),
            });
        }
    }

    const { data: certDefs } = await supabase.from('certifications').select('id, name').order('id', { ascending: true }).limit(MAX_LIST);
    const defs = new Map(((certDefs || []) as Array<{ id: number; name: string }>).map(c => [c.id, c.name]));
    let certifications: AcademyTranscript['certifications'] = [];
    if (defs.size > 0) {
        // Mirror of the holders read, other half of the composite PK: user_id is
        // pinned by the .eq, so certification_id is what completes the key.
        const { data: held } = await supabase.from('user_certifications')
            .select('certification_id, awarded_at').eq('user_id', targetUserId)
            .in('certification_id', [...defs.keys()])
            .order('awarded_at', { ascending: false }).order('certification_id', { ascending: true })
            .limit(MAX_LIST);
        certifications = ((held || []) as Array<{ certification_id: number; awarded_at: string | null }>)
            .map(h => ({ id: h.certification_id, name: defs.get(h.certification_id) ?? '', awardedAt: h.awarded_at ?? null }));
    }

    return { member, rows, certifications };
}

/** Student self-service bundle: published catalog + my enrolments. */
export async function getMyAcademyState(userId: number): Promise<{ academyCatalog: AcademyCourse[]; academyMyEnrollments: AcademyEnrollment[] }> {
    const { data: courseRows, error: cErr } = await supabase.from('academy_courses').select(COURSE_COLS)
        .eq('status', 'published').order('title', { ascending: true }).order('id', { ascending: true }).limit(MAX_LIST);
    if (cErr && cErr.code === '42P01') return { academyCatalog: [], academyMyEnrollments: [] };
    handleSupabaseError({ error: cErr, message: 'Failed to load catalog' });
    const catalog = (courseRows || []).map(toAcademyCourse);

    const { data: enrRows, error: eErr } = await supabase.from('academy_enrollments').select(ENROLLMENT_COLS)
        .eq('student_id', userId).order('enrolled_at', { ascending: false }).order('id', { ascending: false }).limit(MAX_LIST);
    if (eErr && eErr.code === '42P01') return { academyCatalog: catalog, academyMyEnrollments: [] };
    handleSupabaseError({ error: eErr, message: 'Failed to load enrolments' });
    const enrollments = (enrRows || []).map(toAcademyEnrollment);
    await attachEnrollmentContext(enrollments);
    return { academyCatalog: catalog, academyMyEnrollments: enrollments };
}

async function attachEnrollmentContext(enrollments: AcademyEnrollment[]): Promise<void> {
    if (enrollments.length === 0) return;
    const sessionIds = [...new Set(enrollments.map(e => e.sessionId))];
    const enrollmentIds = enrollments.map(e => e.id);
    const completedByEnrollment = new Map<string, number>();
    // Phase 1: the session lookup and per-enrolment progress counts are independent.
    const [{ data: sessions }] = await Promise.all([
        supabase.from('academy_sessions').select('id, title, course_id').in('id', sessionIds).limit(MAX_AGG),
        (async () => {
            const { data: prog } = await supabase.from('academy_lesson_progress').select('enrollment_id').in('enrollment_id', enrollmentIds).order('id', { ascending: true }).limit(MAX_AGG);
            for (const p of prog || []) completedByEnrollment.set(p.enrollment_id, (completedByEnrollment.get(p.enrollment_id) || 0) + 1);
        })(),
    ]);
    const sessionMap = new Map((sessions || []).map(s => [s.id, s]));
    const courseIds = [...new Set((sessions || []).map(s => s.course_id))];
    const courseTitle = new Map<string, string>();
    const lessonTotalByCourse = new Map<string, number>();
    // Phase 2: course titles and per-course lesson totals both depend on courseIds — run concurrently.
    if (courseIds.length > 0) {
        await Promise.all([
            (async () => {
                const { data: courses } = await supabase.from('academy_courses').select('id, title').in('id', courseIds).order('id', { ascending: true }).limit(MAX_AGG);
                for (const c of courses || []) courseTitle.set(c.id, c.title);
            })(),
            (async () => {
                const { data: mods } = await supabase.from('academy_modules').select('id, course_id').in('course_id', courseIds).order('id', { ascending: true }).limit(MAX_AGG);
                const moduleCourseMap = new Map((mods || []).map(m => [m.id, m.course_id]));
                const moduleIds = (mods || []).map(m => m.id);
                if (moduleIds.length > 0) {
                    const { data: lessons } = await supabase.from('academy_lessons').select('module_id').in('module_id', moduleIds).order('id', { ascending: true }).limit(MAX_AGG);
                    for (const l of lessons || []) {
                        const cid = moduleCourseMap.get(l.module_id);
                        if (cid) lessonTotalByCourse.set(cid, (lessonTotalByCourse.get(cid) || 0) + 1);
                    }
                }
            })(),
        ]);
    }
    for (const e of enrollments) {
        const s = sessionMap.get(e.sessionId);
        e.sessionTitle = s?.title ?? null;
        const cid = s?.course_id;
        e.courseId = cid ?? null;
        e.courseTitle = cid ? (courseTitle.get(cid) ?? null) : null;
        e.lessonsTotal = cid ? (lessonTotalByCourse.get(cid) ?? 0) : 0;
        e.lessonsCompleted = completedByEnrollment.get(e.id) ?? 0;
    }
}

/** Full course tree for the builder / catalog detail. Gated academy:view (staff). */
export async function getCourseDetail(courseId: string): Promise<AcademyCourse> {
    const { data, error } = await supabase.from('academy_courses').select(COURSE_COLS).eq('id', courseId).maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to load course' });
    if (!data) throw new SecurityDenial('This course is not available.', { auditEvent: 'authz.resource.denied', fields: { courseId } });
    const course = toAcademyCourse(data);
    // Instructors, cert ref, module/lesson tree, and outcomes are independent — run concurrently.
    await Promise.all([
        attachCourseInstructors([course]),
        (async () => {
            if (course.certificationId == null) return;
            const { data: cert } = await supabase.from('certifications').select(CERT_REF_COLS).eq('id', course.certificationId).maybeSingle();
            if (cert) course.certification = { id: cert.id, name: cert.name, icon: cert.icon ?? null, imageUrl: cert.image_url ?? null };
        })(),
        (async () => {
            const { data: modRows } = await supabase.from('academy_modules').select(MODULE_COLS).eq('course_id', courseId).order('sort_order', { ascending: true }).order('id', { ascending: true }).limit(MAX_LIST);
            const modules = (modRows || []).map(toAcademyModule);
            if (modules.length > 0) {
                const { data: lessonRows } = await supabase.from('academy_lessons').select(LESSON_COLS).in('module_id', modules.map(m => m.id)).order('sort_order', { ascending: true }).order('id', { ascending: true }).limit(MAX_AGG);
                const byModule = new Map<number, ReturnType<typeof toAcademyLesson>[]>();
                for (const l of (lessonRows || []).map(toAcademyLesson)) { const arr = byModule.get(l.moduleId) || []; arr.push(l); byModule.set(l.moduleId, arr); }
                for (const m of modules) m.lessons = byModule.get(m.id) || [];
            }
            course.modules = modules;
        })(),
        (async () => {
            const { data: outRows } = await supabase.from('academy_outcomes').select(OUTCOME_COLS).eq('course_id', courseId).order('sort_order', { ascending: true }).order('id', { ascending: true }).limit(MAX_LIST);
            course.outcomes = (outRows || []).map(toAcademyOutcome);
        })(),
    ]);
    return course;
}

/** Session + roster (enrolments with student refs) + instructors. Gated academy:view. */
export async function getSessionDetail(sessionId: string): Promise<{ session: AcademySession; enrollments: AcademyEnrollment[] }> {
    const { data, error } = await supabase.from('academy_sessions').select(SESSION_COLS).eq('id', sessionId).maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to load session' });
    if (!data) throw new SecurityDenial('This session is not available.', { auditEvent: 'authz.resource.denied', fields: { sessionId } });
    const session = toAcademySession(data);
    // Instructors and roster are independent — hydrate concurrently.
    const [, enrollments] = await Promise.all([
        (async () => {
            const { data: instr } = await supabase.from('academy_session_instructors').select('user_id').eq('session_id', sessionId).order('id', { ascending: true }).limit(MAX_LIST);
            const instrRefs = await fetchUserRefs((instr || []).map(i => i.user_id));
            session.instructors = (instr || []).map(i => instrRefs.get(i.user_id)).filter((r): r is AcademyUserRef => !!r);
        })(),
        (async (): Promise<AcademyEnrollment[]> => {
            const { data: enrRows } = await supabase.from('academy_enrollments').select(ENROLLMENT_COLS).eq('session_id', sessionId).order('enrolled_at', { ascending: true }).order('id', { ascending: true }).limit(MAX_LIST);
            const rows = (enrRows || []).map(toAcademyEnrollment);
            const studentRefs = await fetchUserRefs(rows.map(e => e.studentId));
            for (const e of rows) e.student = studentRefs.get(e.studentId) ?? null;
            return rows;
        })(),
    ]);
    session.enrollmentCount = enrollments.filter(e => e.status !== 'withdrawn').length;
    return { session, enrollments };
}

/** Full enrolment detail (progress + results) for the student (self) or staff. */
export async function getEnrollmentDetail(enrollmentId: string, actorUserId: number, canView: boolean): Promise<{ enrollment: AcademyEnrollment; course: AcademyCourse }> {
    const { data, error } = await supabase.from('academy_enrollments').select(ENROLLMENT_COLS).eq('id', enrollmentId).maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to load enrolment' });
    if (!data) throw new SecurityDenial('This enrolment is not available.', { auditEvent: 'authz.resource.denied', fields: { enrollmentId } });
    const enrollment = toAcademyEnrollment(data);
    // Authorisation: the student themselves, or any academy:view holder (staff).
    if (enrollment.studentId !== actorUserId && !canView) {
        throw new SecurityDenial('Not authorised to view this enrolment.', { auditEvent: 'authz.permission_denied', fields: { enrollmentId } });
    }
    // Progress, results, student ref, and the course tree are all independent.
    const [, , , course] = await Promise.all([
        (async () => {
            const { data: prog } = await supabase.from('academy_lesson_progress').select(LESSON_PROGRESS_COLS).eq('enrollment_id', enrollmentId);
            enrollment.lessonProgress = (prog || []).map(toAcademyLessonProgress);
        })(),
        (async () => {
            const { data: results } = await supabase.from('academy_outcome_results').select(OUTCOME_RESULT_COLS).eq('enrollment_id', enrollmentId);
            enrollment.outcomeResults = (results || []).map(toAcademyOutcomeResult);
        })(),
        (async () => {
            const studentRef = await fetchUserRefs([enrollment.studentId]);
            enrollment.student = studentRef.get(enrollment.studentId) ?? null;
        })(),
        (async (): Promise<AcademyCourse> => {
            const session = await loadSession(enrollment.sessionId);
            return getCourseDetail(session.courseId);
        })(),
    ]);
    return { enrollment, course };
}

/** Student-facing catalog detail: a published course + its open, enrollable sessions. */
export async function getCatalogCourse(courseId: string): Promise<{ course: AcademyCourse; sessions: AcademySession[] }> {
    const { data } = await supabase.from('academy_courses').select('status').eq('id', courseId).maybeSingle();
    if (!data || data.status !== 'published') throw new SecurityDenial('Course is not available.', { auditEvent: 'authz.permission_denied', fields: { courseId } });
    const course = await getCourseDetail(courseId);
    const { data: sessRows } = await supabase.from('academy_sessions').select(SESSION_COLS)
        .eq('course_id', courseId).eq('enrollment_open', true)
        .in('status', ['scheduled', 'in_progress']).order('starts_at', { ascending: true }).order('id', { ascending: true }).limit(100);
    const sessions = (sessRows || []).map(toAcademySession);
    if (sessions.length > 0) {
        const { data: enr } = await supabase.from('academy_enrollments').select('session_id, status').in('session_id', sessions.map(s => s.id)).order('id', { ascending: true }).limit(MAX_AGG);
        const counts = new Map<string, number>();
        for (const e of enr || []) { if (e.status !== 'withdrawn') counts.set(e.session_id, (counts.get(e.session_id) || 0) + 1); }
        for (const s of sessions) s.enrollmentCount = counts.get(s.id) || 0;
    }
    return { course, sessions };
}

// The Academy feature gate (default OFF) is now part of the generic optional-
// feature registry: the dispatcher gates the whole academy:* namespace via
// OPTIONAL_FEATURE_NAMESPACES (api/services.ts) and the read subsets via
// SUBSET_REQUIRED_FEATURE (api/query.ts), both resolving through
// db.isOptionalFeatureEnabled('academy'). Academy is the module that MOST needs
// this — its member self-service surface (catalog / self-enrol / My Academy) is
// permission-LESS, so a feature-OFF check must close the whole namespace server-
// side, not just hide the Sidebar nav.
