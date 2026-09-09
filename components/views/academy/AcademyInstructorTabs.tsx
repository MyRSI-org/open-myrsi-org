// Academy (LMS) instructor/management tabs: a Course Builder (curriculum
// authoring) and a Sessions manager (cohorts + roster + competency assessment).
// Both are list→detail drill-ins that hydrate the open entity through the
// permission-gated by-id RPC reads (academy:get_course / get_session /
// get_enrollment) and re-fetch after every mutation. Staff state comes from
// useAcademy(); rpcAction + certifications from useData(); the member picker
// from useMembers().allUsers. Purple accent throughout.

import React, { useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useAcademy } from '../../../contexts/AcademyContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { LessonContentEditor } from './LessonRichText';
import ImageInput from '../../common/ImageInput';
import type {
    AcademyCourse, AcademySession, AcademyEnrollment, AcademyModule, AcademyLesson,
    AcademyOutcome, AcademyOutcomeVerdict, AcademyCourseStatus, AcademySessionStatus,
    AcademyEnrollmentRequest, User,
} from '../../../types';

// ── Shared styling tokens ────────────────────────────────────────────────────
const OK_CLS = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50';
const ERR_CLS = 'bg-red-500/10 text-red-400 border-red-500/50';
const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-purple-500 outline-hidden';
const BTN_PRIMARY = 'px-4 py-2 text-xs font-bold uppercase tracking-widest text-white rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:cursor-not-allowed transition-colors';
const BTN_GHOST = 'px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white disabled:opacity-40';
const BTN_DANGER = 'px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg disabled:opacity-40';

const COURSE_STATUS: Record<AcademyCourseStatus, { label: string; cls: string }> = {
    draft: { label: 'Draft', cls: 'bg-slate-500/10 text-slate-300 border-slate-500/30' },
    pending_approval: { label: 'Pending Approval', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
    published: { label: 'Published', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
    archived: { label: 'Archived', cls: 'bg-slate-700/40 text-slate-400 border-slate-600/40' },
};
const SESSION_STATUS: Record<AcademySessionStatus, { label: string; cls: string }> = {
    scheduled: { label: 'Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
    in_progress: { label: 'In Progress', cls: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
    completed: { label: 'Completed', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
    cancelled: { label: 'Cancelled', cls: 'bg-red-500/10 text-red-300 border-red-500/30' },
};
const NEXT_STATUS: Record<AcademySessionStatus, AcademySessionStatus[]> = {
    scheduled: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
};

const Pill: React.FC<{ label: string; cls: string }> = ({ label, cls }) => (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${cls}`}>{label}</span>
);

const Spinner: React.FC = () => (
    <div className="flex items-center justify-center py-16 text-slate-500">
        <i className="fa-solid fa-circle-notch animate-spin text-2xl"></i>
    </div>
);

// ── Mutation runner: busy flag + toast + reload after every write ─────────────
function useRunner(reload: () => Promise<void>) {
    const { addToast } = useNotification();
    const [busy, setBusy] = useState(false);
    const run = (fn: () => Promise<unknown>, ok?: string) => {
        setBusy(true);
        void (async () => {
            try {
                await fn();
                if (ok) addToast(ok, <i className="fa-solid fa-check"></i>, OK_CLS);
                await reload();
            } catch (err: any) {
                addToast(err?.message || 'Action failed', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
            } finally {
                setBusy(false);
            }
        })();
    };
    return { busy, run };
}

// ── Member picker (multi-select over allUsers) ───────────────────────────────
const UserPicker: React.FC<{
    users: User[];
    excludeIds: Set<number>;
    actionLabel: string;
    busy?: boolean;
    onConfirm: (ids: number[]) => void;
    onCancel: () => void;
}> = ({ users, excludeIds, actionLabel, busy, onConfirm, onCancel }) => {
    const [q, setQ] = useState('');
    const [selected, setSelected] = useState<Set<number>>(() => new Set());

    const filtered = useMemo(() => {
        const s = q.toLowerCase().trim();
        return users
            .filter(u => !excludeIds.has(u.id))
            .filter(u => !s || u.name.toLowerCase().includes(s) || u.rsiHandle.toLowerCase().includes(s))
            .slice(0, 50);
    }, [users, excludeIds, q]);

    const toggle = (id: number) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    return (
        <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3 space-y-3">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name or RSI handle…" className={INPUT} />
            <div className="max-h-56 overflow-y-auto custom-scrollbar space-y-1">
                {filtered.length === 0 ? (
                    <p className="text-xs text-slate-500 italic px-1 py-3">No members match.</p>
                ) : filtered.map(u => {
                    const on = selected.has(u.id);
                    return (
                        <button key={u.id} type="button" onClick={() => toggle(u.id)}
                            className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-left transition-colors ${on ? 'bg-purple-500/15 border border-purple-500/40' : 'hover:bg-slate-800/60 border border-transparent'}`}>
                            {u.avatarUrl
                                ? <img src={u.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover ring-1 ring-slate-700 shrink-0" />
                                : <span className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-[10px] text-slate-400 shrink-0"><i className="fa-solid fa-user"></i></span>}
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm text-white truncate">{u.name}</span>
                                {u.rsiHandle && <span className="block text-[10px] text-slate-500 font-mono truncate">@{u.rsiHandle}</span>}
                            </span>
                            <i className={`fa-solid ${on ? 'fa-square-check text-purple-400' : 'fa-square text-slate-600'}`}></i>
                        </button>
                    );
                })}
            </div>
            <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={onCancel} className={BTN_GHOST}>Cancel</button>
                <button type="button" disabled={busy || selected.size === 0} onClick={() => onConfirm([...selected])} className={BTN_PRIMARY}>
                    {actionLabel} ({selected.size})
                </button>
            </div>
        </div>
    );
};

// ── Curriculum reordering ────────────────────────────────────────────────────
// A move submits the WHOLE sibling list, never a single nudge. The server refuses a
// subset outright (academy_apply_order counts the parent's children and rolls back if
// the array is not all of them), which is deliberate: writing positions for two of
// twenty modules collides with the eighteen it was not told about.
const moveInList = <T,>(items: readonly T[], index: number, dir: -1 | 1): T[] | null => {
    const to = index + dir;
    if (index < 0 || index >= items.length || to < 0 || to >= items.length) return null;
    const next = items.slice();
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row);
    return next;
};

