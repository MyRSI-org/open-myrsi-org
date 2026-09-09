// CourseDetailView — full course detail page (master-detail inside the Catalogue tab,
// replacing the old stacked modal that got unwieldy for large curricula). Hero cover
// image, instructors + certification, enrol CTA (self-paced) or upcoming sessions
// (cohort), a collapsible module/lesson curriculum, and learning outcomes.
import React, { useMemo, useState } from 'react';
import type { AcademyCourse, AcademySession, AcademyModule, AcademyEnrollmentRequest } from '../../../types';

type CatalogDetail = { course: AcademyCourse; sessions: AcademySession[] };

// ── Gated access ─────────────────────────────────────────────────────────────
// A gated course cannot be self-enrolled — the server refuses it outright — so the
// button has to be a different button, not the same one that fails. What the viewer
// sees is driven by their OWN request row: none/denied/withdrawn offers the ask,
// pending offers a cancel, and an approved one has already become an enrolment (so
// enrolledSessionIds wins before this is consulted).
const SeatRequestControl: React.FC<{
    request: AcademyEnrollmentRequest | undefined;
    busy: boolean;
    compact?: boolean;
    onRequest: (message: string) => void;
    onCancel: (requestId: string) => void;
}> = ({ request, busy, compact, onRequest, onCancel }) => {
    const [asking, setAsking] = useState(false);
    const [message, setMessage] = useState('');
    const btn = compact
        ? 'shrink-0 px-4 py-2 text-[11px] font-black uppercase tracking-widest rounded-lg'
        : 'shrink-0 px-5 py-2.5 text-xs font-black uppercase tracking-widest rounded-lg';

    if (request?.status === 'pending') {
        return (
            <div className="shrink-0 flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-amber-400"><i className="fa-solid fa-hourglass-half mr-1.5" aria-hidden />Requested</span>
                <button type="button" disabled={busy} onClick={() => onCancel(request.id)}
                    className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 disabled:opacity-40">Cancel</button>
            </div>
        );
    }

    if (!asking) {
        return (
            <div className="shrink-0 text-right">
                <button type="button" disabled={busy} onClick={() => setAsking(true)}
                    className={`${btn} bg-purple-600 hover:bg-purple-500 text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed`}>
                    Request Seat
                </button>
                {request?.status === 'denied' && (
                    // The reason is shown because the student is its subject and the
                    // alternative is a silent refusal they cannot act on.
                    <p className="text-[10px] text-red-400/80 mt-1 max-w-[16rem]">
                        Previously declined{request.decisionReason ? `: ${request.decisionReason}` : '.'}
                    </p>
                )}
            </div>
        );
    }

    return (
        <div className="shrink-0 w-full sm:w-72 space-y-2">
            <textarea
                value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={500} disabled={busy}
                placeholder="Why you'd like a seat (optional)" aria-label="Message to the instructors"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white placeholder:text-slate-600 outline-hidden focus:border-purple-500/50 resize-none disabled:opacity-50"
            />
            <div className="flex items-center justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => { setAsking(false); setMessage(''); }}
                    className="text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-white disabled:opacity-40">Cancel</button>
                <button type="button" disabled={busy} onClick={() => { setAsking(false); onRequest(message.trim()); setMessage(''); }}
                    className="px-4 py-1.5 text-[11px] font-black uppercase tracking-widest rounded-lg bg-purple-600 hover:bg-purple-500 text-white disabled:bg-slate-700 disabled:text-slate-500">
                    Send Request
                </button>
            </div>
        </div>
    );
};

