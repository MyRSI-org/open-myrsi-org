
import React, { useMemo, useState, useEffect } from 'react';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { ServiceRequestStatus, User, OperationStatus, ConductRecordType, PositionHistoryEntry } from '../../../types';
import AwardIcon from '../../common/AwardIcon';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import EmptyState from '../../shared/ui/EmptyState';
import { MemberIdCard, getClearanceColor } from '../../shared/ui';
import { useNavigation } from '../../../contexts/NavigationContext';

const getStatusChipClass = (status: ServiceRequestStatus | OperationStatus) => {
    switch (status) {
        case ServiceRequestStatus.Success:
        case OperationStatus.Active:
            return 'bg-green-500/10 text-green-400 border-green-500/20';
        case ServiceRequestStatus.Failed:
        case ServiceRequestStatus.Cancelled:
        case ServiceRequestStatus.Refused:
        case ServiceRequestStatus.Aborted:
        case ServiceRequestStatus.GameError:
            return 'bg-red-500/10 text-red-400 border-red-500/20';
        case OperationStatus.Planning:
            return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
        case OperationStatus.Concluded:
            return 'bg-slate-600/20 text-slate-400 border-slate-600/20';
        default: return 'bg-slate-600/20 text-slate-400 border-slate-600/20';
    }
};

const getConductChipClass = (type: ConductRecordType) => {
    switch (type) {
        case ConductRecordType.Commendation: return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
        case ConductRecordType.Observation: return 'bg-sky-500/10 text-sky-400 border-sky-500/30';
        case ConductRecordType.Counseling: return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
        case ConductRecordType.Warning: return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
        case ConductRecordType.Infraction: return 'bg-red-500/10 text-red-400 border-red-500/30';
        default: return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
};

interface MyServiceRecordViewProps {
    user?: User;
    onBack?: () => void;
}

// Section card chrome shared with ProfileView and MyUnitView. Keeps the
// heading + icon + bordered body consistent across modern detail surfaces.
const SectionCard: React.FC<{
    title: string;
    icon: string;
    accent?: 'sky' | 'amber' | 'emerald' | 'purple' | 'rose';
    children: React.ReactNode;
    actions?: React.ReactNode;
    /** Extra classes on the outer card. Use to flex-fill within a parent column. */
    className?: string;
    /** Override body wrapper classes. Defaults to `p-5 space-y-3`. */
    bodyClassName?: string;
}> = ({ title, icon, accent = 'sky', children, actions, className = '', bodyClassName }) => {
    const accents = {
        sky: { bg: 'bg-sky-500/10', border: 'border-sky-500/30', text: 'text-sky-300' },
        amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-300' },
        emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300' },
        purple: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-300' },
        rose: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', text: 'text-rose-300' },
    } as const;
    const a = accents[accent];
    return (
        <div className={`bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden ${className}`}>
            <div className="px-5 py-3 border-b border-white/5 bg-white/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`h-8 w-8 rounded-lg ${a.bg} border ${a.border} flex items-center justify-center shrink-0`}>
                        <i className={`fa-solid ${icon} ${a.text} text-sm`} aria-hidden></i>
                    </div>
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-200 truncate">{title}</h3>
                </div>
                {actions && <div className="min-w-0">{actions}</div>}
            </div>
            <div className={bodyClassName ?? 'p-5 space-y-3'}>{children}</div>
        </div>
    );
};

// Skeleton placeholder used while we're still fetching the heavy user fields.
// Pulses subtly to indicate "data inbound" rather than "no data".
const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
    <div className={`bg-slate-800/40 border border-slate-800 rounded-lg animate-pulse ${className}`} aria-hidden />
);

type RecordType = 'REQUEST' | 'OPERATION' | 'CERTIFICATION' | 'COMMENDATION';

interface TimelineEvent {
    id: string;
    recordType: RecordType;
    date: string;
    title: string;
    /** Optional id-suffix or sub-label (e.g. truncated UUID) shown next to the type pill. */
    subId?: string;
    /** Status pill rendered to the right of the title row (only Request/Operation). */
    status?: ServiceRequestStatus | OperationStatus;
    /** Award reason (only Commendation) — rendered as italic line under title. */
    reason?: string;
    /** Click target — undefined makes the row non-interactive. */
    onClick?: () => void;
}

