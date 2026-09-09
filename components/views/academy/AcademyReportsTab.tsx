// AcademyReportsTab — the four Learning-Manager reports (academy:manage).
//
// These read back the sign-off trail the rest of the module has always WRITTEN and
// nothing ever displayed: completed_at, certified_by, recommended_at. Four sub-reports
// behind one selector:
//   · Completions      — who finished what, in a window the manager picks.
//   · Course activity  — per-course rollup; which courses are used, which are stuck.
//   · Certification holders — everyone holding one certification.
//   · Member transcript — one member's whole training record.
//
// Every report is fetched ON DEMAND from its own academy:report_* action. None ride
// the boot payload or the academy slice: they are manager-only projections of other
// people's records, and the read is where that gate belongs.

import React, { useCallback, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useNotification } from '../../../contexts/NotificationContext';
import type {
    AcademyCompletionRow, AcademyCourseActivityReport, AcademyCertHoldersReport, AcademyTranscript,
} from '../../../types';

const ERR_TOAST = 'bg-red-500/10 text-red-400 border-red-500/50';
const INPUT = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-hidden focus:ring-2 focus:ring-purple-500/50';
const CARD = 'bg-slate-800/40 border border-slate-700/60 rounded-xl';

type ReportId = 'completions' | 'activity' | 'holders' | 'transcript';

const REPORTS: Array<{ id: ReportId; label: string; icon: string; blurb: string }> = [
    { id: 'completions', label: 'Completions', icon: 'fa-flag-checkered', blurb: 'Who finished a course, and who signed it off.' },
    { id: 'activity', label: 'Course Activity', icon: 'fa-chart-simple', blurb: 'Per-course enrolment rollup and sign-off backlog.' },
    { id: 'holders', label: 'Certification Holders', icon: 'fa-award', blurb: 'Everyone holding a given certification.' },
    { id: 'transcript', label: 'Member Transcript', icon: 'fa-id-card', blurb: "One member's full training record." },
];

const Empty: React.FC<{ message: string }> = ({ message }) => (
    <p className="text-xs text-slate-500 italic py-10 text-center">{message}</p>
);

const Spinner: React.FC = () => (
    <div className="py-10 text-center text-slate-500"><i className="fa-solid fa-spinner animate-spin" aria-hidden /></div>
);

const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : '—');

// ════════════════════════════════════════════════════════════════════════════

