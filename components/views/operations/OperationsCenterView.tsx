

import React, { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { OperationStatus, HydratedOperation, MirroredOperation } from '../../../types';
import { VirtualizedList } from '../../ui/VirtualizedList';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import { ACCENTS } from '../../shared/ui/accents';
import OperationCard from './operations/OperationCard';
import { useNavigation } from '../../../contexts/NavigationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';
import {
    operationTypeAccent,
    operationTypeIcon,
    formatScheduledTime,
    operationCountdown,
    type OperationCountdown,
} from './operations/operationStyles';
const OperationsCalendarView = lazy(() => import('./OperationsCalendarView'));

const OperationsCenterView: React.FC = () => {
    const { currentUser, hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { isFetching, refreshOperations, rpcAction } = useData();
    const { operations } = useOperations();
    const { viewMirroredOperation } = useNavigation();

    // Self-heal: if this view loads with an empty operations list and no fetch in flight,
    // kick off a refresh. Covers the case where initial-state missed the data but the
    // realtime WS never disconnected, so the wasDisconnected resync didn't fire.
    const selfHealAttemptedRef = useRef(false);
    useEffect(() => {
        if (selfHealAttemptedRef.current) return;
        if (operations.length > 0) { selfHealAttemptedRef.current = true; return; }
        if (isFetching['operations']) return;
        selfHealAttemptedRef.current = true;
        refreshOperations();
    }, [operations.length, isFetching, refreshOperations]);
    const { openCreateOperationModal, openOperationTemplatesModal } = useModalRegistry();

    // Allied joint operations mirrored from host instances. Members see accepted mirrors;
    // alliance admins also see pending invites to accept.
    const canManageAlliance = hasPermission('alliance:manage');
    const [mirrors, setMirrors] = useState<MirroredOperation[]>([]);
    const [mirrorBusy, setMirrorBusy] = useState<string | null>(null);
    const loadMirrors = useCallback(async () => {
        try {
            const data = await rpcAction(canManageAlliance ? 'mirror:list_pending' : 'mirror:list', {});
            setMirrors(data || []);
        } catch { setMirrors([]); }
    }, [rpcAction, canManageAlliance]);
    // Fetch mirrors on mount / when the gated action changes. loadMirrors only
    // setStates after its awaited RPC, so awaiting it from an async IIFE keeps
    // every update on the post-await path (no synchronous set-in-effect) — same
    // timing as a bare loadMirrors() call.
    useEffect(() => { void (async () => { await loadMirrors(); })(); }, [loadMirrors]);
    const acceptedMirrors = useMemo(() => mirrors.filter(m => m.accepted), [mirrors]);
    const pendingMirrors = useMemo(() => mirrors.filter(m => !m.accepted), [mirrors]);
    const handleMirrorAccept = async (id: string) => {
        setMirrorBusy(id);
        try { await rpcAction('mirror:accept', { id }); await loadMirrors(); } catch { /* surfaced by reload */ } finally { setMirrorBusy(null); }
    };
    const handleMirrorDecline = async (id: string) => {
        setMirrorBusy(id);
        try { await rpcAction('mirror:decline', { id }); await loadMirrors(); } catch { /* surfaced by reload */ } finally { setMirrorBusy(null); }
    };
    const [filter, setFilter] = useState<OperationStatus | 'All' | 'My Concluded' | 'Current' | 'Scheduled'>('Current');
    const [searchTerm, setSearchTerm] = useState('');
    const debouncedSearchTerm = useDebouncedValue(searchTerm, 250);
    // Virtualized rows are fixed-height; size to the tallest card per breakpoint
    // (the card stacks to one column on mobile) and re-measure on resize so cards
    // don't overflow into the next row.
    const [itemHeight, setItemHeight] = useState(() => { const w = window.innerWidth; return w < 768 ? 480 : w < 1024 ? 340 : 285; });
    useEffect(() => {
        const onResize = () => { const w = window.innerWidth; setItemHeight(w < 768 ? 480 : w < 1024 ? 340 : 285); };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');

    const userLevel = useMemo(() => currentUser?.clearanceLevel?.level || 0, [currentUser]);
    const userMarkers = useMemo(() => new Set(currentUser?.limitingMarkers?.map(m => m.id) || []), [currentUser]);

    const hasOperationAccess = useCallback((op: HydratedOperation) => {
        if (op.isSpecial) return true;
        if (op.ownerId === currentUser?.id || hasPermission('operations:manage')) return true;
        if ((op.clearanceLevel || 0) > userLevel) return false;
        if (op.limitingMarkers && op.limitingMarkers.length > 0) {
            return op.limitingMarkers.every(m => userMarkers.has(m.id));
        }
        return true;
    }, [currentUser, userLevel, userMarkers, hasPermission]);

    const stats = useMemo(() => {
        const accessible = operations.filter(hasOperationAccess);
        const active = accessible.filter(op => op.status === OperationStatus.Active).length;
        const scheduled = accessible.filter(op => op.status === OperationStatus.Scheduled).length;
        const planning = accessible.filter(op => op.status === OperationStatus.Planning).length;
        const deployed = accessible
            .filter(op => op.status === OperationStatus.Active)
            .reduce((sum, op) => sum + op.participants.filter(p => p.timeLeft === null).length, 0);
        return { active, scheduled, planning, deployed };
    }, [operations, hasOperationAccess]);


    const myActiveOperations = useMemo(() => {
        return operations.filter(op =>
            op.status === OperationStatus.Active &&
            op.participants.some(p => p.userId === currentUser?.id && p.timeLeft === null)
        ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [operations, currentUser?.id]);

    const upcomingScheduledOps = useMemo(() => {
        return operations
            .filter(op =>
                op.status === OperationStatus.Scheduled &&
                op.scheduledStart &&
                hasOperationAccess(op)
            )
            .sort((a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime());
    }, [operations, hasOperationAccess]);

    const otherOperations = useMemo(() => {
        const myActiveIds = new Set(myActiveOperations.map(op => op.id));
        return operations
            .filter(op => !myActiveIds.has(op.id))
            .filter(hasOperationAccess);
    }, [operations, myActiveOperations, hasOperationAccess]);


    const isCurrentOp = useCallback((op: HydratedOperation) => {
        if (op.status === OperationStatus.Active) return true;
        if (op.status !== OperationStatus.Scheduled) return false;
        if (!op.scheduledStart || !op.scheduledEnd) return false;
        const now = Date.now();
        return now >= new Date(op.scheduledStart).getTime() && now <= new Date(op.scheduledEnd).getTime();
    }, []);

    const filteredOperations = useMemo(() => {
        let result = [...otherOperations].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        if (filter === 'Current') {
            result = result.filter(isCurrentOp);
        } else if (filter === 'Scheduled') {
            result = result.filter(op => op.status === OperationStatus.Scheduled);
        } else if (filter === 'My Concluded') {
            result = result.filter(op => op.status === OperationStatus.Concluded && op.participants.some(p => p.userId === currentUser?.id));
        } else if (filter !== 'All') {
            result = result.filter(op => op.status === filter);
        }

        const term = debouncedSearchTerm.trim().toLowerCase();
        if (term) {
            result = result.filter(op =>
                op.name.toLowerCase().includes(term) ||
                op.description.toLowerCase().includes(term) ||
                (op.owner?.name || '').toLowerCase().includes(term)
            );
        }

        return result;
    }, [otherOperations, filter, currentUser?.id, debouncedSearchTerm, isCurrentOp]);

    // Single-pass tally so each tab badge doesn't trigger its own .filter() over otherOperations.
    const filterCounts = useMemo(() => {
        const counts = { Current: 0, Active: 0, Planning: 0, Scheduled: 0, MyConcluded: 0, All: otherOperations.length };
        for (const op of otherOperations) {
            if (op.status === OperationStatus.Active) counts.Active++;
            if (op.status === OperationStatus.Planning) counts.Planning++;
            if (op.status === OperationStatus.Scheduled) counts.Scheduled++;
            if (isCurrentOp(op)) counts.Current++;
            if (op.status === OperationStatus.Concluded && op.participants.some(p => p.userId === currentUser?.id)) counts.MyConcluded++;
        }
        return counts;
    }, [otherOperations, currentUser?.id, isCurrentOp]);

    const filterTabs: Array<{ key: OperationStatus | 'All' | 'My Concluded' | 'Current' | 'Scheduled'; label: string; icon: string; count: number }> = [
        { key: 'Current', label: 'Current', icon: 'fa-bolt', count: filterCounts.Current },
        { key: OperationStatus.Active, label: 'Active', icon: 'fa-satellite-dish', count: filterCounts.Active },
        { key: OperationStatus.Planning, label: 'Planning', icon: 'fa-drafting-compass', count: filterCounts.Planning },
        { key: 'Scheduled', label: 'Scheduled', icon: 'fa-clock', count: filterCounts.Scheduled },
        { key: 'My Concluded', label: 'History', icon: 'fa-flag-checkered', count: filterCounts.MyConcluded },
        { key: 'All', label: 'All', icon: 'fa-list-ul', count: filterCounts.All },
    ];

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · OPERATIONS CENTRE"
                chipIcon="fa-person-military-rifle"
                chipAccent="purple"
                title="Operations Centre"
                subtitle="Mission planning and coordination. Plan, brief, and command joint operations end-to-end."
                syncing={isFetching['operations']}
                actions={<>
                    {hasPermission('operations:create') && (
                        <HeroActionButton onClick={openCreateOperationModal} accent="purple" icon="fa-plus">
                            New Operation
                        </HeroActionButton>
                    )}
                    <button
                        onClick={openOperationTemplatesModal}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/60 text-slate-300 border border-slate-700 hover:text-white hover:border-purple-500/30 text-[10px] font-black uppercase tracking-wider transition-colors"
                        title="Browse and manage operation templates"
                    >
                        <i className="fa-solid fa-clipboard-list"></i> Templates
                    </button>
                    <div className="flex bg-slate-900/60 rounded-lg border border-slate-700 p-0.5">
                        <button onClick={() => setViewMode('list')}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${viewMode === 'list' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'}`}>
                            <i className="fa-solid fa-list mr-1.5"></i>List
                        </button>
                        <button onClick={() => setViewMode('calendar')}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${viewMode === 'calendar' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'}`}>
                            <i className="fa-solid fa-calendar-days mr-1.5"></i>Calendar
                        </button>
                    </div>
                </>}
                stats={<>
                    <HeroStat icon="fa-bolt" label="Active" value={stats.active} accent="emerald" emphasize={stats.active > 0} onClick={() => setFilter(OperationStatus.Active)} />
                    <HeroStat icon="fa-clock" label="Scheduled" value={stats.scheduled} accent="amber" emphasize={stats.scheduled > 0} onClick={() => setFilter('Scheduled')} />
                    <HeroStat icon="fa-drafting-compass" label="Planning" value={stats.planning} accent="purple" emphasize={stats.planning > 0} onClick={() => setFilter(OperationStatus.Planning)} />
                    <HeroStat icon="fa-person-military-rifle" label="Deployed" value={stats.deployed} accent="cyan" emphasize={stats.deployed > 0} />
                </>}
                tabs={viewMode === 'list' ? filterTabs.map(tab => (
                    <button
                        key={String(tab.key)}
                        onClick={() => setFilter(tab.key)}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                            filter === tab.key
                                ? 'text-purple-300 border-purple-400'
                                : 'text-slate-500 border-transparent hover:text-slate-300'
                        }`}
                    >
                        <i className={`fa-solid ${tab.icon}`}></i>
                        {tab.label}
                        {tab.count > 0 && (
                            <span className="ml-1 min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center bg-purple-500/20 text-purple-300">
                                {tab.count}
                            </span>
                        )}
                    </button>
                )) : undefined}
            />

            {viewMode === 'calendar' ? (
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                    <Suspense fallback={<div className="flex items-center justify-center h-64"><i className="fa-solid fa-circle-notch animate-spin text-purple-500 text-2xl"></i></div>}>
                        <OperationsCalendarView operations={operations} />
                    </Suspense>
                </div>
            ) : (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
                <div className="relative max-w-2xl">
                    <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                        type="search"
                        placeholder="Search operations, commanders, or briefings…"
                        value={searchTerm}
                        onChange={(e) => { setSearchTerm(e.target.value); if (e.target.value) setFilter('All'); }}
                        className="w-full bg-slate-900/60 text-white pl-12 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500/40 transition-all"
                    />
                </div>

                {/* Allied joint operations mirrored from host instances. */}
                {(acceptedMirrors.length > 0 || pendingMirrors.length > 0) && !searchTerm && (
                    <section className="bg-cyan-950/10 rounded-xl border border-cyan-500/20 overflow-hidden animate-fade-in-up">
                        <div className="px-5 py-4 bg-cyan-950/20 border-b border-cyan-500/10 flex items-center gap-2">
                            <p className="text-[10px] text-cyan-300 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                <i className="fa-solid fa-handshake"></i> Allied Joint Operations
                            </p>
                            <span className="ml-auto text-[10px] font-mono text-slate-500">{acceptedMirrors.length}</span>
                        </div>
                        <div className="p-5 space-y-4">
                            {/* Pending invites (alliance admins) */}
                            {pendingMirrors.map(m => (
                                <div key={m.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-slate-900/60 border border-cyan-500/20">
                                    <div className="flex items-center gap-3 min-w-0">
                                        {m.hostPeerIconUrl && <img src={m.hostPeerIconUrl} alt="" className="h-8 w-8 rounded-sm border border-slate-700" />}
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold text-white truncate">{m.snapshot?.name || 'Joint Operation'}</p>
                                            <p className="text-[10px] text-slate-500 uppercase">Invite from {m.hostPeerName || 'an ally'}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button onClick={() => handleMirrorAccept(m.id)} disabled={mirrorBusy === m.id}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 transition-all disabled:opacity-50">
                                            {mirrorBusy === m.id ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-check"></i>} Accept
                                        </button>
                                        <button onClick={() => handleMirrorDecline(m.id)} disabled={mirrorBusy === m.id}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider text-slate-500 border border-slate-700/50 hover:bg-slate-800/40 hover:text-slate-300 transition-all disabled:opacity-50">
                                            <i className="fa-solid fa-xmark"></i> Decline
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {/* Accepted allied ops — read-only, click to view + RSVP */}
                            {acceptedMirrors.length > 0 && (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {acceptedMirrors.map(m => (
                                        <button key={m.id} onClick={() => viewMirroredOperation(m)}
                                            className="text-left bg-slate-900/80 border border-slate-700/50 rounded-xl p-4 hover:border-cyan-500/40 hover:-translate-y-0.5 transition-all group">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 text-[9px] font-black px-2 py-0.5 rounded-sm uppercase tracking-wider">Joint · Read-only</span>
                                                {m.snapshot?.status && <span className="text-[9px] text-slate-500 uppercase">{m.snapshot.status}</span>}
                                            </div>
                                            <h3 className="text-sm font-bold text-white line-clamp-1 group-hover:text-cyan-200 transition-colors">{m.snapshot?.name || 'Joint Operation'}</h3>
                                            <p className="text-[10px] text-slate-500 mt-1"><i className="fa-solid fa-tower-broadcast mr-1"></i>Hosted by {m.hostPeerName || 'an ally'}</p>
                                            {m.snapshot?.scheduledStart && <p className="text-[10px] text-amber-400/80 mt-1"><i className="fa-regular fa-calendar mr-1"></i>{formatScheduledTime(m.snapshot.scheduledStart, fmt.prefs)}</p>}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>
                )}

                {upcomingScheduledOps.length > 0 && !searchTerm && filter !== 'My Concluded' && (
                    <section className="bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden animate-fade-in">
                        <div className="px-5 py-4 bg-white/5 border-b border-white/5 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
                                <i className="fa-solid fa-clock text-sm"></i>
                            </div>
                            <h3 className="font-bold text-white text-sm uppercase tracking-wider">Upcoming Operations</h3>
                        </div>
                        <div className="p-5 flex gap-3 overflow-x-auto custom-scrollbar">
                            {upcomingScheduledOps.map(op => <UpcomingOpCard key={op.id} op={op} />)}
                        </div>
                    </section>
                )}

                {myActiveOperations.length > 0 && !searchTerm && (
                    <section className="bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden animate-fade-in">
                        <div className="px-5 py-4 bg-white/5 border-b border-white/5 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center text-green-400">
                                <i className="fa-solid fa-person-military-rifle text-sm"></i>
                            </div>
                            <h3 className="font-bold text-white text-sm uppercase tracking-wider">My Active Deployments</h3>
                            <span className="ml-auto text-[10px] font-mono text-slate-500">{myActiveOperations.length}</span>
                        </div>
                        <div className="p-5 grid grid-cols-1 gap-4">
                            {myActiveOperations.map(op => (
                                <div key={op.id} className="h-[480px] md:h-[340px] lg:h-[295px]">
                                    <OperationCard operation={op} />
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                <section className="flex-1 flex flex-col min-h-[400px]">
                    {filteredOperations.length > 0 ? (
                        <VirtualizedList
                            items={filteredOperations}
                            itemHeight={itemHeight}
                            renderItem={(op) => (
                                <div className="p-2 h-full">
                                    <OperationCard operation={op} />
                                </div>
                            )}
                        />
                    ) : (
                        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                            <EmptyState
                                icon="fa-satellite-dish"
                                accent="purple"
                                heading="No operations found"
                                description={searchTerm ? 'Try a different search term or clear filters.' : 'Adjust filters or spin up a new operation.'}
                            />
                        </div>
                    )}
                </section>
            </div>
            )}
        </div>
    );
}

const UpcomingOpCard: React.FC<{ op: HydratedOperation }> = React.memo(({ op }) => {
    const { viewOperationDetails } = useNavigation();
    const fmt = useFormatDate();
    const accepted = op.participants.filter(p => p.rsvpStatus === 'Accepted' && p.timeLeft === null).length;
    const total = op.participants.filter(p => p.timeLeft === null).length;

    const tA = ACCENTS[operationTypeAccent(op.type)];
    const tIcon = operationTypeIcon(op.type);
    const countdown: OperationCountdown | null = op.scheduledStart ? operationCountdown(op.scheduledStart) : null;
    const countA = countdown ? ACCENTS[countdown.accent] : null;

    return (
        <div
            onClick={() => viewOperationDetails(op)}
            className="shrink-0 w-72 bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-4 cursor-pointer hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-900/20 hover:-translate-y-0.5 transition-all duration-200 group"
        >
            <div className="flex items-center justify-between mb-2">
                <div className={`w-6 h-6 rounded-sm flex items-center justify-center border ${tA.bg} ${tA.border}`}>
                    <i className={`fa-solid ${tIcon} ${tA.text} text-[10px]`} aria-hidden />
                </div>
                {countdown && countA && (
                    <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${countA.bg} ${countA.border} ${countA.text} ${countdown.isOverdue ? 'animate-pulse' : ''}`}>
                        <i className={`fa-solid ${countdown.isOverdue ? 'fa-triangle-exclamation' : 'fa-clock'}`} aria-hidden />
                        {countdown.label}
                    </span>
                )}
            </div>
            <h3 className="text-sm font-bold text-white group-hover:text-purple-300 transition-colors line-clamp-1 mb-1">{op.name}</h3>
            <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-amber-400/80">
                    {op.scheduledStart ? formatScheduledTime(op.scheduledStart, fmt.prefs) : ''}
                </span>
                <span className="text-[10px] text-slate-500">
                    <i className="fa-solid fa-users mr-1" aria-hidden />{accepted > 0 ? `${accepted} RSVP` : `${total} PAX`}
                </span>
            </div>
        </div>
    );
});
UpcomingOpCard.displayName = 'UpcomingOpCard';

export default OperationsCenterView;