const TIMELINE_ACCENTS: Record<RecordType, { border: string; bg: string; text: string; icon: string; label: string }> = {
    REQUEST: { border: 'border-sky-500/30', bg: 'bg-sky-500/10', text: 'text-sky-300', icon: 'fa-clipboard-list', label: 'Service Request' },
    OPERATION: { border: 'border-purple-500/30', bg: 'bg-purple-500/10', text: 'text-purple-300', icon: 'fa-bullseye', label: 'Operation' },
    CERTIFICATION: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-300', icon: 'fa-certificate', label: 'Certification Awarded' },
    COMMENDATION: { border: 'border-amber-500/30', bg: 'bg-amber-500/10', text: 'text-amber-300', icon: 'fa-medal', label: 'Commendation Awarded' },
};

type FilterKey = 'all' | 'op' | 'req' | 'award';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'op', label: 'Operations' },
    { key: 'req', label: 'Requests' },
    { key: 'award', label: 'Awards' },
];

const matchesFilter = (event: TimelineEvent, filter: FilterKey): boolean => {
    if (filter === 'all') return true;
    if (filter === 'op') return event.recordType === 'OPERATION';
    if (filter === 'req') return event.recordType === 'REQUEST';
    if (filter === 'award') return event.recordType === 'CERTIFICATION' || event.recordType === 'COMMENDATION';
    return true;
};

