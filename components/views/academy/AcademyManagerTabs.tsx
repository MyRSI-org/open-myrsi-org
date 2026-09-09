// AcademyManagerTabs — Learning-Manager (academy:manage) surfaces.
//
// ApprovalsTab: the course-lifecycle control desk. Three sections —
//   1. Pending approval — review a submitted draft's full curriculum, then
//      Approve & Publish or Reject to Draft.
//   2. Published — flip catalog access (open/gated) or Archive a live course.
//   3. Archived — restore an archived course back to draft.
//
// Reads go through rpcAction('academy:get_course', …); every mutation is
// followed by refreshAcademy() so the shared academyCourses slice re-hydrates.
// Lesson content is stored as validated Tiptap JSON and previewed read-only via
// LessonContentView.

import React, { useCallback, useEffect, useState } from 'react';
import { LessonContentView } from './LessonRichText';
import { useData } from '../../../contexts/DataContext';
import { useAcademy } from '../../../contexts/AcademyContext';
import { useNotification } from '../../../contexts/NotificationContext';
import type { AcademyCourse, AcademyEnrollment } from '../../../types';

/** One approve/reject decision. Mirrors what academy:list_course_reviews returns. */
type CourseReview = { id: number; decision: 'approved' | 'rejected'; note: string | null; reviewedBy: number; createdAt: string };
import WindowFrame from '../../layout/WindowFrame';

const OK_TOAST = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50';
const ERR_TOAST = 'bg-red-500/10 text-red-400 border-red-500/50';

const SectionHeader: React.FC<{ label: string; count: number; icon: string; accent: string }> = ({ label, count, icon, accent }) => (
    <div className="flex items-center gap-2.5 mb-3">
        <i className={`${icon} ${accent} text-xs`} aria-hidden />
        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{label}</h3>
        <span className="min-w-[20px] h-5 px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center bg-slate-800 text-slate-400 border border-slate-700">{count}</span>
    </div>
);