const ModuleAccordion: React.FC<{ modules: AcademyModule[] }> = ({ modules }) => {
    // Expand the first module by default; the rest collapse so a long course stays scannable.
    const [open, setOpen] = useState<Set<number>>(() => new Set(modules.slice(0, 1).map(m => m.id)));
    const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const totalLessons = modules.reduce((n, m) => n + m.lessons.length, 0);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Curriculum</p>
                <span className="text-[11px] text-slate-500">{modules.length} module{modules.length === 1 ? '' : 's'} · {totalLessons} lesson{totalLessons === 1 ? '' : 's'}</span>
            </div>
            {modules.length === 0 ? (
                <p className="text-xs text-slate-500">No modules published yet.</p>
            ) : modules.map((m, i) => {
                const isOpen = open.has(m.id);
                return (
                    <div key={m.id} className="border border-slate-700/50 rounded-lg overflow-hidden bg-slate-800/30">
                        <button type="button" onClick={() => toggle(m.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/50 transition-colors">
                            <span className="text-purple-400 font-mono text-xs shrink-0">{i + 1}</span>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-white truncate">{m.title}</p>
                                <p className="text-[11px] text-slate-500">{m.lessons.length} lesson{m.lessons.length === 1 ? '' : 's'}</p>
                            </div>
                            <i className={`fa-solid fa-chevron-down text-slate-500 text-xs shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden />
                        </button>
                        {isOpen && (
                            <div className="px-4 pb-3">
                                {m.description && <p className="text-xs text-slate-500 mb-2">{m.description}</p>}
                                <ul>
                                    {m.lessons.length === 0 ? (
                                        <li className="text-xs text-slate-600 italic py-1">No lessons yet.</li>
                                    ) : m.lessons.map(l => (
                                        <li key={l.id} className="flex items-center gap-2 text-xs text-slate-400 py-1.5 border-t border-slate-800 first:border-t-0">
                                            <i className="fa-solid fa-book-open text-purple-400/70 text-[10px] shrink-0" aria-hidden />
                                            <span className="flex-1 truncate">{l.title}</span>
                                            {l.videoUrl && <i className="fa-solid fa-play text-[9px] text-slate-500 shrink-0" aria-hidden title="Includes video" />}
                                            {l.estimatedMinutes != null && <span className="text-slate-600 shrink-0">{l.estimatedMinutes}m</span>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export const CourseDetailView: React.FC<{
    detail: CatalogDetail;
    busy: boolean;
    enrolledSessionIds: Set<string>;
    /** The viewer's OWN request per session — never anyone else's. */
    myRequests: Map<string, AcademyEnrollmentRequest>;
    onEnrol: (sessionId: string) => void;
    onRequest: (sessionId: string, message: string) => void;
    onCancelRequest: (requestId: string) => void;
    onBack: () => void;
}> = ({ detail, busy, enrolledSessionIds, myRequests, onEnrol, onRequest, onCancelRequest, onBack }) => {
    const { course, sessions } = detail;
    const totalLessons = useMemo(() => course.modules.reduce((n, m) => n + m.lessons.length, 0), [course.modules]);
    const selfPacedSession = course.delivery === 'self_paced' ? sessions[0] : null;
    const alreadySelfEnrolled = selfPacedSession ? enrolledSessionIds.has(selfPacedSession.id) : false;
    const gated = course.access === 'gated';

    return (
        // Full-bleed: cancel the hub content area's p-4 sm:p-6 so the hero sits flush
        // to the edges; the inner body re-adds its own padding.
        <div className="animate-fade-in -m-4 sm:-m-6">
            {/* Hero */}
            <div className="relative">
                {course.imageUrl ? (
                    <div className="relative h-48 sm:h-64 w-full overflow-hidden bg-slate-900">
                        <img src={course.imageUrl} alt="" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/50 to-slate-950/10" />
                    </div>
                ) : (
                    <div className="h-32 sm:h-40 w-full bg-gradient-to-br from-purple-900/40 via-slate-900 to-slate-950" />
                )}
                <button type="button" onClick={onBack} className="absolute top-4 left-4 z-10 flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-950/70 backdrop-blur text-xs font-bold uppercase tracking-widest text-slate-200 hover:text-white transition-colors">
                    <i className="fa-solid fa-arrow-left" aria-hidden /> Back
                </button>
                <div className="absolute bottom-0 inset-x-0 p-4 sm:p-6">
                    <span className={`text-[10px] font-black uppercase tracking-widest rounded px-2 py-0.5 border ${course.delivery === 'self_paced' ? 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' : 'text-sky-300 bg-sky-500/15 border-sky-500/30'}`}>
                        {course.delivery === 'self_paced' ? 'Self-paced' : 'Cohort'}
                    </span>
                    <h1 className="text-2xl sm:text-3xl font-black text-white mt-2 drop-shadow">{course.title}</h1>
                </div>
            </div>

            <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
                {/* Meta row */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    {course.instructors.length > 0 && (
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Instructors</span>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                                {course.instructors.map(ins => (
                                    <span key={ins.id} className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                                        {ins.avatarUrl ? <img src={ins.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover" /> : <i className="fa-solid fa-circle-user text-slate-500" aria-hidden />}
                                        {ins.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {course.certification && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-amber-300"><i className="fa-solid fa-certificate" aria-hidden />Awards {course.certification.name}</span>
                    )}
                    <span className="text-xs text-slate-500">{course.modules.length} module{course.modules.length === 1 ? '' : 's'} · {totalLessons} lesson{totalLessons === 1 ? '' : 's'}</span>
                </div>

                {course.description && <p className="text-sm text-slate-300 whitespace-pre-wrap">{course.description}</p>}

                {/* Enrol / sessions */}
                {course.delivery === 'self_paced' ? (
                    <div className="rounded-xl border border-purple-500/25 bg-purple-500/5 p-4 flex items-center gap-4">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-white">{alreadySelfEnrolled ? 'You are enrolled' : gated ? 'Enrolment by approval' : 'Learn at your own pace'}</p>
                            <p className="text-[11px] text-slate-500 mt-0.5">{alreadySelfEnrolled ? 'Continue from My Learning whenever suits you.' : gated ? 'Ask the instructors for a seat; you will be notified when they decide.' : 'Enrol any time and work through the curriculum at your own pace.'}</p>
                        </div>
                        {alreadySelfEnrolled ? (
                            <span className="shrink-0 text-xs font-bold uppercase tracking-widest text-emerald-400"><i className="fa-solid fa-circle-check mr-1.5" aria-hidden />Enrolled</span>
                        ) : gated ? (
                            <SeatRequestControl
                                request={selfPacedSession ? myRequests.get(selfPacedSession.id) : undefined}
                                busy={busy || !selfPacedSession}
                                onRequest={(m) => selfPacedSession && onRequest(selfPacedSession.id, m)}
                                onCancel={onCancelRequest}
                            />
                        ) : (
                            <button type="button" disabled={!selfPacedSession || busy} onClick={() => selfPacedSession && onEnrol(selfPacedSession.id)}
                                className="shrink-0 px-5 py-2.5 text-xs font-black uppercase tracking-widest rounded-lg bg-purple-600 hover:bg-purple-500 text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed">
                                {busy ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Enrol & Start'}
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="space-y-2">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Upcoming Sessions</p>
                        {sessions.length === 0 ? (
                            <p className="text-xs text-slate-500 italic bg-slate-900/40 border border-slate-800 rounded-lg p-4 text-center">No sessions are open for enrolment right now. Check back soon.</p>
                        ) : sessions.map(s => {
                            const full = s.capacity != null && s.enrollmentCount >= s.capacity;
                            const enrolled = enrolledSessionIds.has(s.id);
                            const canEnrol = s.enrollmentOpen && !full && !enrolled;
                            return (
                                <div key={s.id} className="flex items-center gap-3 bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-white truncate">{s.title}</p>
                                        <p className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                                            {s.startsAt && <span><i className="fa-solid fa-calendar mr-1" aria-hidden />{new Date(s.startsAt).toLocaleString()}</span>}
                                            {s.location && <span><i className="fa-solid fa-location-dot mr-1" aria-hidden />{s.location}</span>}
                                            <span><i className="fa-solid fa-users mr-1" aria-hidden />{s.enrollmentCount}{s.capacity != null ? ` / ${s.capacity}` : ''}</span>
                                        </p>
                                    </div>
                                    {enrolled ? (
                                        <span className="shrink-0 text-[11px] font-bold uppercase tracking-widest text-emerald-400"><i className="fa-solid fa-circle-check mr-1" aria-hidden />Enrolled</span>
                                    ) : gated ? (
                                        // Capacity still applies to a gated seat, but it is the
                                        // APPROVER who is stopped by it, not the asker — a full
                                        // session can still take requests against a later drop-out.
                                        <SeatRequestControl request={myRequests.get(s.id)} busy={busy || !s.enrollmentOpen} compact
                                            onRequest={(m) => onRequest(s.id, m)} onCancel={onCancelRequest} />
                                    ) : (
                                        <button type="button" onClick={() => canEnrol && !busy && onEnrol(s.id)} disabled={!canEnrol || busy}
                                            className="shrink-0 px-4 py-2 text-[11px] font-black uppercase tracking-widest rounded-lg bg-purple-600 hover:bg-purple-500 text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed">
                                            {full ? 'Full' : busy ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Enrol'}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                <ModuleAccordion modules={course.modules} />

                {course.outcomes.length > 0 && (
                    <div className="space-y-2">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Learning Outcomes</p>
                        <ul className="space-y-1.5">
                            {course.outcomes.map(o => (
                                <li key={o.id} className="flex items-start gap-2 text-xs text-slate-400">
                                    <i className="fa-solid fa-bullseye text-purple-400/70 mt-0.5" aria-hidden />
                                    <span>{o.title}{o.required && <span className="text-slate-600"> · required</span>}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
};