const MyServiceRecordView: React.FC<MyServiceRecordViewProps> = ({ user: propUser, onBack }) => {
    const { currentUser, hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { hydratedServiceRequests, fetchUserDetail, getPositionHistory } = useData();
    const { allUsers } = useMembers();
    const { operations } = useOperations();
    const { viewRequestDetails, viewOperationDetails } = useNavigation();

    const [activeTab, setActiveTab] = useState<'dossier' | 'history' | 'position-history'>('dossier');
    const [filter, setFilter] = useState<FilterKey>('all');

    const targetId = propUser?.id ?? currentUser?.id;

    // Cached lite version (from roster) for instant render. The lite query
    // omits heavy nested arrays (certifications, commendations, conductRecord,
    // limitingMarkers) so we lazy-fetch the full record below for
    // not-self views.
    const cachedUser = useMemo(() => {
        if (!targetId) return propUser || currentUser;
        if (currentUser && targetId === currentUser.id) return currentUser;
        return allUsers.find(u => u.id === targetId) || propUser || currentUser;
    }, [propUser, currentUser, allUsers, targetId]);

    // Whether the current target needs a cross-user detail fetch. Self-view and
    // the no-target case carry their heavy fields already (or have nothing to
    // fetch), so they never hydrate.
    const needsDetailFetch = !!targetId && !(currentUser && targetId === currentUser.id);

    const [fullUser, setFullUser] = useState<User | null>(null);
    // Tracks whether we're awaiting a cross-user detail fetch. Self-view
    // never hydrates because `currentUser` already carries the heavy fields.
    // The flag drives skeleton placeholders for sections whose data only
    // arrives after hydration (certifications, commendations, clearance,
    // limiting markers, conduct) so the view doesn't visibly "pop" when
    // those fields land a moment after the lite roster row. Lazy-initialised to
    // the mount-time fetch decision so a cross-user view shows skeletons from
    // the first paint (the effect's fetch resolves them) instead of flashing
    // lite data first.
    const [isHydrating, setIsHydrating] = useState(needsDetailFetch);

    // Identity-change tracker. When the viewed identity changes we re-seed the
    // hydration state during render (React's "adjust state during render"
    // pattern) instead of in the effect, so it lands on the same frame the
    // effect would have committed. The async fetch itself stays in the effect
    // below. We key on the same trigger the old effect used
    // ([targetId, currentUser]) and reproduce its three synchronous branches
    // exactly:
    //   * no target OR self-view -> clear fullUser, drop isHydrating (nothing to
    //     fetch; currentUser already carries the heavy fields for self-view).
    //   * cross-user -> prime isHydrating only, WITHOUT clearing fullUser, so
    //     the prior record stays put until the new fetch resolves (matching the
    //     old effect, which never reset fullUser on the fetch path).
    const [prevDetailKey, setPrevDetailKey] = useState<{ targetId: number | undefined; currentUser: User | null }>(
        () => ({ targetId, currentUser }),
    );
    if (targetId !== prevDetailKey.targetId || currentUser !== prevDetailKey.currentUser) {
        setPrevDetailKey({ targetId, currentUser });
        if (needsDetailFetch) {
            setIsHydrating(true);
        } else {
            setFullUser(null);
            setIsHydrating(false);
        }
    }

    useEffect(() => {
        if (!needsDetailFetch || !targetId) return;
        let cancelled = false;
        (async () => {
            try {
                const full = await fetchUserDetail(targetId);
                if (!cancelled && full) setFullUser(full);
            } finally {
                if (!cancelled) setIsHydrating(false);
            }
        })();
        return () => { cancelled = true; };
    }, [targetId, currentUser, needsDetailFetch, fetchUserDetail]);

    const user = fullUser || cachedUser;

    // Position history (HR + Government, unified) — lazy-fetched per target.
    // Failures degrade silently; the section just shows an empty state.
    const [positionHistory, setPositionHistory] = useState<PositionHistoryEntry[] | null>(null);
    // Clear the lazily-fetched rows during render when the target goes away, so
    // a stale list can't show with no target. This reproduces the OLD effect's
    // ONLY synchronous branch (`if (!targetId) setPositionHistory(null)`): on a
    // target-to-target change the old effect did NOT reset, it just refetched
    // and let the prior rows linger until the new ones arrived, so we must not
    // reset in that case either. Keyed on targetId, matching the old [targetId]
    // dependency.
    const [prevHistoryTargetId, setPrevHistoryTargetId] = useState<number | undefined>(targetId);
    if (targetId !== prevHistoryTargetId) {
        setPrevHistoryTargetId(targetId);
        if (!targetId) setPositionHistory(null);
    }
    useEffect(() => {
        if (!targetId) return;
        let cancelled = false;
        (async () => {
            try {
                const rows = await getPositionHistory(targetId);
                if (!cancelled) setPositionHistory(rows);
            } catch {
                if (!cancelled) setPositionHistory([]);
            }
        })();
        return () => { cancelled = true; };
    }, [targetId, getPositionHistory]);

    // Position-history summary counts, lifted out of JSX so the render path
    // contains no IIFE (which the React Compiler cannot optimise).
    const positionHistoryCounts = useMemo(() => {
        return (positionHistory || []).reduce((acc, e) => {
            if (!e.endedAt) acc.current++;
            if (e.kind === 'hr') acc.hr++; else acc.gov++;
            return acc;
        }, { current: 0, hr: 0, gov: 0 });
    }, [positionHistory]);

    // Merged timeline drawing from four sources. Awards (cert/commend) join
    // operations + service requests so the timeline reads as a true career
    // feed rather than just an ops log.
    const timelineEvents: TimelineEvent[] = useMemo(() => {
        if (!user) return [];
        const events: TimelineEvent[] = [];

        hydratedServiceRequests.filter(r => r.assignedMemberIds.includes(user.id)).forEach(r => {
            events.push({
                id: `req-${r.id}`,
                recordType: 'REQUEST',
                date: r.updatedAt,
                title: r.serviceType,
                subId: r.id.split('-')[0],
                status: r.status,
                onClick: () => viewRequestDetails(r),
            });
        });

        operations.filter(o => o.participants.some(p => p.userId === user.id)).forEach(o => {
            events.push({
                id: `op-${o.id}`,
                recordType: 'OPERATION',
                date: o.createdAt,
                title: o.name,
                subId: o.id.split('-')[0],
                status: o.status,
                onClick: () => viewOperationDetails(o),
            });
        });

        (user.certifications || []).forEach(cert => {
            if (!cert.awardedAt) return;
            events.push({
                id: `cert-${cert.id}`,
                recordType: 'CERTIFICATION',
                date: cert.awardedAt,
                title: cert.name,
            });
        });

        (user.commendations || []).forEach(c => {
            if (!c.awardedAt) return;
            events.push({
                id: `commend-${c.id}`,
                recordType: 'COMMENDATION',
                date: c.awardedAt,
                title: c.name,
                reason: c.reason,
            });
        });

        return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [hydratedServiceRequests, operations, user, viewRequestDetails, viewOperationDetails]);

    const filteredEvents = useMemo(
        () => timelineEvents.filter(e => matchesFilter(e, filter)),
        [timelineEvents, filter],
    );

    // Sorted conduct memo lives ABOVE the early-return so hook order stays
    // stable across renders. The render path further below is gated on
    // `canSeeConduct` so an unauthorized cross-user view never displays it.
    const sortedConduct = useMemo(() => {
        const list = user?.conductRecord || [];
        return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [user]);

    if (!user) return null;

    const certCount = user.certifications?.length || 0;
    const commendCount = user.commendations?.length || 0;
    const totalRecords = timelineEvents.length;

    const heroSubtitle = [
        user.rank?.name,
        user.unit?.name || 'Unassigned',
        user.position?.name || user.jobTitle,
    ].filter(Boolean).join(' · ');

    // Conduct visibility: server-side query.ts already strips the array for
    // non-authorized cross-user views (self always sees their own). Mirror
    // that gate here so an empty-state rendering stays out of view when the
    // requester wouldn't have been allowed to fetch it anyway.
    const isSelf = currentUser?.id === user.id;
    const canSeeConduct = isSelf || hasPermission('user:manage:conduct_record');

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel={`SERVICE RECORD · ID ${user.id.toString().padStart(6, '0')}`}
                chipIcon="fa-medal"
                chipAccent="sky"
                chipPulse={user.isDuty}
                title={user.name}
                subtitle={heroSubtitle || user.rsiHandle}
                actions={onBack ? (
                    <button
                        onClick={onBack}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/60 text-slate-300 border border-slate-700 hover:text-white hover:border-sky-500/30 text-[10px] font-black uppercase tracking-wider transition-colors"
                    >
                        <i className="fa-solid fa-arrow-left"></i> Return to Roster
                    </button>
                ) : undefined}
                statsCols={4}
                stats={<>
                    <HeroStat icon="fa-star" label="Reputation" value={user.reputation ?? 0} accent="amber" emphasize={(user.reputation ?? 0) > 0} />
                    <HeroStat icon="fa-clock-rotate-left" label="Total Records" value={isHydrating ? '—' : totalRecords} accent="sky" emphasize={!isHydrating && totalRecords > 0} />
                    <HeroStat icon="fa-certificate" label="Certifications" value={isHydrating ? '—' : certCount} accent="emerald" emphasize={!isHydrating && certCount > 0} />
                    <HeroStat icon="fa-medal" label="Commendations" value={isHydrating ? '—' : commendCount} accent="amber" emphasize={!isHydrating && commendCount > 0} />
                </>}
            />

            {/* Sub-tab strip — sits between the hero and the scrollable content. */}
            <div className="shrink-0 px-4 sm:px-6 border-b border-slate-700/50 bg-slate-900/40">
                <div className="flex gap-0 -mb-px overflow-x-auto custom-scrollbar">
                    {(['dossier', 'history', 'position-history'] as const).map(tab => {
                        const isActive = activeTab === tab;
                        const label = tab === 'dossier' ? 'Dossier' : tab === 'history' ? 'Service History' : 'Position History';
                        const icon = tab === 'dossier' ? 'fa-id-card-clip' : tab === 'history' ? 'fa-clock-rotate-left' : 'fa-briefcase';
                        return (
                            <button
                                key={tab}
                                type="button"
                                onClick={() => setActiveTab(tab)}
                                className={`flex items-center gap-2 px-4 py-3 text-xs font-black uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${isActive
                                    ? 'text-sky-300 border-sky-400'
                                    : 'text-slate-500 border-transparent hover:text-slate-300'
                                }`}
                                aria-current={isActive ? 'page' : undefined}
                            >
                                <i className={`fa-solid ${icon}`} aria-hidden></i>
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className={`flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 sm:p-6 ${activeTab === 'dossier' ? 'lg:overflow-hidden' : ''}`}>
                {activeTab === 'dossier' ? (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:h-full">
                        {/* Left: expanded operational timeline. On desktop the
                            column flex-fills the available height so the
                            timeline reaches the bottom of the viewport. */}
                        <div className="lg:col-span-2 lg:flex lg:flex-col lg:min-h-0">
                            <SectionCard
                                title="Operational History"
                                icon="fa-clock-rotate-left"
                                accent="sky"
                                className="lg:flex-1 lg:flex lg:flex-col lg:min-h-0"
                                bodyClassName="p-5 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col"
                                actions={
                                    <div className="flex flex-wrap items-center gap-1">
                                        {FILTERS.map(f => {
                                            const isActive = filter === f.key;
                                            return (
                                                <button
                                                    key={f.key}
                                                    type="button"
                                                    onClick={() => setFilter(f.key)}
                                                    className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-sm border transition-colors ${isActive
                                                        ? 'bg-sky-500/10 border-sky-500/40 text-sky-300'
                                                        : 'bg-slate-900/60 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                                                    }`}
                                                    aria-pressed={isActive}
                                                >
                                                    {f.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                }
                            >
                                {isHydrating ? (
                                    // Cross-user view: requests/operations are
                                    // instantly available from DataContext but
                                    // awards only arrive after fetchUserDetail.
                                    // Hold the full list back so the timeline
                                    // renders in one settled pass instead of
                                    // letting awards visibly pop in seconds later.
                                    <div className="pl-3 -ml-3 pr-2 lg:flex-1 lg:min-h-0">
                                        <ol className="relative border-l border-slate-800 ml-3 space-y-5" aria-busy="true" aria-label="Loading service history">
                                            {[0, 1, 2, 3].map(i => (
                                                <li key={i} className="relative pl-6 min-w-0">
                                                    <span className="absolute left-[-13px] top-0 w-6 h-6 rounded-full bg-slate-800/60 border border-slate-700 ring-4 ring-slate-900/60" />
                                                    <Skeleton className="h-3 w-24 mb-2" />
                                                    <Skeleton className="h-4 w-3/4" />
                                                </li>
                                            ))}
                                        </ol>
                                    </div>
                                ) : filteredEvents.length > 0 ? (
                                    // Wrapper carries the scroll constraint. The negative ml-3 +
                                    // pl-3 gives the negatively-positioned LI icons (`left-[-13px]`)
                                    // room to sit inside the overflow box — without this trick
                                    // CSS treats `overflow-y: auto` as implying overflow-x clip,
                                    // and the icons get cropped on the left edge. On lg+ the
                                    // wrapper drops the max-h and flex-fills the card body so
                                    // the timeline extends to the bottom of the viewport.
                                    <div className="max-h-[600px] lg:max-h-none overflow-y-auto custom-scrollbar pl-3 -ml-3 pr-2 lg:flex-1 lg:min-h-0">
                                        <ol className="relative border-l border-slate-800 ml-3 space-y-5">
                                            {filteredEvents.map(event => {
                                                const a = TIMELINE_ACCENTS[event.recordType];
                                                const isInteractive = !!event.onClick;
                                                const Tag = isInteractive ? 'button' : 'div';
                                                return (
                                                    <li key={event.id} className="relative pl-6 min-w-0">
                                                        <span className={`absolute left-[-13px] top-0 w-6 h-6 rounded-full flex items-center justify-center border ${a.border} ${a.bg} ${a.text} ring-4 ring-slate-900/60`}>
                                                            <i className={`fa-solid ${a.icon} text-[10px]`} aria-hidden></i>
                                                        </span>
                                                        <Tag
                                                            type={isInteractive ? 'button' : undefined}
                                                            onClick={event.onClick}
                                                            className={`w-full text-left min-w-0 ${isInteractive ? 'group cursor-pointer' : ''}`}
                                                        >
                                                            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 min-w-0">
                                                                <div className="min-w-0 flex-1">
                                                                    <div className="flex items-center gap-2 flex-wrap">
                                                                        <span className={`text-[9px] font-black uppercase tracking-widest ${a.text}`}>
                                                                            {a.label}
                                                                        </span>
                                                                        {event.subId && (
                                                                            <span className="text-[10px] font-mono text-slate-500">{event.subId}</span>
                                                                        )}
                                                                    </div>
                                                                    <p className={`text-sm font-bold text-slate-200 leading-tight mt-0.5 wrap-break-word ${isInteractive ? 'group-hover:text-white transition-colors' : ''}`}>
                                                                        {event.title}
                                                                    </p>
                                                                    {event.reason && (
                                                                        <p className="text-xs text-slate-400 italic mt-1 wrap-break-word">&ldquo;{event.reason}&rdquo;</p>
                                                                    )}
                                                                </div>
                                                                <div className="flex items-center gap-2 shrink-0">
                                                                    {event.status && (
                                                                        <span className={`px-2 py-0.5 rounded-sm text-[10px] font-black uppercase border ${getStatusChipClass(event.status)}`}>
                                                                            {event.status}
                                                                        </span>
                                                                    )}
                                                                    <time className="text-[10px] text-slate-500 uppercase tracking-widest font-black tabular-nums whitespace-nowrap">
                                                                        {fmt.date(event.date)}
                                                                    </time>
                                                                </div>
                                                            </div>
                                                        </Tag>
                                                    </li>
                                                );
                                            })}
                                        </ol>
                                    </div>
                                ) : (
                                    <EmptyState
                                        icon="fa-clock-rotate-left"
                                        accent="sky"
                                        heading={timelineEvents.length === 0 ? 'No service history' : 'No matching events'}
                                        description={timelineEvents.length === 0
                                            ? 'Operations, service requests, and awards will appear here as they accumulate.'
                                            : 'No events match the current filter. Try switching to All.'}
                                        compact
                                    />
                                )}
                            </SectionCard>
                        </div>

                        {/* Right: identity + clearance. On desktop the column
                            gets its own scroll so the timeline column can keep
                            reaching the bottom even if the right side is taller. */}
                        <div className="space-y-6 lg:overflow-y-auto lg:min-h-0 custom-scrollbar lg:pr-1">
                            <MemberIdCard user={user} accent="sky" />

                            <SectionCard title="Security Clearance" icon="fa-user-shield" accent="emerald">
                                {isHydrating ? (
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0 space-y-2">
                                                <Skeleton className="h-2 w-20" />
                                                <Skeleton className="h-5 w-32" />
                                            </div>
                                            <Skeleton className="w-12 h-12 rounded-lg" />
                                        </div>
                                        <Skeleton className="h-3 w-full" />
                                        <Skeleton className="h-3 w-3/4" />
                                    </div>
                                ) : user.clearanceLevel ? (
                                    <div className="space-y-4 animate-fade-in">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] font-black mb-1">Classification</p>
                                                <h4 className="text-base font-black text-white uppercase tracking-tight truncate">{user.clearanceLevel.name}</h4>
                                            </div>
                                            <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-lg font-black text-white shadow-lg border-2 border-slate-900 shrink-0 ${getClearanceColor(user.clearanceLevel.level)}`}>
                                                {user.clearanceLevel.level}
                                            </div>
                                        </div>
                                        {user.clearanceLevel.description && (
                                            <p className="text-xs text-slate-400 leading-relaxed">{user.clearanceLevel.description}</p>
                                        )}
                                        <div>
                                            <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] font-black mb-2">Limiting Markers</p>
                                            {(user.limitingMarkers && user.limitingMarkers.length > 0) ? (
                                                <div className="flex flex-wrap gap-2">
                                                    {user.limitingMarkers.map(m => (
                                                        <div key={m.id} className="bg-amber-500/10 border border-amber-500/30 rounded-sm px-2.5 py-1 flex flex-col" title={m.description}>
                                                            <span className="text-[11px] font-black text-amber-300 tracking-wider">{m.code}</span>
                                                            <span className="text-[9px] text-amber-400/80">{m.name}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-xs text-slate-500 italic">No limiting markers applied.</p>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <p className="text-xs text-slate-500 italic">No clearance assigned.</p>
                                )}
                            </SectionCard>
                        </div>
                    </div>
                ) : activeTab === 'history' ? (
                    <div className="space-y-6">
                        <SectionCard title="Specializations" icon="fa-tags" accent="sky">
                            {isHydrating ? (
                                <div className="flex flex-wrap gap-2">
                                    <Skeleton className="h-6 w-20" />
                                    <Skeleton className="h-6 w-28" />
                                    <Skeleton className="h-6 w-24" />
                                </div>
                            ) : user.specializations && user.specializations.length > 0 ? (
                                <div className="flex flex-wrap gap-2 animate-fade-in">
                                    {user.specializations.map(spec => (
                                        <span key={spec.id} className="bg-slate-950/40 border border-slate-800 text-sky-400 px-3 py-1 rounded-sm text-xs font-bold flex items-center gap-2" title={spec.description || spec.name}>
                                            {(spec.icon || spec.imageUrl) && (
                                                <AwardIcon imageUrl={spec.imageUrl} icon={spec.icon} fallbackIcon="fa-solid fa-star" className="w-3 h-3 inline-block" alt={spec.name} />
                                            )}
                                            {spec.name}
                                        </span>
                                    ))}
                                </div>
                            ) : <p className="text-slate-500 italic text-sm">No specializations set.</p>}
                        </SectionCard>

                        <SectionCard title="Certifications" icon="fa-certificate" accent="emerald">
                            {isHydrating ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <Skeleton className="h-12" />
                                    <Skeleton className="h-12" />
                                    <Skeleton className="h-12" />
                                    <Skeleton className="h-12" />
                                </div>
                            ) : user.certifications && user.certifications.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 animate-fade-in">
                                    {user.certifications.map(cert => (
                                        <div key={cert.id} className="bg-slate-950/40 border border-slate-800 p-3 rounded-lg flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-3 min-w-0">
                                                <AwardIcon imageUrl={cert.imageUrl} icon={cert.icon} fallbackIcon="fa-solid fa-certificate" className="text-emerald-300 w-4 h-4 inline-block shrink-0" alt={cert.name} />
                                                <span className="font-bold text-slate-200 text-sm truncate">{cert.name}</span>
                                            </div>
                                            <span className="text-[10px] text-slate-500 font-mono shrink-0">{fmt.date(cert.awardedAt)}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : <p className="text-slate-500 italic text-sm">No certifications on file.</p>}
                        </SectionCard>

                        <SectionCard title="Commendations" icon="fa-medal" accent="amber">
                            {isHydrating ? (
                                <div className="space-y-2">
                                    <Skeleton className="h-20" />
                                    <Skeleton className="h-20" />
                                </div>
                            ) : user.commendations && user.commendations.length > 0 ? (
                                <div className="space-y-2 animate-fade-in">
                                    {user.commendations.map(c => (
                                        <div key={c.id} className="bg-slate-950/40 border border-slate-800 p-4 rounded-lg flex items-start gap-4">
                                            <div className="text-amber-400 text-xl pt-1 w-6 h-6 flex items-center justify-center overflow-hidden shrink-0">
                                                <AwardIcon imageUrl={c.imageUrl} icon={c.icon} fallbackIcon="fa-solid fa-medal" className="max-w-full max-h-full" alt={c.name} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-white text-sm">{c.name}</h4>
                                                {c.reason && <p className="text-xs text-slate-400 italic mt-1">&ldquo;{c.reason}&rdquo;</p>}
                                                <p className="text-[10px] text-slate-600 mt-2 font-mono uppercase">Awarded {fmt(c.awardedAt)}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : <p className="text-slate-500 italic text-sm">No commendations awarded.</p>}
                        </SectionCard>

                        {/* Conduct — self always; cross-view requires user:manage:conduct_record. */}
                        {canSeeConduct && (
                            <SectionCard title="Conduct Record" icon="fa-gavel" accent="rose">
                                <p className="text-[10px] text-slate-500 italic flex items-center gap-1.5 -mt-1">
                                    <i className="fa-solid fa-lock text-slate-600" aria-hidden />
                                    Visible to you and administrators only.
                                </p>
                                {isHydrating ? (
                                    <div className="space-y-2">
                                        <Skeleton className="h-20" />
                                    </div>
                                ) : sortedConduct.length > 0 ? (
                                    <div className="space-y-2 animate-fade-in">
                                        {sortedConduct.map(entry => (
                                            <div key={entry.id} className="bg-slate-950/40 border border-slate-800 p-4 rounded-lg">
                                                <div className="flex justify-between items-start mb-2 gap-3">
                                                    <span className={`px-2.5 py-0.5 rounded-sm border text-[10px] font-black uppercase tracking-wider ${getConductChipClass(entry.type)}`}>
                                                        {entry.type}
                                                    </span>
                                                    <div className="text-right shrink-0">
                                                        <p className="text-[10px] text-slate-400 font-mono uppercase tracking-widest">{fmt(entry.createdAt)}</p>
                                                        <p className="text-[10px] text-slate-500">by {entry.enteredBy?.name || 'Unknown'}</p>
                                                    </div>
                                                </div>
                                                <p className="text-sm text-slate-300 leading-relaxed wrap-break-word">{entry.reason}</p>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-slate-500 italic text-sm">No conduct entries on record.</p>
                                )}
                            </SectionCard>
                        )}
                    </div>
                ) : (
                    // Position History tab — chronological vertical timeline of HR
                    // and Government assignments. Newest first, with a colored dot
                    // (sky=HR, amber=Gov), duration calc, and current/past chip.
                    <div className="max-w-3xl">
                        <SectionCard title="Position History" icon="fa-briefcase" accent="sky">
                            {positionHistory === null ? (
                                <ol className="relative border-l border-slate-800 ml-3 space-y-5" aria-busy="true" aria-label="Loading position history">
                                    {[0, 1, 2].map(i => (
                                        <li key={i} className="relative pl-6 min-w-0">
                                            <span className="absolute left-[-13px] top-0 w-6 h-6 rounded-full bg-slate-800/60 border border-slate-700 ring-4 ring-slate-900/60" />
                                            <Skeleton className="h-3 w-24 mb-2" />
                                            <Skeleton className="h-4 w-2/3 mb-2" />
                                            <Skeleton className="h-3 w-1/2" />
                                        </li>
                                    ))}
                                </ol>
                            ) : positionHistory.length === 0 ? (
                                <EmptyState
                                    icon="fa-briefcase"
                                    accent="sky"
                                    heading="No position assignments on record"
                                    description="HR and government position assignments will appear here as they accumulate. Talk to your command if you expect to see entries here."
                                    compact
                                />
                            ) : (
                                    <>
                                        <div className="grid grid-cols-3 gap-3 mb-5">
                                            <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-3 text-center">
                                                <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Current</div>
                                                <div className="mt-1 text-lg font-black text-emerald-300 tabular-nums">{positionHistoryCounts.current}</div>
                                            </div>
                                            <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-3 text-center">
                                                <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">HR</div>
                                                <div className="mt-1 text-lg font-black text-sky-300 tabular-nums">{positionHistoryCounts.hr}</div>
                                            </div>
                                            <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-3 text-center">
                                                <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Government</div>
                                                <div className="mt-1 text-lg font-black text-amber-300 tabular-nums">{positionHistoryCounts.gov}</div>
                                            </div>
                                        </div>

                                        <ol className="relative border-l border-slate-800 ml-3 space-y-5 animate-fade-in">
                                            {positionHistory.map(entry => {
                                                const start = new Date(entry.startedAt);
                                                const end = entry.endedAt ? new Date(entry.endedAt) : new Date();
                                                const days = Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
                                                const durationLabel = days < 30
                                                    ? `${days} day${days !== 1 ? 's' : ''}`
                                                    : days < 365
                                                        ? `${Math.floor(days / 30)} mo`
                                                        : `${(days / 365).toFixed(1)} yr`;
                                                const isHr = entry.kind === 'hr';
                                                const dotClasses = isHr
                                                    ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                                                    : 'bg-amber-500/15 border-amber-500/40 text-amber-300';
                                                const kindBadge = isHr
                                                    ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                                                    : 'bg-amber-500/15 text-amber-300 border-amber-500/30';
                                                return (
                                                    <li key={`${entry.kind}-${entry.id}`} className="relative pl-6 min-w-0">
                                                        <span className={`absolute left-[-13px] top-0 w-6 h-6 rounded-full flex items-center justify-center border ring-4 ring-slate-900/60 ${dotClasses}`}>
                                                            <i className={`${entry.positionIcon || 'fa-solid fa-briefcase'} text-[10px]`} aria-hidden></i>
                                                        </span>
                                                        <div className="bg-slate-950/40 border border-slate-800 p-3 rounded-lg">
                                                            <div className="flex items-start justify-between gap-3 mb-1">
                                                                <div className="flex items-center gap-2 flex-wrap min-w-0">
                                                                    <span className="text-sm font-bold text-white truncate">{entry.positionName}</span>
                                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-sm uppercase font-black tracking-widest border ${kindBadge}`}>
                                                                        {isHr ? 'HR' : 'Gov'}
                                                                    </span>
                                                                    {!entry.endedAt && (
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm uppercase font-black tracking-widest bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Current</span>
                                                                    )}
                                                                </div>
                                                                <div className="text-right text-[10px] text-slate-500 font-mono whitespace-nowrap shrink-0">
                                                                    <div>{fmt.date(entry.startedAt)} → {entry.endedAt ? fmt.date(entry.endedAt) : 'present'}</div>
                                                                    <div className="text-slate-600 mt-0.5">{durationLabel}{entry.endReason ? ` · ${entry.endReason}` : ''}</div>
                                                                </div>
                                                            </div>
                                                            {entry.positionDescription && (
                                                                <p className="text-xs text-slate-400 leading-relaxed mt-1.5">{entry.positionDescription}</p>
                                                            )}
                                                        </div>
                                                    </li>
                                                );
                                            })}
                                        </ol>
                                    </>
                            )}
                        </SectionCard>
                    </div>
                )}
            </div>
        </div>
    );
};

export default MyServiceRecordView;