const MoveButtons: React.FC<{ busy: boolean; first: boolean; last: boolean; label: string; onMove: (dir: -1 | 1) => void }> = ({ busy, first, last, label, onMove }) => (
    <span className="flex flex-col leading-none shrink-0">
        <button type="button" disabled={busy || first} onClick={() => onMove(-1)} title="Move up" aria-label={'Move ' + label + ' up'}
            className="text-slate-600 hover:text-purple-400 disabled:opacity-20 disabled:hover:text-slate-600 px-1"><i className="fa-solid fa-caret-up text-xs"></i></button>
        <button type="button" disabled={busy || last} onClick={() => onMove(1)} title="Move down" aria-label={'Move ' + label + ' down'}
            className="text-slate-600 hover:text-purple-400 disabled:opacity-20 disabled:hover:text-slate-600 px-1"><i className="fa-solid fa-caret-down text-xs"></i></button>
    </span>
);

// ════════════════════════════════════════════════════════════════════════════
// COURSE BUILDER
// ════════════════════════════════════════════════════════════════════════════

const LessonRow: React.FC<{ lesson: AcademyLesson; busy: boolean; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void; onSave: (patch: { title: string; content: string; videoUrl: string }) => void; onDelete: () => void; }> = ({ lesson, busy, first, last, onMove, onSave, onDelete }) => {
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(lesson.title);
    const [content, setContent] = useState(lesson.content ?? '');
    const [videoUrl, setVideoUrl] = useState(lesson.videoUrl ?? '');

    if (!editing) {
        return (
            <div className="flex items-start gap-2 px-3 py-2 bg-slate-900/40 border border-slate-800 rounded-md">
                <i className="fa-solid fa-file-lines text-slate-600 mt-0.5"></i>
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{lesson.title}</p>
                    {lesson.videoUrl && <p className="text-[10px] text-purple-400/70 font-mono truncate">{lesson.videoUrl}</p>}
                </div>
                <MoveButtons busy={busy} first={first} last={last} label="lesson" onMove={onMove} />
                <button type="button" onClick={() => setEditing(true)} className="text-slate-500 hover:text-purple-400 px-1"><i className="fa-solid fa-pen text-xs"></i></button>
                <button type="button" disabled={busy} onClick={onDelete} className="text-slate-500 hover:text-red-400 px-1"><i className="fa-solid fa-trash text-xs"></i></button>
            </div>
        );
    }
    return (
        <div className="p-3 bg-slate-900/60 border border-purple-500/30 rounded-md space-y-2">
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Lesson title" className={INPUT} />
            <LessonContentEditor value={content} onChange={setContent} />
            <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="Video URL (YouTube / Vimeo)" className={INPUT} />
            <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setEditing(false)} className={BTN_GHOST}>Cancel</button>
                <button type="button" disabled={busy || !title.trim()} onClick={() => { setEditing(false); onSave({ title: title.trim(), content, videoUrl }); }} className={BTN_PRIMARY}>Save</button>
            </div>
        </div>
    );
};

const ModuleCard: React.FC<{ mod: AcademyModule; busy: boolean; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void; rpcAction: (action: string, payload: any) => Promise<any>; run: (fn: () => Promise<unknown>, ok?: string) => void; confirm: ReturnType<typeof useNotification>['confirm']; }> = ({ mod, busy, first, last, onMove, rpcAction, run, confirm }) => {
    const [renaming, setRenaming] = useState(false);
    const [title, setTitle] = useState(mod.title);
    const [lessonTitle, setLessonTitle] = useState('');
    const [lessonContent, setLessonContent] = useState('');
    const [lessonVideo, setLessonVideo] = useState('');
    const [adding, setAdding] = useState(false);

    const addLesson = () => {
        const t = lessonTitle.trim();
        if (!t) return;
        run(() => rpcAction('academy:create_lesson', { moduleId: mod.id, title: t, content: lessonContent || null, videoUrl: lessonVideo.trim() || null }), 'Lesson added');
        setLessonTitle(''); setLessonContent(''); setLessonVideo(''); setAdding(false);
    };
    const moveLesson = (index: number, dir: -1 | 1) => {
        const next = moveInList(mod.lessons, index, dir);
        if (!next) return;
        run(() => rpcAction('academy:reorder_lessons', { moduleId: mod.id, orderedIds: next.map(l => l.id) }), 'Lessons reordered');
    };
    const removeModule = async () => {
        const ok = await confirm({ title: 'Delete module?', message: `"${mod.title}" and all its lessons will be removed.`, confirmText: 'Delete', variant: 'danger' });
        if (ok) run(() => rpcAction('academy:delete_module', { moduleId: mod.id }), 'Module deleted');
    };

    return (
        <div className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
                {renaming ? (
                    <>
                        <input value={title} onChange={e => setTitle(e.target.value)} className={INPUT} />
                        <button type="button" disabled={busy || !title.trim()} onClick={() => { setRenaming(false); run(() => rpcAction('academy:update_module', { moduleId: mod.id, title: title.trim() }), 'Module renamed'); }} className={BTN_PRIMARY}>Save</button>
                        <button type="button" onClick={() => { setRenaming(false); setTitle(mod.title); }} className={BTN_GHOST}>Cancel</button>
                    </>
                ) : (
                    <>
                        <i className="fa-solid fa-folder text-purple-400"></i>
                        <h4 className="text-sm font-bold text-white flex-1 truncate">{mod.title}</h4>
                        <MoveButtons busy={busy} first={first} last={last} label="module" onMove={onMove} />
                        <button type="button" onClick={() => setRenaming(true)} className="text-slate-500 hover:text-purple-400 px-1"><i className="fa-solid fa-pen text-xs"></i></button>
                        <button type="button" disabled={busy} onClick={removeModule} className="text-slate-500 hover:text-red-400 px-1"><i className="fa-solid fa-trash text-xs"></i></button>
                    </>
                )}
            </div>

            <div className="space-y-1.5">
                {mod.lessons.map((l, i) => (
                    <LessonRow key={l.id} lesson={l} busy={busy}
                        first={i === 0} last={i === mod.lessons.length - 1} onMove={dir => moveLesson(i, dir)}
                        onSave={patch => run(() => rpcAction('academy:update_lesson', { lessonId: l.id, title: patch.title, content: patch.content || null, videoUrl: patch.videoUrl.trim() || null }), 'Lesson saved')}
                        onDelete={() => run(() => rpcAction('academy:delete_lesson', { lessonId: l.id }), 'Lesson deleted')} />
                ))}
                {mod.lessons.length === 0 && !adding && <p className="text-[11px] text-slate-600 italic">No lessons yet.</p>}
            </div>

            {adding ? (
                <div className="p-3 bg-slate-900/60 border border-purple-500/30 rounded-md space-y-2">
                    <input value={lessonTitle} onChange={e => setLessonTitle(e.target.value)} placeholder="Lesson title" className={INPUT} />
                    <LessonContentEditor value={lessonContent} onChange={setLessonContent} />
                    <input value={lessonVideo} onChange={e => setLessonVideo(e.target.value)} placeholder="Video URL (YouTube / Vimeo)" className={INPUT} />
                    <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => setAdding(false)} className={BTN_GHOST}>Cancel</button>
                        <button type="button" disabled={busy || !lessonTitle.trim()} onClick={addLesson} className={BTN_PRIMARY}>Add Lesson</button>
                    </div>
                </div>
            ) : (
                <button type="button" onClick={() => setAdding(true)} className="w-full py-1.5 border border-dashed border-slate-700 rounded-md text-[11px] font-bold text-slate-400 hover:text-purple-400 hover:border-purple-600/40 uppercase tracking-widest">
                    <i className="fa-solid fa-plus mr-2"></i>Add Lesson
                </button>
            )}
        </div>
    );
};

