
import React, { useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { JobPostingStatus, ServiceRequestStatus, ApplicationStatus } from '../../../types';
import AwardIcon from '../../common/AwardIcon';
import { MemberIdCard } from '../../shared/ui';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

interface OverviewTabProps {
    setActiveTab: (tab: string) => void;
}

// Probation banner. Hoisted to module scope (was an in-JSX IIFE the React
// Compiler can't optimize). `now` is captured by the caller and passed in so
// this stays a pure render of its props.
const ProbationBanner: React.FC<{
    probationEnd: string;
    probationStart?: string;
    now: number;
    fmt: ReturnType<typeof useFormatDate>;
}> = ({ probationEnd, probationStart, now, fmt }) => {
    const end = new Date(probationEnd);
    const start = probationStart ? new Date(probationStart) : null;
    const daysLeft = Math.ceil((end.getTime() - now) / (1000 * 60 * 60 * 24));
    const isOverdue = daysLeft <= 0;
    const progress = start ? Math.min(100, Math.round(((now - start.getTime()) / (end.getTime() - start.getTime())) * 100)) : 100;

    return (
        <div className={`border rounded-xl p-5 relative overflow-hidden ${isOverdue ? 'bg-red-950/20 border-red-500/30' : 'bg-amber-950/20 border-amber-500/30'}`}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isOverdue ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>
                    <i className="fa-solid fa-hourglass-half"></i>
                </div>
                <div className="flex-1 min-w-0">
                    <p className={`text-[10px] font-black uppercase tracking-widest ${isOverdue ? 'text-red-300' : 'text-amber-300'}`}>
                        {isOverdue ? 'Probation Review Pending' : 'Probation Period Active'}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                        {isOverdue
                            ? `Your probation ended ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? 's' : ''} ago. A review is pending.`
                            : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining — ends ${fmt.date(end.toISOString())}`
                        }
                    </p>
                    <div className="mt-2.5 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all ${isOverdue ? 'bg-red-500' : daysLeft <= 7 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(progress, 100)}%` }}
                        ></div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const OverviewTab: React.FC<OverviewTabProps> = ({ setActiveTab }) => {
    const { currentUser, hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { hydratedServiceRequests } = useData();
    const { hrJobs, hrApplicants, hrInterviews } = useHR();
    const { setIsManageSpecializationsModalOpen, openTransferModal, openRequestClearanceModal } = useModalRegistry();

    const isHR = hasPermission('hr:recruiter') || hasPermission('hr:manager') || hasPermission('hr:admin');

    // Capture "now" once at mount so the timeline/probation derivations stay pure
    // across re-renders (reading the clock during render is impure). This view has
    // no live ticking requirement — the value is stable for the session.
    const [now] = useState(() => Date.now());

    const stats = useMemo(() => {
        const myMissions = hydratedServiceRequests.filter(
            r => r.assignedMemberIds.includes(currentUser?.id || 0)
        );
        const myCompletedMissions = myMissions.filter(r => r.status === ServiceRequestStatus.Success);
        const totalUec = myCompletedMissions.reduce((sum, r) => sum + (r.uecEarned || 0), 0);
        const ratedMissions = myMissions.filter(r => r.rated && r.clientRating !== undefined && r.clientRating !== null);
        let averageRating = currentUser?.averageRating || 0;

        if (ratedMissions.length > 0) {
            const sumRating = ratedMissions.reduce((acc, r) => acc + (r.clientRating || 0), 0);
            averageRating = sumRating / ratedMissions.length;
        }

        let pendingCases = 0;
        let activeInterviews = 0;
        let openVacancies = 0;

        if (isHR) {
            pendingCases = hrApplicants.filter(a => a.status === ApplicationStatus.Applied || a.status === ApplicationStatus.Screening).length;
            activeInterviews = hrInterviews.filter(i => i.status === 'Scheduled').length;
            openVacancies = hrJobs.filter(j => j.status === JobPostingStatus.Open).length;
        }

        return { totalUec, averageRating, pendingCases, activeInterviews, openVacancies, completedCount: myCompletedMissions.length };
    }, [hydratedServiceRequests, currentUser, hrApplicants, hrJobs, hrInterviews, isHR]);

    const tenureStartIso = currentUser?.tenureStartDate || currentUser?.createdAt;
    const memberSince = useMemo(() => tenureStartIso ? new Date(tenureStartIso) : null, [tenureStartIso]);

    // Build a chronological career timeline from the user's own record.
    // Uses only data already present on currentUser — no extra fetches.
    const careerEvents = useMemo(() => {
        type Evt = { id: string; date: Date; icon: string; tint: string; title: string; subtitle?: string };
        const events: Evt[] = [];

        (currentUser?.commendations || []).forEach(c => {
            if (!c.awardedAt) return;
            events.push({
                id: `commend-${c.id}`,
                date: new Date(c.awardedAt),
                icon: c.icon || 'fa-solid fa-medal',
                tint: 'amber',
                title: `Awarded "${c.name}"`,
                subtitle: c.reason || (c.awardedBy ? `Issued by ${c.awardedBy.name}` : undefined),
            });
        });

        (currentUser?.certifications || []).forEach(c => {
            if (!c.awardedAt) return;
            events.push({
                id: `cert-${c.id}`,
                date: new Date(c.awardedAt),
                icon: c.icon || 'fa-solid fa-certificate',
                tint: 'sky',
                title: `Certified in ${c.name}`,
                subtitle: c.awardedBy ? `Issued by ${c.awardedBy.name}` : undefined,
            });
        });

        if (currentUser?.probationEnd) {
            const end = new Date(currentUser.probationEnd);
            if (end.getTime() <= now) {
                events.push({
                    id: 'probation-complete',
                    date: end,
                    icon: 'fa-solid fa-hourglass-end',
                    tint: 'emerald',
                    title: 'Probation Completed',
                });
            }
        }

        if (memberSince) {
            events.push({
                id: 'enlisted',
                date: memberSince,
                icon: 'fa-solid fa-user-plus',
                tint: 'slate',
                title: 'Enlisted',
                subtitle: currentUser?.rank?.name ? `as ${currentUser.rank.name}` : undefined,
            });
        }

        return events.sort((a, b) => b.date.getTime() - a.date.getTime());
    }, [currentUser, memberSince, now]);

    const tintMap: Record<string, { border: string; bg: string; text: string }> = {
        amber:   { border: 'border-amber-500/30',   bg: 'bg-amber-500/10',   text: 'text-amber-300' },
        sky:     { border: 'border-sky-500/30',     bg: 'bg-sky-500/10',     text: 'text-sky-300' },
        emerald: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-300' },
        slate:   { border: 'border-slate-600',      bg: 'bg-slate-800',      text: 'text-slate-400' },
    };

    return (
        <div className="animate-fade-in flex flex-col lg:flex-row gap-6">
            {/* Main body (left column) */}
            <div className="flex-1 min-w-0 space-y-6 order-2 lg:order-1">
                {/* Probation Banner */}
                {currentUser?.probationEnd && (
                    <ProbationBanner
                        probationEnd={currentUser.probationEnd}
                        probationStart={currentUser.probationStart}
                        now={now}
                        fmt={fmt}
                    />
                )}

                {/* HR Command Center (Conditional) */}
                {isHR && (
                    <div>
                        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 px-1">HR Command Center</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <button
                                onClick={() => setActiveTab('case-management')}
                                className="relative flex items-center gap-4 bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-5 text-left hover:border-indigo-500/40 hover:shadow-lg hover:shadow-indigo-900/20 transition-all group overflow-hidden"
                            >
                                <div className="w-12 h-12 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-300 shrink-0">
                                    <i className="fa-solid fa-folder-open text-lg"></i>
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black text-indigo-300 uppercase tracking-widest">Case Files</p>
                                    <p className="text-2xl font-black text-white tabular-nums mt-0.5">{stats.pendingCases}</p>
                                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Pending Review</p>
                                </div>
                            </button>

                            <button
                                onClick={() => setActiveTab('manage-interviews')}
                                className="relative flex items-center gap-4 bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-5 text-left hover:border-sky-500/40 hover:shadow-lg hover:shadow-sky-900/20 transition-all group overflow-hidden"
                            >
                                <div className="w-12 h-12 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-300 shrink-0">
                                    <i className="fa-solid fa-calendar-check text-lg"></i>
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black text-sky-300 uppercase tracking-widest">Interviews</p>
                                    <p className="text-2xl font-black text-white tabular-nums mt-0.5">{stats.activeInterviews}</p>
                                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Scheduled</p>
                                </div>
                            </button>

                            <button
                                onClick={() => setActiveTab('gazette')}
                                className="relative flex items-center gap-4 bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-5 text-left hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-900/20 transition-all group overflow-hidden"
                            >
                                <div className="w-12 h-12 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-300 shrink-0">
                                    <i className="fa-solid fa-newspaper text-lg"></i>
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black text-emerald-300 uppercase tracking-widest">Vacancies</p>
                                    <p className="text-2xl font-black text-white tabular-nums mt-0.5">{stats.openVacancies}</p>
                                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Open Positions</p>
                                </div>
                            </button>
                        </div>
                    </div>
                )}

                {/* Service Record — inline strip */}
                <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl px-4 sm:px-5 py-3.5">
                    <div className="flex items-center flex-wrap gap-x-5 sm:gap-x-8 gap-y-3">
                        <div className="flex items-center gap-2.5">
                            <i className="fa-solid fa-star text-amber-300 text-sm"></i>
                            <span className="text-lg font-black text-white tabular-nums leading-none">{currentUser?.reputation}</span>
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black">Reputation</span>
                        </div>
                        <div className="h-5 w-px bg-slate-700/80 hidden sm:block"></div>
                        <div className="flex items-center gap-2.5">
                            <i className="fa-solid fa-coins text-lime-300 text-sm"></i>
                            <span className="text-lg font-black text-white tabular-nums font-mono leading-none">
                                {stats.totalUec >= 1000000 ? `${(stats.totalUec / 1000000).toFixed(1)}M` : stats.totalUec >= 1000 ? `${(stats.totalUec / 1000).toFixed(1)}k` : stats.totalUec}
                            </span>
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black">aUEC</span>
                        </div>
                        <div className="h-5 w-px bg-slate-700/80 hidden sm:block"></div>
                        <div className="flex items-center gap-2.5">
                            <i className="fa-solid fa-check-double text-emerald-300 text-sm"></i>
                            <span className="text-lg font-black text-white tabular-nums leading-none">{stats.completedCount}</span>
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black">Missions</span>
                        </div>
                        <div className="h-5 w-px bg-slate-700/80 hidden sm:block"></div>
                        <div className="flex items-center gap-2.5">
                            <i className="fa-solid fa-thumbs-up text-sky-300 text-sm"></i>
                            <span className="text-lg font-black text-white tabular-nums leading-none">{stats.averageRating.toFixed(1)}</span>
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black">Avg Rating</span>
                        </div>
                    </div>
                </div>

                {/* Career Timeline */}
                <div>
                    <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 px-1">Career Timeline</h3>
                    <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl p-5">
                        {careerEvents.length > 0 ? (
                            <ol className="relative border-l border-slate-800 ml-3 space-y-5">
                                {careerEvents.map(e => {
                                    const t = tintMap[e.tint] || tintMap.slate;
                                    return (
                                        <li key={e.id} className="relative pl-6 min-w-0">
                                            <span className={`absolute left-[-13px] top-0 w-6 h-6 rounded-full flex items-center justify-center border ${t.border} ${t.bg} ${t.text} ring-4 ring-slate-900/60`}>
                                                <i className={`${e.icon} text-[10px]`}></i>
                                            </span>
                                            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 sm:gap-3 min-w-0">
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-bold text-white leading-tight wrap-break-word">{e.title}</p>
                                                    {e.subtitle && (
                                                        <p className="text-xs text-slate-400 mt-0.5 line-clamp-2 wrap-break-word">{e.subtitle}</p>
                                                    )}
                                                </div>
                                                <time className="text-[10px] text-slate-500 uppercase tracking-widest font-black tabular-nums shrink-0 sm:mt-0.5 sm:whitespace-nowrap">
                                                    {fmt.date(e.date.toISOString())}
                                                </time>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ol>
                        ) : (
                            <p className="text-sm text-slate-500 italic text-center py-4">No career events on record yet.</p>
                        )}
                    </div>
                </div>
            </div>

            {/* Right sidebar (org ID card + quick options) */}
            <aside className="lg:w-80 lg:shrink-0 space-y-4 order-1 lg:order-2">
                {currentUser && <MemberIdCard user={currentUser} accent="emerald" />}

                {/* Specializations — pill strip */}
                <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Specializations</h3>
                        <button
                            onClick={() => setIsManageSpecializationsModalOpen(true)}
                            className="text-[10px] font-black text-emerald-400 hover:text-emerald-300 uppercase tracking-widest transition-colors"
                        >
                            Manage
                        </button>
                    </div>
                    <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl p-3">
                        {currentUser?.specializations && currentUser.specializations.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {currentUser.specializations.map(spec => (
                                    <span
                                        key={spec.id}
                                        title={spec.description || spec.name}
                                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold"
                                    >
                                        <AwardIcon imageUrl={spec.imageUrl} icon={spec.icon} fallbackIcon="fa-solid fa-star" className="text-[9px] w-2.5 h-2.5 inline-block" alt={spec.name} />
                                        <span className="truncate max-w-[140px]">{spec.name}</span>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <button
                                onClick={() => setIsManageSpecializationsModalOpen(true)}
                                className="w-full py-2 text-center text-xs text-slate-500 italic hover:text-emerald-400 transition-colors"
                            >
                                <i className="fa-solid fa-tags mr-1.5"></i>None yet — click to choose
                            </button>
                        )}
                    </div>
                </div>

                {/* Quick Options */}
                <div>
                    <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 px-1">Quick Options</h3>
                    <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden divide-y divide-slate-800/80">
                        <button
                            onClick={() => setActiveTab('gazette')}
                            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/60 transition-colors group"
                        >
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-300 shrink-0">
                                <i className="fa-solid fa-briefcase text-sm"></i>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-white leading-tight">Job Gazette</p>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider">View &amp; apply</p>
                            </div>
                            <i className="fa-solid fa-chevron-right text-slate-600 group-hover:text-slate-400 text-xs"></i>
                        </button>
                        <button
                            onClick={openTransferModal}
                            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/60 transition-colors group"
                        >
                            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-300 shrink-0">
                                <i className="fa-solid fa-right-left text-sm"></i>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-white leading-tight">Transfer Unit</p>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider">Request change</p>
                            </div>
                            <i className="fa-solid fa-chevron-right text-slate-600 group-hover:text-slate-400 text-xs"></i>
                        </button>
                        <button
                            onClick={openRequestClearanceModal}
                            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/60 transition-colors group"
                        >
                            <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-300 shrink-0">
                                <i className="fa-solid fa-user-shield text-sm"></i>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-white leading-tight">Clearance</p>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider">Request access</p>
                            </div>
                            <i className="fa-solid fa-chevron-right text-slate-600 group-hover:text-slate-400 text-xs"></i>
                        </button>
                        <button
                            onClick={() => setActiveTab('my-applications')}
                            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/60 transition-colors group"
                        >
                            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-300 shrink-0">
                                <i className="fa-solid fa-file-lines text-sm"></i>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-white leading-tight">My Applications</p>
                                <p className="text-[10px] text-slate-500 uppercase tracking-wider">Track status</p>
                            </div>
                            <i className="fa-solid fa-chevron-right text-slate-600 group-hover:text-slate-400 text-xs"></i>
                        </button>
                    </div>
                </div>
            </aside>
        </div>
    );
};

export default OverviewTab;
