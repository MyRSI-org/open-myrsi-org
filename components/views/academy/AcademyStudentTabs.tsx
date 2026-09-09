// Academy — student-facing tabs. Two self-service views rendered by the Academy
// dashboard: the published course Catalogue (browse → view outline → enrol in an
// open session) and My Learning (my enrolments → self-paced lesson progress +
// read-only competency verdicts + withdraw). Reads/writes go through the RPC
// dispatcher (academy:* actions); state comes from useAcademy() (academy_my
// subset), refreshed after every mutation. Lesson content is stored as validated
// Tiptap JSON and rendered read-only via LessonContentView.
import React, { useCallback, useMemo, useState } from 'react';
import { CoursePlayer } from './CoursePlayer';
import { useData } from '../../../contexts/DataContext';
import { useAcademy } from '../../../contexts/AcademyContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { CourseDetailView } from './CourseDetailView';
import type { AcademyCourse, AcademySession, AcademyEnrollment, AcademyEnrollmentStatus, AcademyEnrollmentRequest } from '../../../types';

// ── Shared constants / helpers ───────────────────────────────────────────────
const OK_TOAST = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50';
const ERR_TOAST = 'bg-red-500/10 text-red-400 border-red-500/50';

type CatalogDetail = { course: AcademyCourse; sessions: AcademySession[] };
type EnrollmentDetail = { enrollment: AcademyEnrollment; course: AcademyCourse };