const OutcomeRow: React.FC<{ outcome: AcademyOutcome; busy: boolean; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void; run: (fn: () => Promise<unknown>, ok?: string) => void; rpcAction: (action: string, payload: any) => Promise<any>; confirm: ReturnType<typeof useNotification>['confirm']; }> = ({ outcome, busy, first, last, onMove, run, rpcAction, confirm }) => {
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(outcome.title);

    const remove = async () => {
        const ok = await confirm({ title: 'Delete outcome?', message: `"${outcome.title}" will be removed.`, confirmText: 'Delete', variant: 'danger' });
        if (ok) run(() => rpcAction('academy:delete_outcome', { outcomeId: outcome.id }), 'Outcome deleted');
    };

    return (
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-900/40 border border-slate-800 rounded-md">
            {editing ? (
                <>
                    <input value={title} onChange={e => setTitle(e.target.value)} className={INPUT} />
                    <button type="button" disabled={busy || !title.trim()} onClick={() => { setEditing(false); run(() => rpcAction('academy:update_outcome', { outcomeId: outcome.id, title: title.trim() }), 'Outcome saved'); }} className={BTN_PRIMARY}>Save</button>
                    <button type="button" onClick={() => { setEditing(false); setTitle(outcome.title); }} className={BTN_GHOST}>Cancel</button>
                </>
            ) : (
                <>
                    <i className="fa-solid fa-bullseye text-purple-400/70"></i>
                    <span className="text-sm text-white flex-1 truncate">{outcome.title}</span>
                    <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:update_outcome', { outcomeId: outcome.id, required: !outcome.required }), 'Outcome updated')}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${outcome.required ? 'bg-purple-500/10 text-purple-300 border-purple-500/30' : 'bg-slate-700/30 text-slate-400 border-slate-600/40'}`}>
                        {outcome.required ? 'Required' : 'Optional'}
                    </button>
                    <MoveButtons busy={busy} first={first} last={last} label="outcome" onMove={onMove} />
                    <button type="button" onClick={() => setEditing(true)} className="text-slate-500 hover:text-purple-400 px-1"><i className="fa-solid fa-pen text-xs"></i></button>
                    <button type="button" disabled={busy} onClick={remove} className="text-slate-500 hover:text-red-400 px-1"><i className="fa-solid fa-trash text-xs"></i></button>
                </>
            )}
        </div>
    );
};