export const ApprovalsTab: React.FC = () => {
    const { rpcAction } = useData();
    const { academyCourses, refreshAcademy } = useAcademy();
    const { addToast, confirm } = useNotification();

    // The course under review, its full fetched detail, and the in-flight guard.
    const [reviewCourse, setReviewCourse] = useState<AcademyCourse | null>(null);
    // The reviewer's note. Required on a reject and refused server-side without it —
    // a course returned to draft with no statement of what was wrong leaves the author
    // guessing, which is the whole reason this field exists.
    const [reviewNote, setReviewNote] = useState('');
    const [detail, setDetail] = useState<AcademyCourse | null>(null);
    // The prior decision trail for the open course. Recording a reject reason is
    // pointless if the next reviewer cannot see what the last one said — a resubmitted
    // course is reviewed AGAINST that note. Fetched with the course, gated
    // academy:instruct, and never shown outside this modal.
    const [reviews, setReviews] = useState<CourseReview[]>([]);
    const [busy, setBusy] = useState(false);

    const okToast = useCallback((message: string) => {
        addToast(message, <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
    }, [addToast]);
    const errToast = useCallback((err: unknown) => {
        addToast(err instanceof Error ? err.message : 'Something went wrong.', <i className="fa-solid fa-triangle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50');
    }, [addToast]);

    const pending = academyCourses.filter(c => c.status === 'pending_approval');
    const published = academyCourses.filter(c => c.status === 'published');
    const archived = academyCourses.filter(c => c.status === 'archived');

    // ── Review modal open/close ──────────────────────────────────────────────
    const openReview = useCallback(async (course: AcademyCourse) => {
        setReviewCourse(course);
        setDetail(null);
        setReviews([]);
        try {
            const full = await rpcAction('academy:get_course', { courseId: course.id }) as AcademyCourse;
            setDetail(full);
        } catch (err) {
            errToast(err);
            setReviewCourse(null);
            return;
        }
        try {
            const trail = await rpcAction('academy:list_course_reviews', { courseId: course.id }) as CourseReview[];
            setReviews(Array.isArray(trail) ? trail : []);
        } catch {
            // A missing trail is not a reason to block the review — the curriculum
            // above is what the decision is actually made on.
            setReviews([]);
        }
    }, [rpcAction, errToast]);

    const closeReview = useCallback(() => {
        setReviewCourse(null);
        setReviewNote('');
        setDetail(null);
        setReviews([]);
    }, []);

    // ── Mutations (each re-hydrates the shared slice) ────────────────────────
    const approve = useCallback(async () => {
        if (!reviewCourse) return;
        setBusy(true);
        try {
            await rpcAction('academy:approve_course', { courseId: reviewCourse.id, note: reviewNote.trim() || undefined });
            okToast('Course approved and published.');
            await refreshAcademy();
            closeReview();
        } catch (err) {
            errToast(err);
        } finally {
            setBusy(false);
        }
    }, [reviewCourse, reviewNote, rpcAction, okToast, errToast, refreshAcademy, closeReview]);

    const reject = useCallback(async () => {
        if (!reviewCourse) return;
        // Checked here only so the reviewer is told before the round-trip. The server
        // refuses a note-less reject regardless — this is a courtesy, not the control.
        if (!reviewNote.trim()) {
            errToast(new Error('Add a note explaining what needs to change before returning this course.'));
            return;
        }
        const ok = await confirm({
            title: 'Return to Draft?',
            message: 'This returns the course to its authors as a draft, with your note attached. No students are affected.',
            confirmText: 'Return to Draft',
            variant: 'warning',
        });
        if (!ok) return;
        setBusy(true);
        try {
            await rpcAction('academy:reject_course', { courseId: reviewCourse.id, note: reviewNote.trim() });
            okToast('Course returned to draft with your feedback.');
            await refreshAcademy();
            closeReview();
        } catch (err) {
            errToast(err);
        } finally {
            setBusy(false);
        }
    }, [reviewCourse, reviewNote, rpcAction, confirm, okToast, errToast, refreshAcademy, closeReview]);

    const setAccess = useCallback(async (course: AcademyCourse, access: 'open' | 'gated') => {
        if (course.access === access || busy) return;
        setBusy(true);
        try {
            await rpcAction('academy:set_course_access', { courseId: course.id, access });
            await refreshAcademy();
        } catch (err) {
            errToast(err);
        } finally {
            setBusy(false);
        }
    }, [busy, rpcAction, refreshAcademy, errToast]);

    const archiveCourse = useCallback(async (course: AcademyCourse) => {
        const ok = await confirm({
            title: 'Archive Course?',
            message: 'Archived courses leave the catalog and cannot be run as new sessions until restored.',
            confirmText: 'Archive',
            variant: 'warning',
        });
        if (!ok) return;
        setBusy(true);
        try {
            await rpcAction('academy:set_course_archived', { courseId: course.id, archived: true });
            okToast('Course archived.');
            await refreshAcademy();
        } catch (err) {
            errToast(err);
        } finally {
            setBusy(false);
        }
    }, [confirm, rpcAction, okToast, errToast, refreshAcademy]);

    const unarchiveCourse = useCallback(async (course: AcademyCourse) => {
        setBusy(true);
        try {
            await rpcAction('academy:set_course_archived', { courseId: course.id, archived: false });
            okToast('Course restored to draft.');
            await refreshAcademy();
        } catch (err) {
            errToast(err);
        } finally {
            setBusy(false);
        }
    }, [rpcAction, okToast, errToast, refreshAcademy]);

    return (
        <div className="space-y-8 max-w-3xl">
            {/* ── 1. Pending approval ─────────────────────────────────────── */}
            <section>
                <SectionHeader label="Awaiting Approval" count={pending.length} icon="fa-solid fa-clipboard-check" accent="text-amber-400" />
                {pending.length === 0 ? (
                    <p className="text-sm text-slate-500 italic px-1 py-6 text-center bg-slate-900/30 border border-slate-800/60 rounded-lg">No courses awaiting approval.</p>
                ) : (
                    <div className="space-y-2">
                        {pending.map(course => (
                            <div key={course.id} className="flex items-center gap-4 p-3.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-white truncate">{course.title}</p>
                                    <p className="text-[11px] text-slate-500 mt-0.5">
                                        <i className="fa-solid fa-chalkboard-user mr-1.5" aria-hidden />
                                        {course.instructors?.length ?? 0} instructor{(course.instructors?.length ?? 0) === 1 ? '' : 's'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void openReview(course)}
                                    className="shrink-0 px-4 py-2 text-[11px] font-black uppercase tracking-widest text-purple-200 rounded-lg bg-purple-500/15 border border-purple-500/30 hover:bg-purple-500/25 transition-colors"
                                >
                                    <i className="fa-solid fa-magnifying-glass mr-1.5" aria-hidden /> Review
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* ── 2. Published ────────────────────────────────────────────── */}
            <section>
                <SectionHeader label="Published Courses" count={published.length} icon="fa-solid fa-book-open" accent="text-emerald-400" />
                {published.length === 0 ? (
                    <p className="text-sm text-slate-500 italic px-1 py-6 text-center bg-slate-900/30 border border-slate-800/60 rounded-lg">No published courses yet.</p>
                ) : (
                    <div className="space-y-2">
                        {published.map(course => (
                            <div key={course.id} className="flex flex-wrap items-center gap-4 p-3.5 rounded-lg border border-slate-700/50 bg-slate-800/30">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-white truncate">{course.title}</p>
                                    <p className="text-[11px] text-slate-500 mt-0.5">
                                        {course.access === 'open' ? 'Open self-enrolment' : 'Gated — assigned only'}
                                    </p>
                                </div>

                                {/* Access segmented control */}
                                <div className="flex shrink-0 rounded-lg border border-slate-700 overflow-hidden text-[10px] font-black uppercase tracking-widest">
                                    {(['open', 'gated'] as const).map(a => (
                                        <button
                                            key={a}
                                            type="button"
                                            disabled={busy}
                                            onClick={() => void setAccess(course, a)}
                                            className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${
                                                course.access === a
                                                    ? (a === 'open' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300')
                                                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                                            }`}
                                        >
                                            {a}
                                        </button>
                                    ))}
                                </div>

                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void archiveCourse(course)}
                                    className="shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400 rounded-lg border border-slate-700 hover:text-slate-200 hover:border-slate-500 hover:bg-slate-800 transition-colors disabled:opacity-50"
                                >
                                    <i className="fa-solid fa-box-archive mr-1.5" aria-hidden /> Archive
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* ── 3. Archived (only when present) ─────────────────────────── */}
            {archived.length > 0 && (
                <section>
                    <SectionHeader label="Archived" count={archived.length} icon="fa-solid fa-box-archive" accent="text-slate-500" />
                    <div className="space-y-2">
                        {archived.map(course => (
                            <div key={course.id} className="flex items-center gap-4 p-3 rounded-lg border border-slate-800 bg-slate-900/40">
                                <p className="min-w-0 flex-1 text-sm text-slate-400 truncate">{course.title}</p>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void unarchiveCourse(course)}
                                    className="shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-purple-300 rounded-lg border border-purple-500/30 hover:bg-purple-500/15 transition-colors disabled:opacity-50"
                                >
                                    <i className="fa-solid fa-rotate-left mr-1.5" aria-hidden /> Unarchive
                                </button>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* ── Review modal ────────────────────────────────────────────── */}
            {reviewCourse && (
                <WindowFrame
                    isOpen
                    onClose={closeReview}
                    title={reviewCourse.title}
                    subtitle="Curriculum review · pending approval"
                    icon="fa-solid fa-clipboard-check"
                    color="purple"
                    width="max-w-2xl"
                >
                    <div className="flex flex-col h-full">
                        <div className="flex-1 overflow-y-auto p-5 space-y-6">
                            {!detail ? (
                                <div className="py-16 text-center text-slate-500">
                                    <i className="fa-solid fa-spinner animate-spin text-2xl" aria-hidden />
                                    <p className="text-xs mt-3 uppercase tracking-widest font-bold">Loading curriculum…</p>
                                </div>
                            ) : (
                                <>
                                    {detail.description && (
                                        <p className="text-sm text-slate-300">{detail.description}</p>
                                    )}

                                    {/* Certification reward */}
                                    {detail.certification && (
                                        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-amber-500/25 bg-amber-500/5">
                                            <i className="fa-solid fa-certificate text-amber-400" aria-hidden />
                                            <div className="min-w-0">
                                                <p className="text-[10px] text-amber-500/80 uppercase tracking-widest font-bold">Awards Certification</p>
                                                <p className="text-sm text-amber-200 font-semibold truncate">{detail.certification.name}</p>
                                            </div>
                                        </div>
                                    )}

                                    {/* Curriculum: modules → lessons */}
                                    <div>
                                        <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-3">Curriculum</p>
                                        {detail.modules.length === 0 ? (
                                            <p className="text-xs text-slate-500 italic">No modules defined.</p>
                                        ) : (
                                            <div className="space-y-4">
                                                {detail.modules.map((mod, mi) => (
                                                    <div key={mod.id} className="rounded-lg border border-slate-700/50 bg-slate-800/30 p-4">
                                                        <p className="text-sm font-bold text-white">
                                                            <span className="text-purple-400 font-mono mr-2">{mi + 1}.</span>{mod.title}
                                                        </p>
                                                        {mod.description && <p className="text-xs text-slate-500 mt-1">{mod.description}</p>}
                                                        {mod.lessons.length > 0 && (
                                                            <ul className="mt-3 space-y-3">
                                                                {mod.lessons.map(lesson => (
                                                                    <li key={lesson.id} className="pl-3 border-l-2 border-slate-700">
                                                                        <p className="text-sm text-slate-200 font-medium">{lesson.title}</p>
                                                                        <LessonContentView value={lesson.content} className="mt-1.5 text-slate-400" />
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Outcomes */}
                                    {detail.outcomes.length > 0 && (
                                        <div>
                                            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2">Learning Outcomes</p>
                                            <ul className="space-y-1.5">
                                                {detail.outcomes.map(o => (
                                                    <li key={o.id} className="flex items-start gap-2.5 text-sm text-slate-300">
                                                        <i className={`fa-solid fa-circle-check mt-0.5 ${o.required ? 'text-emerald-400' : 'text-slate-600'}`} aria-hidden />
                                                        <span className="flex-1">
                                                            {o.title}
                                                            {!o.required && <span className="ml-2 text-[10px] text-slate-500 uppercase tracking-widest">optional</span>}
                                                            {o.description && <span className="block text-xs text-slate-500 mt-0.5">{o.description}</span>}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {reviews.length > 0 && (
                            <div className="px-5 pb-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Previous decisions</h4>
                                <ul className="space-y-1.5">
                                    {reviews.map(r => (
                                        <li key={r.id} className="flex items-start gap-2 text-xs bg-slate-900/40 border border-slate-800 rounded-md px-3 py-2">
                                            <i className={`fa-solid ${r.decision === 'approved' ? 'fa-circle-check text-emerald-400' : 'fa-rotate-left text-amber-400'} mt-0.5`} aria-hidden />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-slate-300">
                                                    {r.decision === 'approved' ? 'Approved' : 'Returned to draft'}
                                                    <span className="text-slate-600 ml-2">{new Date(r.createdAt).toLocaleString()}</span>
                                                </p>
                                                {r.note && <p className="text-slate-400 mt-0.5 whitespace-pre-wrap break-words">{r.note}</p>}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Action bar */}
                        <div className="p-5 border-t border-slate-800 shrink-0 space-y-3">
                            <div>
                                <label htmlFor="academy-review-note" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
                                    Reviewer note <span className="text-slate-600">(required to return, optional to approve)</span>
                                </label>
                                <textarea
                                    id="academy-review-note"
                                    value={reviewNote}
                                    onChange={(e) => setReviewNote(e.target.value)}
                                    maxLength={2000}
                                    rows={3}
                                    disabled={busy}
                                    placeholder="What needs to change before this can be published?"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white placeholder:text-slate-600 outline-hidden focus:border-indigo-500/50 resize-none disabled:opacity-50"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => void reject()}
                                disabled={busy || !detail || !reviewNote.trim()}
                                title={!reviewNote.trim() ? 'Add a note explaining what needs to change' : undefined}
                                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-amber-400 rounded-lg hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Return to Draft
                            </button>
                            <button
                                type="button"
                                onClick={() => void approve()}
                                disabled={busy || !detail}
                                className="px-6 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-900/30 disabled:bg-slate-700 disabled:cursor-not-allowed"
                            >
                                {busy ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Approve & Publish'}
                            </button>
                            </div>
                        </div>
                    </div>
                </WindowFrame>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════
// CERTIFY TAB — cross-session queue of students recommended for certification.
// Reads via academy:list_recommended (academy:manage); Certify & Award is
// idempotent server-side (re-checks required-outcome competency + no duplicate cert).
// ════════════════════════════════════════════════════════════════════════════
export const CertifyTab: React.FC = () => {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const [rows, setRows] = useState<AcademyEnrollment[] | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const list = await rpcAction('academy:list_recommended', {}) as AcademyEnrollment[];
            setRows(list);
        } catch (err) {
            addToast(err instanceof Error ? err.message : 'Failed to load certify queue', <i className="fa-solid fa-triangle-exclamation" />, ERR_TOAST);
            setRows([]);
        }
    }, [rpcAction, addToast]);

    useEffect(() => {
        void (async () => { await load(); })();
    }, [load]);

    const certify = useCallback(async (e: AcademyEnrollment) => {
        const ok = await confirm({ title: 'Certify & complete?', message: `This marks ${e.student?.name || 'the student'} as completed for ${e.courseTitle || 'this course'} and awards any linked certification.`, confirmText: 'Certify & Award', variant: 'info' });
        if (!ok) return;
        setBusyId(e.id);
        try {
            await rpcAction('academy:certify_and_complete', { enrollmentId: e.id });
            addToast('Certified & completed', <i className="fa-solid fa-check" />, OK_TOAST);
            await load();
        } catch (err) {
            addToast(err instanceof Error ? err.message : 'Failed to certify', <i className="fa-solid fa-triangle-exclamation" />, ERR_TOAST);
        } finally {
            setBusyId(null);
        }
    }, [rpcAction, confirm, addToast, load]);

    if (rows === null) return <div className="py-16 text-center text-slate-500"><i className="fa-solid fa-spinner animate-spin text-2xl" aria-hidden /></div>;

    return (
        <div className="space-y-4 max-w-3xl">
            <div className="flex items-center gap-2.5">
                <i className="fa-solid fa-user-graduate text-purple-400 text-xs" aria-hidden />
                <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Recommended for Certification</h3>
                <span className="min-w-[20px] h-5 px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center bg-slate-800 text-slate-400 border border-slate-700">{rows.length}</span>
            </div>
            {rows.length === 0 ? (
                <p className="text-sm text-slate-500 italic px-1 py-10 text-center bg-slate-900/30 border border-slate-800/60 rounded-lg">No students are awaiting certification. Instructors recommend competent students here for sign-off.</p>
            ) : (
                <div className="space-y-2">
                    {rows.map(e => {
                        const total = e.lessonsTotal ?? 0;
                        const done = e.lessonsCompleted ?? 0;
                        return (
                            <div key={e.id} className="flex flex-wrap items-center gap-4 p-3.5 rounded-lg border border-purple-500/20 bg-purple-500/5">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-white truncate">{e.student?.name || 'Student'}</p>
                                    <p className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                                        <span><i className="fa-solid fa-book-open mr-1" aria-hidden />{e.courseTitle || 'Course'}</span>
                                        {e.sessionTitle && <span><i className="fa-solid fa-users mr-1" aria-hidden />{e.sessionTitle}</span>}
                                        {total > 0 && <span><i className="fa-solid fa-list-check mr-1" aria-hidden />{done}/{total} lessons</span>}
                                        {e.recommendedAt && <span><i className="fa-solid fa-clock mr-1" aria-hidden />{new Date(e.recommendedAt).toLocaleDateString()}</span>}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    disabled={busyId === e.id}
                                    onClick={() => void certify(e)}
                                    className="shrink-0 px-4 py-2 text-[11px] font-black uppercase tracking-widest text-white rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed"
                                >
                                    {busyId === e.id ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : <><i className="fa-solid fa-certificate mr-1.5" aria-hidden />Certify &amp; Award</>}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