// Sort order + presentation for enrolment status (active states first).
const STATUS_META: Record<AcademyEnrollmentStatus, { label: string; hint: string; badge: string; order: number }> = {
    in_progress: { label: 'In Progress', hint: 'Continue learning', badge: 'bg-sky-500/10 text-sky-400 border-sky-500/30', order: 0 },
    enrolled:    { label: 'Enrolled',    hint: 'Ready to begin',    badge: 'bg-purple-500/10 text-purple-300 border-purple-500/30', order: 1 },
    completed:   { label: 'Completed',   hint: 'Course complete',   badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', order: 2 },
    withdrawn:   { label: 'Withdrawn',   hint: 'No longer enrolled', badge: 'bg-slate-600/10 text-slate-400 border-slate-600/30', order: 3 },
};

const errMsg = (err: unknown): string | undefined => (err instanceof Error ? err.message : undefined);

const EmptyState: React.FC<{ icon: string; title: string; message: string }> = ({ icon, title, message }) => (
    <div className="flex flex-col items-center justify-center text-center py-20">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/60 flex items-center justify-center text-2xl text-slate-600 mb-4">
            <i className={`fa-solid ${icon}`} aria-hidden />
        </div>
        <p className="text-sm font-semibold text-slate-300">{title}</p>
        <p className="text-xs text-slate-500 mt-1 max-w-xs">{message}</p>
    </div>
);

// ════════════════════════════════════════════════════════════════════════════
// CATALOG TAB — browse published courses → outline + open sessions → enrol
// ════════════════════════════════════════════════════════════════════════════

const CourseCard: React.FC<{ course: AcademyCourse; loading: boolean; onOpen: () => void }> = ({ course, loading, onOpen }) => (
    <button
        type="button"
        onClick={onOpen}
        disabled={loading}
        className="group text-left flex flex-col bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden hover:border-purple-500/50 hover:bg-slate-800/70 transition disabled:opacity-60"
    >
        <div className="relative h-32 w-full shrink-0 bg-gradient-to-br from-purple-900/40 via-slate-900 to-slate-950">
            {course.imageUrl
                ? <img src={course.imageUrl} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full flex items-center justify-center text-3xl text-purple-400/40"><i className={`fa-solid ${course.icon || 'fa-graduation-cap'}`} aria-hidden /></div>}
            {course.delivery === 'self_paced' && (
                <span className="absolute top-2 left-2 text-[9px] font-black uppercase tracking-widest text-emerald-200 bg-emerald-900/70 border border-emerald-500/30 rounded px-1.5 py-0.5">Self-paced</span>
            )}
            {loading && <div className="absolute inset-0 bg-slate-950/50 flex items-center justify-center"><i className="fa-solid fa-spinner animate-spin text-purple-300" aria-hidden /></div>}
        </div>
        <div className="p-4 flex-1 flex flex-col">
            <h3 className="text-sm font-bold text-white line-clamp-2">{course.title}</h3>
            {course.instructors.length > 0 && (
                <p className="text-[11px] text-slate-500 truncate mt-1">
                    <i className="fa-solid fa-chalkboard-user mr-1" aria-hidden />
                    {course.instructors.map((i) => i.name).join(', ')}
                </p>
            )}
            {course.description && <p className="text-xs text-slate-400 mt-2 line-clamp-2 flex-1">{course.description}</p>}
            <div className="mt-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-purple-400 group-hover:text-purple-300">
                View course <i className="fa-solid fa-arrow-right group-hover:translate-x-0.5 transition-transform" aria-hidden />
            </div>
        </div>
    </button>
);

// Course detail is now the full-page CourseDetailView (CourseDetailView.tsx),
// rendered in place of the catalogue grid — replaces the old stacked modal.

export const CatalogTab: React.FC = () => {
    const { rpcAction } = useData();
    const { academyCatalog, academyMyEnrollments, refreshMyAcademy } = useAcademy();
    const { addToast } = useNotification();
    const [detail, setDetail] = useState<CatalogDetail | null>(null);
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // My OWN seat requests, keyed by session. Fetched with the course detail rather
    // than at boot: it is per-viewer state that only the open course page renders, and
    // the boot payload is not the place for it (hydrate what's displayed, when it is).
    const [myRequests, setMyRequests] = useState<Map<string, AcademyEnrollmentRequest>>(() => new Map());

    // Latest row per session. listMyEnrollmentRequests returns newest-first, so the
    // FIRST row for a session is the current one — a re-ask after a denial must not be
    // masked by the denial it replaced.
    const loadMyRequests = useCallback(async () => {
        try {
            const rows = await rpcAction('academy:list_my_enrollment_requests', {}) as AcademyEnrollmentRequest[];
            const map = new Map<string, AcademyEnrollmentRequest>();
            for (const r of rows || []) if (!map.has(r.sessionId)) map.set(r.sessionId, r);
            setMyRequests(map);
        } catch {
            // A request-list fault must not blank the course page. The gated CTA falls
            // back to offering the ask, and a duplicate ask is refused server-side.
            setMyRequests(new Map());
        }
    }, [rpcAction]);

    const openCourse = useCallback(async (courseId: string) => {
        setLoadingId(courseId);
        try {
            const d = await rpcAction('academy:get_catalog_course', { courseId }) as CatalogDetail;
            setDetail(d);
            if (d?.course?.access === 'gated') await loadMyRequests();
        } catch (err) {
            addToast('Failed to Load Course', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
        } finally {
            setLoadingId(null);
        }
    }, [rpcAction, addToast, loadMyRequests]);

    const [search, setSearch] = useState('');
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return academyCatalog;
        return academyCatalog.filter(c => c.title.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
    }, [academyCatalog, search]);

    // Sessions the viewer is already enrolled in — so the detail view marks them.
    const enrolledSessionIds = useMemo(
        () => new Set(academyMyEnrollments.filter(e => e.status !== 'withdrawn').map(e => e.sessionId)),
        [academyMyEnrollments],
    );

    const enrol = useCallback(async (sessionId: string) => {
        setBusy(true);
        try {
            await rpcAction('academy:self_enroll', { sessionId });
            await refreshMyAcademy();
            addToast('Enrolled', <i className="fa-solid fa-check" />, OK_TOAST);
            // Re-fetch the open course so seat counts reflect the new enrolment
            // (guarded so a mid-flight Close doesn't re-open the modal).
            if (detail) {
                const d = await rpcAction('academy:get_catalog_course', { courseId: detail.course.id }) as CatalogDetail;
                setDetail((prev) => (prev ? d : null));
            }
        } catch (err) {
            addToast('Enrolment Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
        } finally {
            setBusy(false);
        }
    }, [rpcAction, refreshMyAcademy, addToast, detail]);

    const requestSeat = useCallback(async (sessionId: string, message: string) => {
        setBusy(true);
        try {
            await rpcAction('academy:request_enrollment', { sessionId, message: message || undefined });
            await loadMyRequests();
            addToast('Request Sent', <i className="fa-solid fa-paper-plane" />, OK_TOAST, { description: 'The instructors have been notified.' });
        } catch (err) {
            addToast('Request Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
        } finally {
            setBusy(false);
        }
    }, [rpcAction, loadMyRequests, addToast]);

    const cancelRequest = useCallback(async (requestId: string) => {
        setBusy(true);
        try {
            await rpcAction('academy:withdraw_enrollment_request', { requestId });
            await loadMyRequests();
            addToast('Request Withdrawn', <i className="fa-solid fa-check" />, OK_TOAST);
        } catch (err) {
            addToast('Withdrawal Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
        } finally {
            setBusy(false);
        }
    }, [rpcAction, loadMyRequests, addToast]);

    if (detail) {
        return <CourseDetailView detail={detail} busy={busy} enrolledSessionIds={enrolledSessionIds} myRequests={myRequests}
            onEnrol={enrol} onRequest={requestSeat} onCancelRequest={cancelRequest} onBack={() => setDetail(null)} />;
    }

    return (
        <div className="p-4 sm:p-6">
            {academyCatalog.length === 0 ? (
                <EmptyState icon="fa-graduation-cap" title="No courses available" message="Published courses will appear here once your Academy staff publish them." />
            ) : (
                <>
                    <div className="mb-4 relative max-w-sm">
                        <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs" aria-hidden />
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search courses" aria-label="Search courses" className="w-full bg-slate-800/60 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:ring-2 focus:ring-purple-500/50 outline-hidden" />
                    </div>
                    {filtered.length === 0 ? (
                        <p className="text-sm text-slate-500 italic py-10 text-center">No courses match &ldquo;{search}&rdquo;.</p>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {filtered.map((course) => (
                                <CourseCard key={course.id} course={course} loading={loadingId === course.id} onOpen={() => openCourse(course.id)} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════
// MY LEARNING TAB — my enrolments → self-paced progress + verdicts + withdraw
// ════════════════════════════════════════════════════════════════════════════

const EnrollmentRow: React.FC<{ enrollment: AcademyEnrollment; opening: boolean; onOpen: () => void }> = ({ enrollment: e, opening, onOpen }) => {
    const meta = STATUS_META[e.status];
    return (
        <button
            type="button"
            onClick={onOpen}
            disabled={opening}
            className="w-full text-left flex items-center gap-4 bg-slate-800/40 border border-slate-700/60 rounded-xl p-4 hover:border-purple-500/50 hover:bg-slate-800/70 transition disabled:opacity-60"
        >
            <div className="w-10 h-10 rounded-lg bg-purple-500/15 text-purple-300 flex items-center justify-center shrink-0">
                <i className="fa-solid fa-book-open-reader" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-white truncate">{e.courseTitle || 'Course'}</p>
                <p className="text-[11px] text-slate-500 truncate">{e.sessionTitle || 'Session'} · {meta.hint}</p>
            </div>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border shrink-0 ${meta.badge}`}>{meta.label}</span>
            {opening
                ? <i className="fa-solid fa-spinner animate-spin text-purple-400 shrink-0" aria-hidden />
                : <i className="fa-solid fa-chevron-right text-slate-600 text-xs shrink-0" aria-hidden />}
        </button>
    );
};

// The full-screen CoursePlayer (CoursePlayer.tsx) replaces the old stacked
// LearningModal as the My Learning detail surface.

export const MyLearningTab: React.FC = () => {
    const { rpcAction } = useData();
    const { academyMyEnrollments, refreshMyAcademy } = useAcademy();
    const { addToast, confirm } = useNotification();
    const [detail, setDetail] = useState<EnrollmentDetail | null>(null);
    const [openingId, setOpeningId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const sorted = useMemo(
        () => [...academyMyEnrollments].sort((a, b) => STATUS_META[a.status].order - STATUS_META[b.status].order),
        [academyMyEnrollments],
    );

    const openEnrollment = useCallback(async (enrollmentId: string) => {
        setOpeningId(enrollmentId);
        try {
            const d = await rpcAction('academy:get_enrollment', { enrollmentId }) as EnrollmentDetail;
            setDetail(d);
        } catch (err) {
            addToast('Failed to Open', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
        } finally {
            setOpeningId(null);
        }
    }, [rpcAction, addToast]);

    // Re-fetch the open enrolment (guarded so a mid-flight Close won't re-open it).
    const reloadDetail = useCallback(async (enrollmentId: string) => {
        const d = await rpcAction('academy:get_enrollment', { enrollmentId }) as EnrollmentDetail;
        setDetail((prev) => (prev ? d : null));
    }, [rpcAction]);

    const toggleLesson = useCallback(async (enrollmentId: string, lessonId: number, completed: boolean) => {
        setBusy(true);
        // Optimistic: the checkbox reads lessonProgress, so reflect the tick instantly
        // with no round-trip. The list's progress bar is refreshed once on modal close.
        setDetail((prev) => {
            if (!prev || prev.enrollment.id !== enrollmentId) return prev;
            const existing = prev.enrollment.lessonProgress;
            const lessonProgress = completed
                ? (existing.some((p) => p.lessonId === lessonId)
                    ? existing
                    : [...existing, { id: -1, enrollmentId, lessonId, completedBy: 0, completedAt: new Date().toISOString() }])
                : existing.filter((p) => p.lessonId !== lessonId);
            const status = completed && prev.enrollment.status === 'enrolled' ? 'in_progress' : prev.enrollment.status;
            return { ...prev, enrollment: { ...prev.enrollment, lessonProgress, status } };
        });
        try {
            await rpcAction('academy:mark_lesson', { enrollmentId, lessonId, completed });
        } catch (err) {
            addToast('Update Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
            await reloadDetail(enrollmentId); // reconcile with server truth on failure
        } finally {
            setBusy(false);
        }
    }, [rpcAction, reloadDetail, addToast]);

    // Refresh the My Learning list (progress bars) once when the modal closes, rather
    // than on every lesson tick — the open modal already shows live optimistic state.
    const closeDetail = useCallback(() => { setDetail(null); void refreshMyAcademy(); }, [refreshMyAcademy]);

    const withdraw = useCallback(async (enrollmentId: string) => {
        const ok = await confirm({ title: 'Withdraw from course?', message: 'You will lose your progress and your place in this session.', confirmText: 'Withdraw', variant: 'danger' });
        if (!ok) return;
        setBusy(true);
        try {
            await rpcAction('academy:withdraw_enrollment', { enrollmentId });
            await refreshMyAcademy();
            addToast('Withdrawn', <i className="fa-solid fa-check" />, OK_TOAST);
            setDetail(null);
        } catch (err) {
            addToast('Withdraw Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) });
        } finally {
            setBusy(false);
        }
    }, [rpcAction, refreshMyAcademy, addToast, confirm]);

    return (
        <div className="p-4 sm:p-6">
            {sorted.length === 0 ? (
                <EmptyState icon="fa-user-graduate" title="You're not enrolled in anything yet" message="Browse the catalogue and enrol in a session to start learning." />
            ) : (
                <div className="space-y-2">
                    {sorted.map((e) => (
                        <EnrollmentRow key={e.id} enrollment={e} opening={openingId === e.id} onOpen={() => openEnrollment(e.id)} />
                    ))}
                </div>
            )}
            {detail && <CoursePlayer detail={detail} busy={busy} onToggleLesson={toggleLesson} onWithdraw={withdraw} onClose={closeDetail} />}
        </div>
    );
};