const CourseEditor: React.FC<{ course: AcademyCourse; canManage: boolean; onBack: () => void; onReload: () => Promise<void>; onDeleted: () => Promise<void>; }> = ({ course, canManage, onBack, onReload, onDeleted }) => {
    const { rpcAction, certifications } = useData();
    const { allUsers } = useMembers();
    const { confirm, addToast } = useNotification();
    const { busy, run } = useRunner(onReload);

    const [title, setTitle] = useState(course.title);
    const [description, setDescription] = useState(course.description ?? '');
    const [coverUrl, setCoverUrl] = useState<string | null>(course.imageUrl ?? null);
    const [moduleTitle, setModuleTitle] = useState('');
    const [outcomeTitle, setOutcomeTitle] = useState('');
    const [outcomeRequired, setOutcomeRequired] = useState(true);
    const [pickingInstructor, setPickingInstructor] = useState(false);

    const status = COURSE_STATUS[course.status];
    const instructorIds = useMemo(() => new Set(course.instructors.map(i => i.id)), [course.instructors]);

    const saveDetails = () => {
        if (!title.trim()) return;
        run(() => rpcAction('academy:update_course', { courseId: course.id, title: title.trim(), description: description.trim() || null, imageUrl: coverUrl }), 'Course saved');
    };
    const addModule = () => {
        const t = moduleTitle.trim();
        if (!t) return;
        run(() => rpcAction('academy:create_module', { courseId: course.id, title: t }), 'Module added');
        setModuleTitle('');
    };
    const addOutcome = () => {
        const t = outcomeTitle.trim();
        if (!t) return;
        run(() => rpcAction('academy:create_outcome', { courseId: course.id, title: t, required: outcomeRequired }), 'Outcome added');
        setOutcomeTitle('');
    };
    const moveModule = (index: number, dir: -1 | 1) => {
        const next = moveInList(course.modules, index, dir);
        if (!next) return;
        run(() => rpcAction('academy:reorder_modules', { courseId: course.id, orderedIds: next.map(m => m.id) }), 'Modules reordered');
    };
    const moveOutcome = (index: number, dir: -1 | 1) => {
        const next = moveInList(course.outcomes, index, dir);
        if (!next) return;
        run(() => rpcAction('academy:reorder_outcomes', { courseId: course.id, orderedIds: next.map(o => o.id) }), 'Outcomes reordered');
    };
    const addInstructors = (ids: number[]) => {
        setPickingInstructor(false);
        run(() => rpcAction('academy:add_course_instructors', { courseId: course.id, targetUserIds: ids }), 'Instructor(s) added');
    };
    const deleteCourse = async () => {
        const ok = await confirm({ title: 'Delete course?', message: `"${course.title}" and its curriculum will be permanently removed.`, confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        // Delete then hand back to the parent to clear the selection and refresh the LIST.
        // Do NOT route through `run`, whose post-action reload would re-fetch this now-deleted
        // course and surface a spurious "Course does not belong to this organisation" error.
        try {
            await rpcAction('academy:delete_course', { courseId: course.id });
            addToast('Course deleted', <i className="fa-solid fa-check"></i>, OK_CLS);
            await onDeleted();
        } catch (err: any) {
            addToast(err?.message || 'Failed to delete course', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={onBack} className={BTN_GHOST}><i className="fa-solid fa-arrow-left mr-2"></i>Back</button>
                <Pill label={status.label} cls={status.cls} />
                <div className="flex-1"></div>
                {course.status === 'draft' && (
                    <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:submit_course', { courseId: course.id }), 'Submitted for approval')} className={BTN_PRIMARY}>Submit for Approval</button>
                )}
                {(course.status === 'draft' || course.status === 'archived') && (
                    <button type="button" disabled={busy} onClick={deleteCourse} className={BTN_DANGER}>Delete Course</button>
                )}
            </div>

            {/* Details */}
            <section className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 space-y-3">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Details</h3>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Course title" className={INPUT} />
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Description" className={INPUT} />
                <ImageInput value={coverUrl} onChange={setCoverUrl} feature="academy" preview="landscape" label="Cover image (shown on the catalogue card and course page)" inputClassName={INPUT} />
                <div className="flex justify-end">
                    <button type="button" disabled={busy || !title.trim()} onClick={saveDetails} className={BTN_PRIMARY}>Save Details</button>
                </div>
            </section>

            {/* Certification reward — cert-award authority only */}
            {canManage && (
                <section className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 space-y-2">
                    <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Certification Reward</h3>
                    <select
                        value={course.certificationId ?? ''}
                        disabled={busy}
                        onChange={e => run(() => rpcAction('academy:set_course_certification', { courseId: course.id, certificationId: e.target.value ? Number(e.target.value) : null }), 'Certification updated')}
                        className={INPUT}>
                        <option value="">No certification</option>
                        {certifications.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <p className="text-[11px] text-slate-500">Awarded on certified completion. Requires the Award Certification permission.</p>
                </section>
            )}

            {/* Modules */}
            <section className="space-y-3">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Modules &amp; Lessons</h3>
                {course.modules.map((m, i) => (
                    <ModuleCard key={m.id} mod={m} busy={busy}
                        first={i === 0} last={i === course.modules.length - 1} onMove={dir => moveModule(i, dir)}
                        rpcAction={rpcAction} run={run} confirm={confirm} />
                ))}
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input value={moduleTitle} onChange={e => setModuleTitle(e.target.value)} placeholder="New module title" className={INPUT} />
                    <button type="button" disabled={busy || !moduleTitle.trim()} onClick={addModule} className={`${BTN_PRIMARY} shrink-0`}>Add Module</button>
                </div>
            </section>

            {/* Outcomes */}
            <section className="space-y-3">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Competency Outcomes</h3>
                {course.outcomes.map((o, i) => (
                    <OutcomeRow key={o.id} outcome={o} busy={busy}
                        first={i === 0} last={i === course.outcomes.length - 1} onMove={dir => moveOutcome(i, dir)}
                        run={run} rpcAction={rpcAction} confirm={confirm} />
                ))}
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input value={outcomeTitle} onChange={e => setOutcomeTitle(e.target.value)} placeholder="New outcome title" className={INPUT} />
                    <div className="flex items-center justify-between sm:justify-start gap-2 shrink-0">
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-400 uppercase tracking-widest">
                            <input type="checkbox" checked={outcomeRequired} onChange={e => setOutcomeRequired(e.target.checked)} className="accent-purple-500" />Required
                        </label>
                        <button type="button" disabled={busy || !outcomeTitle.trim()} onClick={addOutcome} className={BTN_PRIMARY}>Add</button>
                    </div>
                </div>
            </section>

            {/* Instructors */}
            <section className="space-y-3">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Instructors</h3>
                <div className="flex flex-wrap gap-2">
                    {course.instructors.map(i => (
                        <span key={i.id} className="flex items-center gap-2 pl-1 pr-2 py-1 bg-slate-800/60 border border-slate-700 rounded-full">
                            {i.avatarUrl
                                ? <img src={i.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
                                : <span className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px] text-slate-400"><i className="fa-solid fa-user"></i></span>}
                            <span className="text-xs text-white">{i.name}</span>
                            <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:remove_course_instructor', { courseId: course.id, targetUserId: i.id }), 'Instructor removed')} className="text-slate-500 hover:text-red-400"><i className="fa-solid fa-xmark text-xs"></i></button>
                        </span>
                    ))}
                    {course.instructors.length === 0 && <p className="text-[11px] text-slate-600 italic">No instructors assigned.</p>}
                </div>
                {pickingInstructor ? (
                    <UserPicker users={allUsers} excludeIds={instructorIds} actionLabel="Add" busy={busy} onConfirm={addInstructors} onCancel={() => setPickingInstructor(false)} />
                ) : (
                    <button type="button" onClick={() => setPickingInstructor(true)} className="text-xs font-bold text-purple-400 hover:text-purple-300 uppercase tracking-widest"><i className="fa-solid fa-plus mr-1"></i>Add Instructor</button>
                )}
            </section>
        </div>
    );
};

export const CourseBuilderTab: React.FC<{ canManage: boolean }> = ({ canManage }) => {
    const { rpcAction } = useData();
    const { academyCourses, refreshAcademy } = useAcademy();
    const { addToast } = useNotification();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<AcademyCourse | null>(null);
    const [creating, setCreating] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDelivery, setNewDelivery] = useState<'cohort' | 'self_paced'>('cohort');
    const [busy, setBusy] = useState(false);

    const loadDetail = async (courseId: string) => {
        try {
            const c = await rpcAction('academy:get_course', { courseId }) as AcademyCourse;
            setDetail(c);
        } catch (err: any) {
            addToast(err?.message || 'Failed to load course', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        }
    };
    const openCourse = (courseId: string) => { setSelectedId(courseId); setDetail(null); void loadDetail(courseId); };
    const back = () => { setSelectedId(null); setDetail(null); };
    const reload = async () => { await refreshAcademy(); if (selectedId) await loadDetail(selectedId); };
    // After a delete the course is gone — return to the list and refresh it, never re-fetch the detail.
    const afterDelete = async () => { setSelectedId(null); setDetail(null); await refreshAcademy(); };

    const createCourse = async () => {
        const t = newTitle.trim();
        if (!t) return;
        setBusy(true);
        try {
            const created = await rpcAction('academy:create_course', { title: t, delivery: newDelivery }) as AcademyCourse;
            addToast('Course created', <i className="fa-solid fa-check"></i>, OK_CLS);
            await refreshAcademy();
            setNewTitle(''); setNewDelivery('cohort'); setCreating(false);
            openCourse(created.id);
        } catch (err: any) {
            addToast(err?.message || 'Failed to create course', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        } finally {
            setBusy(false);
        }
    };

    if (selectedId) {
        if (!detail) return <Spinner />;
        return <CourseEditor key={detail.id} course={detail} canManage={canManage} onBack={back} onReload={reload} onDeleted={afterDelete} />;
    }

    return (
        <div className="space-y-4 animate-fade-in">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold text-white">Course Builder</h2>
                {!creating && (
                    <button type="button" onClick={() => setCreating(true)} className={`${BTN_PRIMARY} shrink-0`}><i className="fa-solid fa-plus mr-2"></i>New Course</button>
                )}
            </div>

            {creating && (
                <div className="bg-slate-800/40 border border-purple-500/30 rounded-lg p-4 space-y-3">
                    <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">New Course</h3>
                    <input value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void createCourse(); }} placeholder="Course title" className={INPUT} />
                    <select value={newDelivery} onChange={e => setNewDelivery(e.target.value as 'cohort' | 'self_paced')} title="How this course is run" className={INPUT}>
                        <option value="cohort">Cohort (sessions)</option>
                        <option value="self_paced">Self-paced</option>
                    </select>
                    <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => { setCreating(false); setNewTitle(''); setNewDelivery('cohort'); }} className={BTN_GHOST}>Cancel</button>
                        <button type="button" disabled={busy || !newTitle.trim()} onClick={createCourse} className={BTN_PRIMARY}>Create</button>
                    </div>
                </div>
            )}

            {academyCourses.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                    <i className="fa-solid fa-graduation-cap text-3xl mb-3 text-slate-700"></i>
                    <p className="text-sm">No courses yet. Create one to start building curriculum.</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {academyCourses.map(c => {
                        const st = COURSE_STATUS[c.status];
                        return (
                            <button key={c.id} type="button" onClick={() => openCourse(c.id)}
                                className="w-full flex items-center gap-4 p-4 bg-slate-800/40 border border-slate-700 rounded-lg text-left hover:border-purple-500/40 hover:bg-slate-800/60 transition-colors">
                                <i className={`fa-solid ${c.icon || 'fa-graduation-cap'} text-purple-400 text-lg w-6 text-center`}></i>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-white truncate">{c.title}</p>
                                    <p className="text-[11px] text-slate-500">{c.instructors.length} instructor{c.instructors.length === 1 ? '' : 's'}</p>
                                </div>
                                <Pill label={st.label} cls={st.cls} />
                                <i className="fa-solid fa-chevron-right text-slate-600 text-xs"></i>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ════════════════════════════════════════════════════════════════════════════

const NewSessionForm: React.FC<{ courses: AcademyCourse[]; busy: boolean; onSubmit: (data: { courseId: string; title: string; startsAt: string | null; location: string | null; capacity: number | null }) => void; onCancel: () => void; }> = ({ courses, busy, onSubmit, onCancel }) => {
    const [courseId, setCourseId] = useState('');
    const [title, setTitle] = useState('');
    const [startsAt, setStartsAt] = useState('');
    const [location, setLocation] = useState('');
    const [capacity, setCapacity] = useState('');

    const submit = () => {
        if (!courseId || !title.trim()) return;
        onSubmit({ courseId, title: title.trim(), startsAt: startsAt || null, location: location.trim() || null, capacity: capacity ? Math.max(1, Number(capacity) || 0) || null : null });
    };

    return (
        <div className="bg-slate-800/40 border border-purple-500/30 rounded-lg p-4 space-y-3">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">New Session</h3>
            <select value={courseId} onChange={e => setCourseId(e.target.value)} className={INPUT}>
                <option value="">Select a published course…</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Session title (e.g. Alpha Cohort)" className={INPUT} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} className={INPUT} />
                <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Location" className={INPUT} />
                <input type="number" min={1} value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="Capacity" className={INPUT} />
            </div>
            <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={onCancel} className={BTN_GHOST}>Cancel</button>
                <button type="button" disabled={busy || !courseId || !title.trim()} onClick={submit} className={BTN_PRIMARY}>Create Session</button>
            </div>
        </div>
    );
};

const EnrollmentPanel: React.FC<{ enrollment: AcademyEnrollment; course: AcademyCourse; canManage: boolean; reload: () => Promise<void>; onClose: () => void; }> = ({ enrollment, course, canManage, reload, onClose }) => {
    const { rpcAction } = useData();
    const { confirm } = useNotification();
    const { busy, run } = useRunner(reload);

    const verdictOf = (outcomeId: number): AcademyOutcomeVerdict | null => {
        const r = enrollment.outcomeResults.find(x => x.outcomeId === outcomeId);
        return r ? r.verdict : null;
    };
    const certify = async () => {
        const ok = await confirm({ title: 'Certify & complete?', message: `This will mark ${enrollment.student?.name || 'the student'} as completed and award any linked certification.`, confirmText: 'Certify', variant: 'info' });
        if (ok) run(() => rpcAction('academy:certify_and_complete', { enrollmentId: enrollment.id }), 'Certified & completed');
    };

    return (
        <div className="bg-slate-900/60 border border-purple-500/30 rounded-lg p-4 space-y-4 animate-fade-in">
            <div className="flex items-center gap-3">
                <i className="fa-solid fa-user-graduate text-purple-400"></i>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white truncate">{enrollment.student?.name || 'Student'}</p>
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest">{enrollment.status.replace('_', ' ')} · {enrollment.source}</p>
                </div>
                <button type="button" onClick={onClose} className="text-slate-500 hover:text-white px-2"><i className="fa-solid fa-xmark"></i></button>
            </div>

            <div className="space-y-2">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Competency Assessment</h4>
                {course.outcomes.length === 0 && <p className="text-[11px] text-slate-600 italic">This course has no outcomes to assess.</p>}
                {course.outcomes.map(o => {
                    const v = verdictOf(o.id);
                    return (
                        <div key={o.id} className="flex items-center gap-2 px-3 py-2 bg-slate-800/40 border border-slate-800 rounded-md">
                            <span className="text-sm text-white flex-1 truncate">{o.title}{o.required && <span className="text-purple-400/70 ml-1">*</span>}</span>
                            <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:assess_outcome', { enrollmentId: enrollment.id, outcomeId: o.id, verdict: 'competent' }), 'Assessed')}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border ${v === 'competent' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'text-slate-400 border-slate-600/40 hover:border-emerald-500/40'}`}>Competent</button>
                            <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:assess_outcome', { enrollmentId: enrollment.id, outcomeId: o.id, verdict: 'not_yet_competent' }), 'Assessed')}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border ${v === 'not_yet_competent' ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'text-slate-400 border-slate-600/40 hover:border-amber-500/40'}`}>Not Yet</button>
                        </div>
                    );
                })}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800">
                <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:recommend_certification', { enrollmentId: enrollment.id }), 'Recommended for certification')} className={BTN_PRIMARY}>Recommend for Certification</button>
                {canManage && <button type="button" disabled={busy} onClick={certify} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-white rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed">Certify &amp; Complete</button>}
                <div className="flex-1"></div>
                <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:withdraw_enrollment', { enrollmentId: enrollment.id }), 'Withdrawn')} className={BTN_DANGER}>Withdraw</button>
            </div>
        </div>
    );
};

// Pending seat requests for one session.
//
// Fetched HERE rather than folded into academy:get_session: the queue is staff-only
// (academy:instruct), get_session is the panel every instructor opens, and a member
// list of who asked for what does not belong in a payload that exists to render a
// roster. Its own action keeps the gate on the data rather than on the screen.
const SeatRequestQueue: React.FC<{
    sessionId: string;
    names: Map<number, string>;
    busy: boolean;
    onDecide: (requestId: string, decision: 'approve' | 'deny', reason: string) => Promise<void>;
    reloadKey: number;
}> = ({ sessionId, names, busy, onDecide, reloadKey }) => {
    const { rpcAction } = useData();
    const [requests, setRequests] = useState<AcademyEnrollmentRequest[]>([]);
    const [reasons, setReasons] = useState<Record<string, string>>({});

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const rows = await rpcAction('academy:list_enrollment_requests', { sessionId }) as AcademyEnrollmentRequest[];
                if (alive) setRequests(Array.isArray(rows) ? rows : []);
            } catch {
                // A queue that fails to load shows as empty, never as stale: an instructor
                // acting on a decided request would get the already-decided refusal anyway.
                if (alive) setRequests([]);
            }
        })();
        return () => { alive = false; };
    }, [rpcAction, sessionId, reloadKey]);

    if (requests.length === 0) return null;

    return (
        <section className="space-y-2">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                Seat Requests ({requests.length})
            </h3>
            <div className="space-y-1.5">
                {requests.map(r => (
                    <div key={r.id} className="bg-amber-500/5 border border-amber-500/25 rounded-md p-3 space-y-2">
                        <div className="flex items-start gap-2">
                            <i className="fa-solid fa-hand text-amber-400/80 mt-0.5" aria-hidden></i>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm text-white truncate">{names.get(r.studentId) || `Member #${r.studentId}`}</p>
                                {r.message && <p className="text-[11px] text-slate-400 mt-0.5 whitespace-pre-wrap break-words">{r.message}</p>}
                                <p className="text-[10px] text-slate-600 mt-0.5">Asked {new Date(r.createdAt).toLocaleString()}</p>
                            </div>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            <input
                                value={reasons[r.id] || ''}
                                onChange={e => setReasons(prev => ({ ...prev, [r.id]: e.target.value }))}
                                maxLength={500} disabled={busy}
                                placeholder="Reason (shown to them if declined)"
                                aria-label="Decision reason"
                                className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-white placeholder:text-slate-600 outline-hidden focus:border-purple-500/50 disabled:opacity-50"
                            />
                            <div className="flex items-center gap-2 shrink-0">
                                <button type="button" disabled={busy} onClick={() => void onDecide(r.id, 'deny', (reasons[r.id] || '').trim())}
                                    className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-red-400 hover:bg-red-500/10 rounded-md disabled:opacity-40">Decline</button>
                                <button type="button" disabled={busy} onClick={() => void onDecide(r.id, 'approve', (reasons[r.id] || '').trim())}
                                    className="px-3 py-1.5 text-[11px] font-black uppercase tracking-widest rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:bg-slate-700 disabled:text-slate-500">Approve</button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
};

const SessionDetail: React.FC<{ data: { session: AcademySession; enrollments: AcademyEnrollment[] }; canManage: boolean; onBack: () => void; onReload: () => Promise<void>; }> = ({ data, canManage, onBack, onReload }) => {
    const { rpcAction } = useData();
    const { allUsers } = useMembers();
    const { addToast, confirm } = useNotification();
    const { busy, run } = useRunner(onReload);

    const { session, enrollments } = data;
    const [assigning, setAssigning] = useState(false);
    const [selectedEnrollmentId, setSelectedEnrollmentId] = useState<string | null>(null);
    const [enrollmentDetail, setEnrollmentDetail] = useState<{ enrollment: AcademyEnrollment; course: AcademyCourse } | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    // Bumped after every decision so the queue re-reads. A decision can also change the
    // roster (an approval claims a seat), so onReload runs alongside it.
    const [requestTick, setRequestTick] = useState(0);

    const memberNames = useMemo(() => new Map(allUsers.map(u => [u.id, u.name])), [allUsers]);

    const decideRequest = async (requestId: string, decision: 'approve' | 'deny', reason: string) => {
        try {
            await rpcAction('academy:decide_enrollment_request', { requestId, decision, reason: reason || undefined });
            addToast(decision === 'approve' ? 'Request approved' : 'Request declined', <i className="fa-solid fa-check"></i>, OK_CLS);
            setRequestTick(t => t + 1);
            await onReload();
        } catch (err: any) {
            addToast(err?.message || 'Failed to record the decision', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
            // Re-read either way: the usual failure IS "already decided by someone else",
            // and leaving the stale row on screen invites a second attempt at it.
            setRequestTick(t => t + 1);
        }
    };

    const st = SESSION_STATUS[session.status];
    const activeEnrollments = enrollments.filter(e => e.status !== 'withdrawn');
    const enrolledIds = useMemo(() => new Set(activeEnrollments.map(e => e.studentId)), [activeEnrollments]);

    const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    const bulkWithdraw = async () => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        const ok = await confirm({ title: `Withdraw ${ids.length} student${ids.length === 1 ? '' : 's'}?`, message: 'They lose their place and progress in this session.', confirmText: 'Withdraw', variant: 'danger' });
        if (!ok) return;
        setSelectedIds(new Set());
        run(() => rpcAction('academy:withdraw_enrollments_bulk', { sessionId: session.id, enrollmentIds: ids }), `${ids.length} student${ids.length === 1 ? '' : 's'} withdrawn`);
    };
    const bulkRecommend = async () => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        setSelectedIds(new Set());
        try {
            const res = await rpcAction('academy:recommend_enrollments_bulk', { sessionId: session.id, enrollmentIds: ids }) as { recommended: number; skipped: number };
            addToast(`${res.recommended} recommended${res.skipped ? `, ${res.skipped} not yet competent` : ''}`, <i className="fa-solid fa-check"></i>, OK_CLS);
            await onReload();
        } catch (err: any) {
            addToast(err?.message || 'Failed to recommend', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        }
    };

    const loadEnrollment = async (enrollmentId: string) => {
        try {
            const d = await rpcAction('academy:get_enrollment', { enrollmentId }) as { enrollment: AcademyEnrollment; course: AcademyCourse };
            setEnrollmentDetail(d);
        } catch (err: any) {
            addToast(err?.message || 'Failed to load enrolment', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        }
    };
    const openEnrollment = (enrollmentId: string) => { setSelectedEnrollmentId(enrollmentId); setEnrollmentDetail(null); void loadEnrollment(enrollmentId); };
    const reloadEnrollmentAndSession = async () => { await onReload(); if (selectedEnrollmentId) await loadEnrollment(selectedEnrollmentId); };

    const assignStudents = (ids: number[]) => { setAssigning(false); run(() => rpcAction('academy:assign_students', { sessionId: session.id, studentIds: ids }), 'Students assigned'); };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center gap-3">
                <button type="button" onClick={onBack} className={BTN_GHOST}><i className="fa-solid fa-arrow-left mr-2"></i>Back</button>
                <div className="min-w-0">
                    <p className="text-sm font-bold text-white truncate">{session.title}</p>
                    <p className="text-[11px] text-slate-500 truncate">{session.courseTitle}</p>
                </div>
                <div className="flex-1"></div>
                <Pill label={st.label} cls={st.cls} />
            </div>

            {/* Controls */}
            <section className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 flex flex-wrap items-center gap-2">
                {NEXT_STATUS[session.status].map(next => (
                    <button key={next} type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:set_session_status', { sessionId: session.id, status: next }), `Session ${SESSION_STATUS[next].label.toLowerCase()}`)}
                        className={next === 'cancelled' ? BTN_DANGER : BTN_PRIMARY}>
                        {next === 'in_progress' ? 'Start' : next === 'completed' ? 'Complete' : next === 'cancelled' ? 'Cancel Session' : next}
                    </button>
                ))}
                <div className="flex-1"></div>
                <button type="button" disabled={busy} onClick={() => run(() => rpcAction('academy:update_session', { sessionId: session.id, enrollmentOpen: !session.enrollmentOpen }), 'Enrolment updated')}
                    className={`px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest border ${session.enrollmentOpen ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-slate-700/30 text-slate-400 border-slate-600/40'}`}>
                    <i className={`fa-solid ${session.enrollmentOpen ? 'fa-lock-open' : 'fa-lock'} mr-2`}></i>Enrolment {session.enrollmentOpen ? 'Open' : 'Closed'}
                </button>
            </section>

            <SeatRequestQueue sessionId={session.id} names={memberNames} busy={busy} onDecide={decideRequest} reloadKey={requestTick} />

            {/* Roster */}
            <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Roster ({activeEnrollments.length}{session.capacity != null ? ` / ${session.capacity}` : ''})</h3>
                    <div className="flex items-center gap-3">
                        {selectedIds.size > 0 && (
                            <>
                                <span className="text-[10px] text-slate-500 uppercase tracking-widest">{selectedIds.size} selected</span>
                                <button type="button" disabled={busy} onClick={bulkRecommend} className="text-xs font-bold text-emerald-400 hover:text-emerald-300 uppercase tracking-widest disabled:opacity-50"><i className="fa-solid fa-user-graduate mr-1"></i>Recommend</button>
                                <button type="button" disabled={busy} onClick={bulkWithdraw} className="text-xs font-bold text-red-400 hover:text-red-300 uppercase tracking-widest disabled:opacity-50"><i className="fa-solid fa-user-minus mr-1"></i>Withdraw</button>
                                <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-500 hover:text-slate-300 uppercase tracking-widest">Clear</button>
                            </>
                        )}
                        {!assigning && <button type="button" onClick={() => setAssigning(true)} className="text-xs font-bold text-purple-400 hover:text-purple-300 uppercase tracking-widest"><i className="fa-solid fa-user-plus mr-1"></i>Assign Students</button>}
                    </div>
                </div>
                {assigning && <UserPicker users={allUsers} excludeIds={enrolledIds} actionLabel="Assign" busy={busy} onConfirm={assignStudents} onCancel={() => setAssigning(false)} />}
                {enrollments.length === 0 ? (
                    <p className="text-[11px] text-slate-600 italic">No students enrolled yet.</p>
                ) : (
                    <div className="space-y-1.5">
                        {enrollments.map(e => {
                            const active = e.status !== 'withdrawn';
                            return (
                            <div key={e.id}
                                className={`w-full flex items-center gap-2 px-2 py-2 rounded-md border transition-colors ${selectedEnrollmentId === e.id ? 'bg-purple-500/10 border-purple-500/40' : selectedIds.has(e.id) ? 'bg-purple-500/5 border-purple-500/25' : 'bg-slate-800/40 border-slate-800 hover:border-purple-500/30'}`}>
                                {active
                                    ? <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => toggleSelect(e.id)} className="shrink-0 w-4 h-4 accent-purple-500 cursor-pointer" aria-label={`Select ${e.student?.name || 'student'}`} />
                                    : <span className="w-4 shrink-0" />}
                                <button type="button" onClick={() => openEnrollment(e.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                                    {e.student?.avatarUrl
                                        ? <img src={e.student.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover ring-1 ring-slate-700 shrink-0" />
                                        : <span className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-[10px] text-slate-400 shrink-0"><i className="fa-solid fa-user"></i></span>}
                                    <span className="text-sm text-white flex-1 truncate">{e.student?.name || 'Student'}</span>
                                    <span className="text-[10px] text-slate-500 uppercase tracking-widest">{e.status.replace('_', ' ')}</span>
                                    <span className="text-[10px] text-slate-600 uppercase tracking-widest">{e.source}</span>
                                </button>
                            </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Enrolment detail */}
            {selectedEnrollmentId && (
                enrollmentDetail
                    ? <EnrollmentPanel enrollment={enrollmentDetail.enrollment} course={enrollmentDetail.course} canManage={canManage} reload={reloadEnrollmentAndSession} onClose={() => { setSelectedEnrollmentId(null); setEnrollmentDetail(null); }} />
                    : <Spinner />
            )}
        </div>
    );
};

export const SessionsTab: React.FC<{ canManage: boolean }> = ({ canManage }) => {
    const { rpcAction } = useData();
    const { academyCourses, academySessions, refreshAcademy } = useAcademy();
    const { addToast } = useNotification();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<{ session: AcademySession; enrollments: AcademyEnrollment[] } | null>(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);

    const publishedCourses = useMemo(() => academyCourses.filter(c => c.status === 'published'), [academyCourses]);

    const loadSession = async (sessionId: string) => {
        try {
            const d = await rpcAction('academy:get_session', { sessionId }) as { session: AcademySession; enrollments: AcademyEnrollment[] };
            setDetail(d);
        } catch (err: any) {
            addToast(err?.message || 'Failed to load session', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        }
    };
    const openSession = (sessionId: string) => { setSelectedId(sessionId); setDetail(null); void loadSession(sessionId); };
    const back = () => { setSelectedId(null); setDetail(null); };
    const reload = async () => { await refreshAcademy(); if (selectedId) await loadSession(selectedId); };

    const createSession = async (data: { courseId: string; title: string; startsAt: string | null; location: string | null; capacity: number | null }) => {
        setBusy(true);
        try {
            const created = await rpcAction('academy:create_session', data) as AcademySession;
            addToast('Session created', <i className="fa-solid fa-check"></i>, OK_CLS);
            await refreshAcademy();
            setCreating(false);
            openSession(created.id);
        } catch (err: any) {
            addToast(err?.message || 'Failed to create session', <i className="fa-solid fa-xmark"></i>, ERR_CLS);
        } finally {
            setBusy(false);
        }
    };

    if (selectedId) {
        if (!detail) return <Spinner />;
        return <SessionDetail key={detail.session.id} data={detail} canManage={canManage} onBack={back} onReload={reload} />;
    }

    return (
        <div className="space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Sessions</h2>
                {!creating && <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY}><i className="fa-solid fa-plus mr-2"></i>New Session</button>}
            </div>

            {creating && <NewSessionForm courses={publishedCourses} busy={busy} onSubmit={createSession} onCancel={() => setCreating(false)} />}

            {academySessions.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                    <i className="fa-solid fa-users-rectangle text-3xl mb-3 text-slate-700"></i>
                    <p className="text-sm">No sessions yet. Run a published course as a cohort.</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {academySessions.map(s => {
                        const sst = SESSION_STATUS[s.status];
                        return (
                            <button key={s.id} type="button" onClick={() => openSession(s.id)}
                                className="w-full flex items-center gap-4 p-4 bg-slate-800/40 border border-slate-700 rounded-lg text-left hover:border-purple-500/40 hover:bg-slate-800/60 transition-colors">
                                <i className="fa-solid fa-users-rectangle text-purple-400 text-lg w-6 text-center"></i>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-white truncate">{s.title}</p>
                                    <p className="text-[11px] text-slate-500 truncate">{s.courseTitle}</p>
                                </div>
                                <span className="text-[11px] text-slate-400 font-mono">{s.enrollmentCount}{s.capacity != null ? ` / ${s.capacity}` : ''}</span>
                                <Pill label={sst.label} cls={sst.cls} />
                                <i className="fa-solid fa-chevron-right text-slate-600 text-xs"></i>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
