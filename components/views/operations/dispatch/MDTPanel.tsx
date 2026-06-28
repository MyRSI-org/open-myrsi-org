import React, { useEffect, useMemo, useState } from 'react';
import { useFormatDate } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';
import { useMembers } from '../../../../contexts/MembersContext';
import type {
    DossierData,
    HydratedIntelligenceReport,
    HydratedWarrant,
    HydratedServiceRequest,
    User,
    IntelThreatLevel,
    WarrantStatus,
} from '../../../../types';
import HeroStat from '../../../shared/ui/HeroStat';
import EmptyState from '../../../shared/ui/EmptyState';
import IntelligenceReportCard from '../../intel/IntelligenceReportCard';
import RapSheetHeader from './RapSheetHeader';
import RapSheetAlerts from './RapSheetAlerts';
import MdtRequestRow from './MdtRequestRow';
import MdtWarrantRow from './MdtWarrantRow';
import { useModalRegistry } from '../../../../contexts/ModalRegistryContext';

interface Props {
    target: string | null;
    canViewIntel: boolean;
    onOpenRequest: (req: HydratedServiceRequest) => void;
    onChangeTarget: (handle: string) => void;
}

type RapTab = 'overview' | 'warrants' | 'intel' | 'requests';

export default function MDTPanel({ target, canViewIntel, onOpenRequest, onChangeTarget }: Props) {
    const { rpcAction } = useData();
    const { allUsers } = useMembers();
    const { openIntelReportWindow } = useModalRegistry();

    const [dossier, setDossier] = useState<DossierData | null>(null);
    // Lazy-init to the mount-time fetch decision so a valid target shows the
    // loading spinner from the first paint (the fetch effect below resolves it),
    // matching the old effect that set loading true at its head. On later target
    // changes the render-time tracker re-primes this.
    const [loading, setLoading] = useState(() => !!target && canViewIntel);
    const [error, setError] = useState<string | null>(null);
    const [rapTab, setRapTab] = useState<RapTab>('overview');
    const [formQuery, setFormQuery] = useState('');

    // Resolve the subject User from allUsers if the handle belongs to a
    // registered member. Missing match is fine — the RAP sheet still renders
    // from dossier-only data.
    const subject: User | undefined = useMemo(() => {
        if (!target) return undefined;
        const h = target.toLowerCase();
        return allUsers.find(u => (u.rsiHandle || '').toLowerCase() === h);
    }, [target, allUsers]);

    // Reset-on-change tracker. We re-seed the editable view state during render
    // (React's "adjust state during render" pattern) so it never lags a frame
    // behind the effect.
    //   * rapTab -> 'overview' when the subject handle changes, so the operator
    //     sees the overview first rather than lingering on Requests from the
    //     last query (was a [target]-only effect, so it is gated on target).
    //   * dossier/error cleared and loading primed when target OR canViewIntel
    //     changes (matching the old fetch effect's [target, canViewIntel] deps)
    //     so the previous subject's RAP sheet can't flash while the new fetch
    //     (below) is pending. When the subject is absent or intel access is
    //     denied there is nothing to fetch, so loading stays false; otherwise it
    //     is primed true to match the old synchronous setLoading(true) at the
    //     head of the fetch effect.
    const [prevTarget, setPrevTarget] = useState(target);
    const [prevCanViewIntel, setPrevCanViewIntel] = useState(canViewIntel);
    if (target !== prevTarget || canViewIntel !== prevCanViewIntel) {
        if (target !== prevTarget) setRapTab('overview');
        setPrevTarget(target);
        setPrevCanViewIntel(canViewIntel);
        setDossier(null);
        setError(null);
        setLoading(!!target && canViewIntel);
    }

    // Fetch dossier when target changes. Only runs for users with intel view;
    // otherwise the panel renders the permission-denied placeholder below. The
    // synchronous resets/priming above are handled in the render-time tracker;
    // this effect performs ONLY the async fetch and its async state writes.
    useEffect(() => {
        if (!target || !canViewIntel) return;
        let cancelled = false;
        rpcAction('intel:get_dossier', { targetId: target })
            .then((data: any) => { if (!cancelled) setDossier(data || null); })
            .catch((err: any) => { if (!cancelled) setError(err?.message || 'Failed to load dossier.'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [target, canViewIntel, rpcAction]);

    // Highest-severity threat in the dossier. Computed above any conditional returns so the
    // hook count stays stable across the empty/permission-denied/loaded states.
    const highestThreat: IntelThreatLevel | null = useMemo(() => {
        const reports = dossier?.reports || [];
        const order: IntelThreatLevel[] = ['Critical', 'High', 'Medium', 'Low'] as IntelThreatLevel[];
        for (const level of order) {
            if (reports.some(r => r.threatLevel === level)) return level;
        }
        return null;
    }, [dossier]);

    if (!canViewIntel) {
        return (
            <div className="px-4 sm:px-8 py-16">
                <EmptyState
                    icon="fa-lock"
                    accent="cyan"
                    heading="Intel access required"
                    description="The MDT requires the intel:view permission. Ask an admin to grant it, or use CAD to manage the live queue."
                />
            </div>
        );
    }

    if (!target) {
        return (
            <div className="px-4 sm:px-8 py-20">
                <div className="max-w-xl mx-auto text-center">
                    <i className="fa-solid fa-magnifying-glass-plus text-5xl text-cyan-500/30 mb-5" />
                    <h2 className="text-xl font-black text-white tracking-tight">Mobile Data Terminal</h2>
                    <p className="mt-2 text-sm text-slate-400">
                        Search any RSI handle to pull a subject RAP sheet — warrants, intel reports, request history, and reputation in one view.
                    </p>
                    <form
                        onSubmit={(e) => { e.preventDefault(); if (formQuery.trim()) onChangeTarget(formQuery.trim()); }}
                        className="mt-6 flex gap-2"
                    >
                        <input
                            autoFocus
                            type="search"
                            value={formQuery}
                            onChange={(e) => setFormQuery(e.target.value)}
                            placeholder="e.g. ShadowRunner_07"
                            className="flex-1 bg-slate-900/60 text-white px-4 py-3 rounded-lg border border-cyan-500/30 placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 outline-hidden"
                        />
                        <button
                            type="submit"
                            disabled={!formQuery.trim()}
                            className="px-5 py-3 rounded-lg text-xs font-bold uppercase tracking-widest text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
                        >
                            Run MDT
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    const reports = dossier?.reports || [];
    const warrants = dossier?.warrants || [];
    const requests: HydratedServiceRequest[] = (dossier?.requests || []) as HydratedServiceRequest[];
    const hasAnyData = reports.length + warrants.length + requests.length > 0;

    const activeWarrants = warrants.filter(w => (w.status as WarrantStatus) === 'Active' || (w.status as WarrantStatus) === 'Standing');

    return (
        <div className="px-4 sm:px-8 py-6">
            <div className="max-w-5xl mx-auto space-y-6">
                <RapSheetHeader
                    handle={target}
                    subject={subject}
                    onChangeTarget={onChangeTarget}
                />

                <RapSheetAlerts
                    activeWarrants={activeWarrants}
                    highestThreat={highestThreat}
                    subject={subject}
                />

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <HeroStat icon="fa-bullseye" label="Warrants" value={warrants.length} accent="red" emphasize={activeWarrants.length > 0} sub={activeWarrants.length > 0 ? `${activeWarrants.length} active` : 'None active'} />
                    <HeroStat icon="fa-folder-open" label="Intel Reports" value={reports.length} accent="rose" emphasize={highestThreat === 'Critical' || highestThreat === 'High'} sub={highestThreat ? `${highestThreat} max` : 'No reports'} />
                    <HeroStat icon="fa-file-invoice" label="Requests" value={requests.length} accent="sky" sub="As client" />
                    <HeroStat
                        icon="fa-scale-balanced"
                        label="Reputation"
                        value={subject ? subject.reputation ?? '—' : '—'}
                        sub={subject ? undefined : 'Unregistered'}
                        accent={!subject ? 'slate' : (subject.reputation ?? 50) <= 15 ? 'rose' : (subject.reputation ?? 50) >= 75 ? 'emerald' : 'slate'}
                        emphasize={!!subject && (subject.reputation ?? 100) <= 15}
                    />
                </div>

                <div className="border-b border-white/5">
                    <div className="flex gap-0 -mb-px overflow-x-auto custom-scrollbar">
                        {(['overview', 'warrants', 'intel', 'requests'] as RapTab[]).map(t => (
                            <button
                                key={t}
                                onClick={() => setRapTab(t)}
                                className={`flex items-center gap-2 px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                                    rapTab === t
                                        ? 'text-cyan-300 border-cyan-400'
                                        : 'text-slate-500 border-transparent hover:text-slate-300'
                                }`}
                            >
                                {t === 'overview' && <><i className="fa-solid fa-gauge-high"></i>Overview</>}
                                {t === 'warrants' && <><i className="fa-solid fa-bullseye"></i>Warrants {warrants.length > 0 && <span className="min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold bg-red-500/20 text-red-300 rounded-full flex items-center justify-center">{warrants.length}</span>}</>}
                                {t === 'intel' && <><i className="fa-solid fa-satellite-dish"></i>Intel {reports.length > 0 && <span className="min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold bg-rose-500/20 text-rose-300 rounded-full flex items-center justify-center">{reports.length}</span>}</>}
                                {t === 'requests' && <><i className="fa-solid fa-file-invoice"></i>Requests {requests.length > 0 && <span className="min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold bg-sky-500/20 text-sky-300 rounded-full flex items-center justify-center">{requests.length}</span>}</>}
                            </button>
                        ))}
                    </div>
                </div>

                {loading && (
                    <div className="flex items-center justify-center py-16">
                        <i className="fa-solid fa-circle-notch fa-spin text-cyan-400 text-3xl" aria-hidden />
                    </div>
                )}

                {!loading && error && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
                        <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                        {error}
                    </div>
                )}

                {!loading && !error && !hasAnyData && (
                    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                        <EmptyState
                            icon="fa-folder-open"
                            accent="cyan"
                            heading="No records on file"
                            description={`No intel, warrants, or request history on file for "${target}".`}
                        />
                    </div>
                )}

                {!loading && !error && hasAnyData && (
                    <>
                        {rapTab === 'overview' && (
                            <OverviewTab
                                reports={reports}
                                warrants={warrants}
                                requests={requests}
                                summary={dossier?.cachedSummary}
                                summaryDate={dossier?.cachedSummaryDate}
                                onOpenReport={openIntelReportWindow}
                                onOpenRequest={onOpenRequest}
                            />
                        )}
                        {rapTab === 'warrants' && (
                            warrants.length === 0
                                ? <EmptyStateInline icon="fa-bullseye" heading="No warrants on file" />
                                : (
                                    <div className="space-y-2">
                                        {warrants.map(w => <MdtWarrantRow key={w.id} warrant={w} />)}
                                    </div>
                                )
                        )}
                        {rapTab === 'intel' && (
                            reports.length === 0
                                ? <EmptyStateInline icon="fa-satellite-dish" heading="No intel reports" />
                                : (
                                    <div className="space-y-3">
                                        {reports.map(r => (
                                            <IntelligenceReportCard
                                                key={r.id}
                                                report={r}
                                                onClick={() => openIntelReportWindow(r)}
                                                onViewDossier={(id: string) => onChangeTarget(id)}
                                            />
                                        ))}
                                    </div>
                                )
                        )}
                        {rapTab === 'requests' && (
                            requests.length === 0
                                ? <EmptyStateInline icon="fa-file-invoice" heading="No request history" />
                                : (
                                    <div className="space-y-2">
                                        {requests.map(r => (
                                            <MdtRequestRow key={r.id} request={r} onClick={() => onOpenRequest(r)} />
                                        ))}
                                    </div>
                                )
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// Overview tab: most recent of each + cached summary.
function OverviewTab({
    reports, warrants, requests, summary, summaryDate, onOpenReport, onOpenRequest,
}: {
    reports: HydratedIntelligenceReport[];
    warrants: HydratedWarrant[];
    requests: HydratedServiceRequest[];
    summary?: string;
    summaryDate?: string;
    onOpenReport: (r: HydratedIntelligenceReport) => void;
    onOpenRequest: (r: HydratedServiceRequest) => void;
}) {
    const fmt = useFormatDate();
    const recentWarrants = [...warrants].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime()).slice(0, 3);
    const recentReports = [...reports].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 3);
    const recentRequests = [...requests].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 3);

    return (
        <div className="space-y-6">
            {summary && (
                <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-5">
                    <div className="flex items-center gap-2 mb-2">
                        <i className="fa-solid fa-robot text-cyan-400"></i>
                        <span className="text-[10px] font-black text-cyan-300 uppercase tracking-[0.2em]">Summary</span>
                        {summaryDate && (
                            <span className="text-[10px] text-slate-500 font-mono ml-auto">
                                {fmt.date(summaryDate)}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{summary}</p>
                </div>
            )}

            {recentWarrants.length > 0 && (
                <div>
                    <h3 className="text-[10px] font-black text-red-300 uppercase tracking-[0.25em] mb-2">Recent Cautions</h3>
                    <div className="space-y-2">
                        {recentWarrants.map(w => <MdtWarrantRow key={w.id} warrant={w} />)}
                    </div>
                </div>
            )}

            {recentReports.length > 0 && (
                <div>
                    <h3 className="text-[10px] font-black text-rose-300 uppercase tracking-[0.25em] mb-2">Recent Intel</h3>
                    <div className="space-y-3">
                        {recentReports.map(r => (
                            <IntelligenceReportCard
                                key={r.id}
                                report={r}
                                onClick={() => onOpenReport(r)}
                                onViewDossier={() => {}}
                            />
                        ))}
                    </div>
                </div>
            )}

            {recentRequests.length > 0 && (
                <div>
                    <h3 className="text-[10px] font-black text-sky-300 uppercase tracking-[0.25em] mb-2">Recent Requests</h3>
                    <div className="space-y-2">
                        {recentRequests.map(r => (
                            <MdtRequestRow key={r.id} request={r} onClick={() => onOpenRequest(r)} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function EmptyStateInline({ icon, heading }: { icon: string; heading: string }) {
    return (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 py-10 text-center">
            <i className={`fa-solid ${icon} text-3xl text-slate-600 mb-3`}></i>
            <p className="text-sm text-slate-500 font-bold">{heading}</p>
        </div>
    );
}