const CompletionsReport: React.FC = () => {
    const { rpcAction } = useData();
    const { addToast } = useNotification();
    const [sinceDays, setSinceDays] = useState(90);
    const [rows, setRows] = useState<AcademyCompletionRow[] | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (days: number) => {
        setLoading(true);
        try {
            const r = await rpcAction('academy:report_completions', { sinceDays: days }) as AcademyCompletionRow[];
            setRows(Array.isArray(r) ? r : []);
        } catch (err: unknown) {
            addToast('Report Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: err instanceof Error ? err.message : undefined });
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [rpcAction, addToast]);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="ac-completions-window" className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Window</label>
                <select id="ac-completions-window" value={sinceDays} onChange={e => setSinceDays(Number(e.target.value))} className={INPUT}>
                    <option value={30}>Last 30 days</option>
                    <option value={90}>Last 90 days</option>
                    <option value={180}>Last 180 days</option>
                    <option value={365}>Last year</option>
                </select>
                <button type="button" disabled={loading} onClick={() => void load(sinceDays)}
                    className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-white rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700">
                    Run
                </button>
            </div>
            {loading ? <Spinner /> : rows === null ? (
                <Empty message="Pick a window and run the report." />
            ) : rows.length === 0 ? (
                <Empty message="No completions in that window." />
            ) : (
                <div className={`${CARD} overflow-x-auto`}>
                    <table className="w-full text-left text-sm">
                        <thead>
                            <tr className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-700/60">
                                <th className="px-4 py-2.5">Member</th>
                                <th className="px-4 py-2.5">Course</th>
                                <th className="px-4 py-2.5">Session</th>
                                <th className="px-4 py-2.5">Completed</th>
                                <th className="px-4 py-2.5">Signed off by</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.enrollmentId} className="border-b border-slate-800/60 last:border-0">
                                    <td className="px-4 py-2.5 text-white">{r.studentName || `#${r.studentId}`}{r.rsiHandle && <span className="text-slate-500 text-xs ml-1.5">{r.rsiHandle}</span>}</td>
                                    <td className="px-4 py-2.5 text-slate-300">{r.courseTitle || '—'}</td>
                                    <td className="px-4 py-2.5 text-slate-400">{r.sessionTitle || '—'}</td>
                                    <td className="px-4 py-2.5 text-slate-400">{fmtDate(r.completedAt)}</td>
                                    <td className="px-4 py-2.5 text-slate-400">{r.certifiedByName || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════

const ActivityReport: React.FC = () => {
    const { rpcAction } = useData();
    const { addToast } = useNotification();
    const [report, setReport] = useState<AcademyCourseActivityReport | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setReport(await rpcAction('academy:report_course_activity', {}) as AcademyCourseActivityReport);
        } catch (err: unknown) {
            addToast('Report Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: err instanceof Error ? err.message : undefined });
        } finally {
            setLoading(false);
        }
    }, [rpcAction, addToast]);

    return (
        <div className="space-y-3">
            <button type="button" disabled={loading} onClick={() => void load()}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-white rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700">
                Run
            </button>
            {loading ? <Spinner /> : !report ? (
                <Empty message="Run the report to see per-course activity." />
            ) : report.courses.length === 0 ? (
                <Empty message="No courses yet." />
            ) : (
                <>
                    {report.truncated && (
                        // Not decoration: the scan hit its cap, so every number below is a
                        // floor. Saying so is the difference between a report and a guess.
                        <p className="text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/25 rounded-lg px-3 py-2">
                            <i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden />
                            The enrolment scan hit its limit — these counts are a minimum, not a total.
                        </p>
                    )}
                    <div className={`${CARD} overflow-x-auto`}>
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-700/60">
                                    <th className="px-4 py-2.5">Course</th>
                                    <th className="px-4 py-2.5">Status</th>
                                    <th className="px-4 py-2.5 text-right">Sessions</th>
                                    <th className="px-4 py-2.5 text-right">Enrolled</th>
                                    <th className="px-4 py-2.5 text-right">In progress</th>
                                    <th className="px-4 py-2.5 text-right">Completed</th>
                                    <th className="px-4 py-2.5 text-right">Awaiting sign-off</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.courses.map(c => (
                                    <tr key={c.courseId} className="border-b border-slate-800/60 last:border-0">
                                        <td className="px-4 py-2.5 text-white">{c.courseTitle}</td>
                                        <td className="px-4 py-2.5 text-slate-400 text-xs uppercase tracking-widest">{c.status.replace('_', ' ')}</td>
                                        <td className="px-4 py-2.5 text-right text-slate-300">{c.sessions}</td>
                                        <td className="px-4 py-2.5 text-right text-slate-300">{c.enrolled}</td>
                                        <td className="px-4 py-2.5 text-right text-slate-300">{c.inProgress}</td>
                                        <td className="px-4 py-2.5 text-right text-slate-300">{c.completed}</td>
                                        <td className={`px-4 py-2.5 text-right font-bold ${c.awaitingCertification > 0 ? 'text-amber-400' : 'text-slate-600'}`}>{c.awaitingCertification}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[11px] text-slate-500">{report.totalEnrollments} enrolment{report.totalEnrollments === 1 ? '' : 's'} scanned.</p>
                </>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════

const HoldersReport: React.FC = () => {
    const { rpcAction, certifications } = useData();
    const { addToast } = useNotification();
    const [certId, setCertId] = useState<number | ''>('');
    const [report, setReport] = useState<AcademyCertHoldersReport | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (id: number) => {
        setLoading(true);
        try {
            setReport(await rpcAction('academy:report_cert_holders', { certificationId: id }) as AcademyCertHoldersReport);
        } catch (err: unknown) {
            addToast('Report Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: err instanceof Error ? err.message : undefined });
            setReport(null);
        } finally {
            setLoading(false);
        }
    }, [rpcAction, addToast]);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="ac-holders-cert" className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Certification</label>
                <select id="ac-holders-cert" value={certId} onChange={e => setCertId(e.target.value ? Number(e.target.value) : '')} className={INPUT}>
                    <option value="">Select…</option>
                    {certifications.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" disabled={loading || certId === ''} onClick={() => certId !== '' && void load(certId)}
                    className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-white rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700">
                    Run
                </button>
            </div>
            {loading ? <Spinner /> : !report ? (
                <Empty message="Pick a certification and run the report." />
            ) : report.holders.length === 0 ? (
                <Empty message="Nobody holds that certification yet." />
            ) : (
                <div className={`${CARD} overflow-x-auto`}>
                    <table className="w-full text-left text-sm">
                        <thead>
                            <tr className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-700/60">
                                <th className="px-4 py-2.5">Member</th>
                                <th className="px-4 py-2.5">Awarded</th>
                                <th className="px-4 py-2.5">Awarded by</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.holders.map(h => (
                                <tr key={h.userId} className="border-b border-slate-800/60 last:border-0">
                                    <td className="px-4 py-2.5 text-white flex items-center gap-2">
                                        {h.avatarUrl
                                            ? <img src={h.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
                                            : <span className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px] text-slate-400"><i className="fa-solid fa-user" aria-hidden /></span>}
                                        {h.name || `#${h.userId}`}
                                        {h.rsiHandle && <span className="text-slate-500 text-xs">{h.rsiHandle}</span>}
                                    </td>
                                    <td className="px-4 py-2.5 text-slate-400">{fmtDate(h.awardedAt)}</td>
                                    <td className="px-4 py-2.5 text-slate-400">{h.awardedByName || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════

const TranscriptReport: React.FC = () => {
    const { rpcAction } = useData();
    const { allUsers } = useMembers();
    const { addToast } = useNotification();
    const [query, setQuery] = useState('');
    const [report, setReport] = useState<AcademyTranscript | null>(null);
    const [loading, setLoading] = useState(false);

    const matches = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return allUsers.filter(u => u.name.toLowerCase().includes(q)).slice(0, 8);
    }, [allUsers, query]);

    const load = useCallback(async (targetUserId: number, name: string) => {
        setQuery(name);
        setLoading(true);
        try {
            setReport(await rpcAction('academy:report_member_transcript', { targetUserId }) as AcademyTranscript);
        } catch (err: unknown) {
            addToast('Report Failed', <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: err instanceof Error ? err.message : undefined });
            setReport(null);
        } finally {
            setLoading(false);
        }
    }, [rpcAction, addToast]);

    return (
        <div className="space-y-3">
            <div className="relative max-w-sm">
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search members" aria-label="Search members" className={`${INPUT} w-full`} />
                {matches.length > 0 && query.trim() && (!report || report.member.name.toLowerCase() !== query.trim().toLowerCase()) && (
                    <div className="absolute z-10 mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg overflow-hidden shadow-xl">
                        {matches.map(u => (
                            <button key={u.id} type="button" onClick={() => void load(u.id, u.name)}
                                className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-purple-500/10">
                                {u.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {loading ? <Spinner /> : !report ? (
                <Empty message="Search for a member to see their training record." />
            ) : (
                <div className="space-y-4">
                    <div className={`${CARD} p-4`}>
                        <p className="text-sm font-bold text-white">{report.member.name || `#${report.member.id}`}</p>
                        {report.certifications.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                                {report.certifications.map(c => (
                                    <span key={c.id} className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                                        {c.name}<span className="text-emerald-500/60 ml-1.5">{fmtDate(c.awardedAt)}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    {report.rows.length === 0 ? (
                        <Empty message="No enrolments on record." />
                    ) : report.rows.map(r => (
                        <div key={r.enrollmentId} className={`${CARD} p-4 space-y-2`}>
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <p className="text-sm font-bold text-white">{r.courseTitle || 'Course'}</p>
                                <span className="text-[10px] uppercase tracking-widest text-slate-500">{r.sessionTitle}</span>
                                <span className="text-[10px] uppercase tracking-widest text-purple-300">{r.status.replace('_', ' ')}</span>
                                <span className="text-[11px] text-slate-500 ml-auto">{fmtDate(r.enrolledAt)} → {fmtDate(r.completedAt)}</span>
                            </div>
                            <p className="text-[11px] text-slate-500">{r.lessonsCompleted} / {r.lessonsTotal} lessons</p>
                            {r.outcomes.length > 0 && (
                                <ul className="space-y-1">
                                    {r.outcomes.map(o => (
                                        <li key={o.title} className="flex items-center gap-2 text-xs">
                                            <i className={`fa-solid ${o.verdict === 'competent' ? 'fa-circle-check text-emerald-400' : o.verdict ? 'fa-circle-xmark text-amber-400' : 'fa-circle text-slate-700'} text-[10px]`} aria-hidden />
                                            <span className="text-slate-300">{o.title}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ════════════════════════════════════════════════════════════════════════════

export const ReportsTab: React.FC = () => {
    const [active, setActive] = useState<ReportId>('completions');
    const current = REPORTS.find(r => r.id === active) ?? REPORTS[0];

    return (
        <div className="space-y-4 animate-fade-in">
            <div className="flex flex-wrap gap-2">
                {REPORTS.map(r => (
                    <button key={r.id} type="button" onClick={() => setActive(r.id)}
                        className={`px-3 py-2 text-[11px] font-bold uppercase tracking-widest rounded-lg border transition-colors ${
                            active === r.id
                                ? 'bg-purple-500/10 text-purple-300 border-purple-500/40'
                                : 'bg-slate-800/40 text-slate-400 border-slate-700 hover:text-white'
                        }`}>
                        <i className={`fa-solid ${r.icon} mr-2`} aria-hidden />{r.label}
                    </button>
                ))}
            </div>
            <p className="text-xs text-slate-500">{current.blurb}</p>
            {active === 'completions' && <CompletionsReport />}
            {active === 'activity' && <ActivityReport />}
            {active === 'holders' && <HoldersReport />}
            {active === 'transcript' && <TranscriptReport />}
        </div>
    );
};

export default ReportsTab;
