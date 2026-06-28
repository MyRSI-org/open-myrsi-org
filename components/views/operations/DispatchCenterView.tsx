import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useRequests } from '../../../contexts/RequestsContext';

import { ServiceRequestStatus, User, HydratedServiceRequest, UrgencyLevel, UserRole } from '../../../types';
import DispatchServiceRequestModal from '../../modals/DispatchServiceRequestModal';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import MDTPanel from './dispatch/MDTPanel';
import { useNavigation } from '../../../contexts/NavigationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';
import { useNow } from '../../../hooks/useNow';

interface ActiveRoom {
    roomName: string;
    participantCount: number;
    participants: string[];
    participantNames: string[];
}

const IncidentCard: React.FC<{
    request: HydratedServiceRequest;
    onClick: () => void;
    onRunMdt?: (handle: string) => void;
}> = ({ request, onClick, onRunMdt }) => {
    const isActive = request.status === ServiceRequestStatus.InProgress || request.status === ServiceRequestStatus.Accepted;
    const isCritical = request.urgency === UrgencyLevel.Critical || request.urgency === UrgencyLevel.High;
    const clientHandle = request.client?.rsiHandle || request.unregisteredClientRsiHandle;

    return (
        <div
            onClick={onClick}
            className={`
                p-3 rounded-lg border cursor-pointer transition-all hover:scale-[1.02] active:scale-95
                ${isActive ? 'bg-blue-900/20 border-blue-500/30' : 'bg-slate-800/50 border-slate-700/50'}
                ${isCritical ? 'animate-pulse-slow border-red-500/40 shadow-[0_0_10px_rgba(239,68,68,0.1)]' : ''}
            `}
        >
            <div className="flex justify-between items-start mb-2">
                <span className={`text-[10px] uppercase font-black px-1.5 py-0.5 rounded-sm border ${isCritical ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-slate-700 text-slate-400 border-slate-600'}`}>
                    {request.urgency}
                </span>
                <span className="text-[10px] font-mono text-slate-500">#{request.id.split('-')[1]}</span>
            </div>
            <h4 className="font-bold text-white text-sm leading-tight mb-1 truncate">{request.serviceType}</h4>
            <div className="flex items-center gap-2 text-[11px] text-slate-400 mb-1">
                <i className="fa-solid fa-map-pin text-sky-500/70"></i>
                <span className="truncate">{request.location}</span>
            </div>
            {clientHandle && (
                <div className="flex items-center justify-between text-[11px] mb-2">
                    <span className="text-slate-400 truncate flex items-center gap-1.5 min-w-0">
                        <i className="fa-solid fa-user text-cyan-500/70 shrink-0"></i>
                        <span className="font-mono truncate">{clientHandle}</span>
                    </span>
                    {onRunMdt && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onRunMdt(clientHandle); }}
                            title={`Run MDT on ${clientHandle}`}
                            className="text-[9px] font-black uppercase tracking-wider text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-sm px-1.5 py-0.5 transition-colors shrink-0 ml-2"
                        >
                            <i className="fa-solid fa-magnifying-glass mr-1"></i>MDT
                        </button>
                    )}
                </div>
            )}
            <div className="flex items-center justify-between border-t border-white/5 pt-2">
                <div className="flex -space-x-1.5 overflow-hidden">
                    {request.assignedMembers.length > 0 ? request.assignedMembers.map(m => (
                        <img key={m.id} src={m.avatarUrl} className="inline-block h-5 w-5 rounded-full ring-1 ring-slate-900" title={m.name} alt="" />
                    )) : (
                        <span className="text-[9px] text-slate-600 italic">Unassigned</span>
                    )}
                </div>
                <span className={`text-[9px] font-bold uppercase ${isActive ? 'text-blue-400' : 'text-amber-400'}`}>
                    {request.status}
                </span>
            </div>
        </div>
    );
};

const UnitCard: React.FC<{
    user: User;
    activeRequest?: HydratedServiceRequest;
    liveChannel?: string;
    onDragStart: (e: React.DragEvent, userId: number) => void;
}> = ({ user, activeRequest, liveChannel, onDragStart }) => {
    return (
        <div
            draggable
            onDragStart={(e) => onDragStart(e, user.id)}
            className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/50 rounded-lg hover:border-slate-500 transition-colors cursor-grab active:cursor-grabbing"
        >
            <div className="flex items-center gap-3">
                <div className="relative">
                    <img src={user.avatarUrl} className="w-10 h-10 rounded-lg border border-slate-600" alt="" />
                    <div className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-slate-900 ${user.isDuty ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-slate-500'}`}></div>
                </div>
                <div>
                    <h4 className="font-bold text-slate-200 text-sm">{user.name}</h4>
                    <p className="text-[10px] text-slate-500 uppercase font-mono tracking-wider flex items-center gap-1">
                        {activeRequest ? (
                            <span className="text-blue-400"><i className="fa-solid fa-tower-broadcast mr-1"></i>DST-{activeRequest.id.split('-')[1]}</span>
                        ) : (
                            <span className="text-slate-600">IDLE</span>
                        )}
                    </p>
                </div>
            </div>
            <div className="text-right">
                <div className={`text-[10px] font-bold px-2 py-0.5 rounded-sm border ${liveChannel ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' : 'bg-slate-700/20 text-slate-500 border-slate-700'}`}>
                    {liveChannel?.replace(/^radio-/, '').toUpperCase() || 'NO COMMS'}
                </div>
            </div>
        </div>
    );
};

const DispatchCenterView: React.FC = () => {
    const { hydratedServiceRequests, rpcAction } = useData();
    const { allUsers, updateUserRecord } = useMembers();
    const { radioChannels, radioConfig } = useConfig();
    const { currentUser, hasPermission } = useAuth();
    const { addResponder } = useRequests();
    const { viewRequestDetails } = useNavigation();
    const { openModal, setIsCreateModalOpen, setIsAdHocModalOpen } = useModalRegistry();
    const now = useNow();

    const [tab, setTab] = useState<'cad' | 'mdt'>('cad');
    const [mdtQuery, setMdtQuery] = useState('');
    const [mdtTarget, setMdtTarget] = useState<string | null>(null);
    const [selectedRequest, setSelectedRequest] = useState<HydratedServiceRequest | null>(null);
    const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
    const [isRefreshingComms, setIsRefreshingComms] = useState(false);
    const [pendingDropTargets, setPendingDropTargets] = useState<Set<string>>(() => new Set());

    const runMdt = useCallback((handle: string) => {
        const h = handle.trim();
        if (!h) return;
        setMdtQuery(h);
        setMdtTarget(h);
        setTab('mdt');
    }, []);

    const handleMdtSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault();
        runMdt(mdtQuery);
    }, [mdtQuery, runMdt]);

    // Poll LiveKit for actual radio room presence. The async network fetch is
    // split from the synchronous "refreshing" flag: fetchRadioStatusCore only
    // touches state after the awaited RPC (setActiveRooms / clearing the flag in
    // finally), so it can be launched from the effect without setting state in
    // the effect body. The user-facing fetchRadioStatus wrapper additionally
    // flips the spinner on synchronously — that synchronous set is fine because
    // it runs from an event handler / timer callback, not during an effect.
    const fetchRadioStatusCore = useCallback(async () => {
        try {
            const data = await rpcAction('radio:status', {});
            setActiveRooms(data.activeChannels || []);
        } catch {
            // LiveKit may not be configured — silently ignore
        } finally {
            setIsRefreshingComms(false);
        }
    }, [rpcAction]);

    const fetchRadioStatus = useCallback(async () => {
        setIsRefreshingComms(true);
        await fetchRadioStatusCore();
    }, [fetchRadioStatusCore]);

    // The polling effect restarts whenever the fetch identity or the configured
    // flag changes. The original effect flipped the spinner on synchronously via
    // its immediate fetchRadioStatus() call; that synchronous set is reproduced
    // here at render time (React's documented "adjust state during render"
    // pattern) using a prev-key tracker, so the effect itself no longer sets
    // state synchronously. Behavior is preserved: the spinner shows for the
    // immediate poll exactly as before, and the awaited fetch clears it.
    const pollKey = radioConfig.configured ? fetchRadioStatusCore : null;
    const [prevPollKey, setPrevPollKey] = useState<typeof pollKey>(null);
    if (pollKey !== prevPollKey) {
        setPrevPollKey(pollKey);
        if (pollKey) setIsRefreshingComms(true);
    }

    useEffect(() => {
        // Don't poll when LiveKit isn't configured — saves a request every 5s.
        if (!radioConfig.configured) return;
        // fetchRadioStatusCore awaits the radio:status RPC before any setState, so
        // its updates are already off the synchronous effect path; awaiting it in
        // an inline async function makes that deferral explicit without changing
        // timing. The spinner's synchronous "true" was already moved to the
        // render-time tracker above.
        void (async () => { await fetchRadioStatusCore(); })();
        const interval = setInterval(fetchRadioStatus, 5000);
        return () => clearInterval(interval);
    }, [fetchRadioStatusCore, fetchRadioStatus, radioConfig.configured]);

    // Build a map of userId → roomName from live LiveKit data
    const userLiveChannelMap = useMemo(() => {
        const map = new Map<string, string>();
        for (const room of activeRooms) {
            for (const identity of room.participants) {
                map.set(identity, room.roomName);
            }
        }
        return map;
    }, [activeRooms]);

    // O(1) user lookup for the comms matrix occupant rendering.
    const usersById = useMemo(() => {
        const map = new Map<string, User>();
        for (const u of allUsers) map.set(String(u.id), u);
        return map;
    }, [allUsers]);

    // Precompute userId → activeRequest so the unit list doesn't re-scan
    // every request × every member on each render.
    const activeRequestByUserId = useMemo(() => {
        const map = new Map<number, HydratedServiceRequest>();
        for (const r of hydratedServiceRequests) {
            if (r.status !== ServiceRequestStatus.Accepted && r.status !== ServiceRequestStatus.InProgress) continue;
            for (const m of r.assignedMembers) {
                if (!map.has(m.id)) map.set(m.id, r);
            }
        }
        return map;
    }, [hydratedServiceRequests]);

    const activeRequests = useMemo(() =>
        hydratedServiceRequests.filter(r =>
            [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged, ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress].includes(r.status)
        ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        [hydratedServiceRequests]);

    const onDutyUnits = useMemo(() =>
        allUsers.filter(u => u.isDuty && u.role !== UserRole.Client),
        [allUsers]);

    // Hero stats — computed from the same data the CAD panels use so the
    // numbers always agree with what the operator sees below.
    const stats = useMemo(() => {
        const reqs = hydratedServiceRequests || [];
        const submitted = reqs.filter(r => r.status === ServiceRequestStatus.Submitted).length;
        const activeList = reqs.filter(r => r.status === ServiceRequestStatus.InProgress || r.status === ServiceRequestStatus.Accepted);
        const overdueCutoff = now - 2 * 60 * 60 * 1000; // 2 hours
        const overdue = activeList.filter(r => new Date(r.createdAt).getTime() < overdueCutoff).length;
        return {
            incoming: submitted,
            active: activeList.length,
            onDuty: onDutyUnits.length,
            overdue,
        };
    }, [hydratedServiceRequests, onDutyUnits, now]);

    const canViewIntel = hasPermission('intel:view') || hasPermission('intel:create');

    const [draggedUser, setDraggedUser] = useState<number | null>(null);

    const handleDragStart = (e: React.DragEvent, userId: number) => {
        setDraggedUser(userId);
        e.dataTransfer.effectAllowed = 'copyMove';
    };

    const markDropPending = (key: string, pending: boolean) => {
        setPendingDropTargets(prev => {
            const next = new Set(prev);
            if (pending) next.add(key); else next.delete(key);
            return next;
        });
    };

    const handleDropOnRequest = async (e: React.DragEvent, request: HydratedServiceRequest) => {
        e.preventDefault();
        if (!draggedUser) return;
        const key = `req-${request.id}`;
        if (pendingDropTargets.has(key)) return; // ignore double-drops
        markDropPending(key, true);
        try {
            await addResponder(request.id, draggedUser);
        } catch (error) {
            console.error("Assignment failed", error);
        } finally {
            markDropPending(key, false);
            setDraggedUser(null);
        }
    };

    const handleDropOnChannel = async (e: React.DragEvent, channelName: string) => {
        e.preventDefault();
        if (!draggedUser) return;
        const key = `ch-${channelName}`;
        if (pendingDropTargets.has(key)) return;
        markDropPending(key, true);
        try {
            await updateUserRecord(draggedUser, { voiceChannelName: channelName });
        } catch (error) {
            console.error("Radio move failed", error);
        } finally {
            markDropPending(key, false);
            setDraggedUser(null);
        }
    }

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · DISPATCH"
                chipIcon="fa-headset"
                chipAccent="cyan"
                title="Dispatch Console"
                subtitle="Live queue, unit coordination, and subject lookup. CAD for the room, MDT for the field."
                titleBreakpoint="lg"
                actions={
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 lg:min-w-[380px] w-full sm:w-auto">
                        <form onSubmit={handleMdtSubmit} className="relative flex-1">
                            <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-cyan-400/60 text-sm"></i>
                            <input
                                type="search"
                                value={mdtQuery}
                                onChange={(e) => setMdtQuery(e.target.value)}
                                placeholder="MDT · Search RSI handle…"
                                className="w-full bg-slate-900/60 text-white pl-9 pr-3 py-2.5 rounded-lg border border-cyan-500/30 placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 outline-hidden transition-all"
                            />
                        </form>
                        <HeroActionButton onClick={() => setIsAdHocModalOpen(true)} accent="sky" icon="fa-user-pen">
                            Log Ad-hoc
                        </HeroActionButton>
                    </div>
                }
                stats={<>
                    <HeroStat icon="fa-inbox" label="Incoming" value={stats.incoming} accent="red" emphasize={stats.incoming > 0} />
                    <HeroStat icon="fa-bolt" label="Active" value={stats.active} accent="sky" />
                    <HeroStat icon="fa-users" label="On-Duty" value={stats.onDuty} accent="emerald" />
                    <HeroStat icon="fa-clock" label="Overdue" value={stats.overdue} accent="amber" emphasize={stats.overdue > 0} />
                </>}
                tabs={<>
                    <button
                        onClick={() => setTab('cad')}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                            tab === 'cad' ? 'text-cyan-300 border-cyan-400' : 'text-slate-500 border-transparent hover:text-slate-300'
                        }`}
                    >
                        <i className="fa-solid fa-tower-broadcast"></i>
                        CAD · Dispatch
                    </button>
                    <button
                        onClick={() => setTab('mdt')}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                            tab === 'mdt' ? 'text-cyan-300 border-cyan-400' : 'text-slate-500 border-transparent hover:text-slate-300'
                        }`}
                    >
                        <i className="fa-solid fa-magnifying-glass"></i>
                        MDT · Lookup
                        {mdtTarget && (
                            <span className="ml-1 text-[10px] font-mono bg-cyan-500/20 text-cyan-200 px-1.5 py-0.5 rounded-sm">
                                {mdtTarget}
                            </span>
                        )}
                    </button>
                </>}
            />

            {tab === 'mdt' ? (
                <div className="flex-1 overflow-y-auto">
                    <MDTPanel
                        target={mdtTarget}
                        canViewIntel={canViewIntel}
                        onOpenRequest={(req) => { setSelectedRequest(req); }}
                        onChangeTarget={(h) => { setMdtQuery(h); setMdtTarget(h); }}
                    />
                </div>
            ) : (
            <div className="flex flex-col lg:flex-row flex-1 overflow-hidden">
                <div className="w-full lg:w-1/3 border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col h-1/3 lg:h-auto">
                    <div className="h-12 bg-slate-800/50 border-b border-white/5 flex items-center justify-between px-4 shrink-0">
                        <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wide">Active Incidents ({activeRequests.length})</h3>
                        <button onClick={() => setIsCreateModalOpen(true)} className="text-sky-400 hover:text-sky-300 transition-colors text-xs font-bold uppercase">
                            <i className="fa-solid fa-plus mr-1"></i> New Request
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-3">
                        {activeRequests.length > 0 ? activeRequests.map(request => {
                            const dropKey = `req-${request.id}`;
                            const isPending = pendingDropTargets.has(dropKey);
                            return (
                                <div
                                    key={request.id}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={(e) => handleDropOnRequest(e, request)}
                                    className={`relative rounded-lg transition-all ${isPending ? 'ring-2 ring-sky-400/60 ring-offset-2 ring-offset-slate-950' : ''}`}
                                >
                                    <IncidentCard
                                        request={request}
                                        onClick={() => setSelectedRequest(request)}
                                        onRunMdt={runMdt}
                                    />
                                    {isPending && (
                                        <div className="absolute inset-0 bg-slate-950/40 rounded-lg flex items-center justify-center pointer-events-none">
                                            <i className="fa-solid fa-circle-notch fa-spin text-sky-400" aria-hidden />
                                        </div>
                                    )}
                                </div>
                            );
                        }) : (
                            <EmptyState
                                icon="fa-inbox"
                                accent="cyan"
                                heading="No active incidents"
                                description="The queue is clear — incoming requests will appear here."
                                compact
                            />
                        )}
                    </div>
                </div>

                <div className="w-full lg:w-1/3 border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col h-1/3 lg:h-auto">
                    <div className="h-12 bg-slate-800/50 border-b border-white/5 flex items-center px-4 shrink-0">
                        <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wide">On-Duty Units ({onDutyUnits.length})</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-3">
                        {onDutyUnits.length > 0 ? onDutyUnits.map(user => (
                            <UnitCard
                                key={user.id}
                                user={user}
                                activeRequest={activeRequestByUserId.get(user.id)}
                                liveChannel={userLiveChannelMap.get(String(user.id))}
                                onDragStart={handleDragStart}
                            />
                        )) : (
                            <EmptyState
                                icon="fa-user-clock"
                                accent="emerald"
                                heading="No units on duty"
                                description="Personnel will appear here once they go on duty."
                                compact
                            />
                        )}
                    </div>
                </div>

                <div className="w-full lg:w-1/3 flex flex-col h-1/3 lg:h-auto">
                    <div className="h-12 bg-slate-800/50 border-b border-white/5 flex items-center px-4 shrink-0 justify-between">
                        <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wide">Comms Matrix</h3>
                        <button
                            onClick={fetchRadioStatus}
                            disabled={isRefreshingComms || !radioConfig.configured}
                            className="text-slate-500 hover:text-sky-400 transition-colors text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                            title={radioConfig.configured ? 'Refresh Comms' : 'LiveKit not configured'}
                        >
                            <i className={`fa-solid ${isRefreshingComms ? 'fa-circle-notch fa-spin' : 'fa-arrows-rotate'}`} aria-hidden></i>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
                        {!radioConfig.configured && (
                            <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
                                <i className="fa-solid fa-triangle-exclamation text-amber-500 text-[10px] mt-0.5"></i>
                                <p className="text-[10px] text-slate-500">
                                    <strong className="text-amber-400">LiveKit not configured.</strong> Live comms data is unavailable. Channel occupancy shown below will always be empty.
                                </p>
                            </div>
                        )}
                        {radioChannels.map(channel => {
                            // Use live LiveKit room presence instead of DB voiceChannelName
                            const roomName = `radio-${channel.id}`;
                            const liveRoom = activeRooms.find(r => r.roomName === roomName);
                            const occupants = liveRoom
                                ? liveRoom.participants
                                    .map(identity => usersById.get(identity))
                                    .filter((u): u is User => u != null)
                                : [];
                            const dropKey = `ch-${roomName}`;
                            const isPending = pendingDropTargets.has(dropKey);
                            return (
                                <div
                                    key={channel.id}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={(e) => handleDropOnChannel(e, roomName)}
                                    className={`relative bg-slate-800/30 border rounded-lg overflow-hidden group transition-all ${isPending ? 'border-sky-400/60 ring-1 ring-sky-400/40' : 'border-slate-700/50'}`}
                                >
                                    <div className="px-3 py-2 bg-slate-800/80 border-b border-white/5 flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: channel.color }}></div>
                                            <span className="font-bold text-xs text-slate-200 uppercase tracking-wide">{channel.name}</span>
                                        </div>
                                        <span className="text-[10px] font-mono text-slate-500">{occupants.length} Users</span>
                                    </div>
                                    <div className="p-2 min-h-[40px] transition-colors group-hover:bg-white/5">
                                        <div className="flex flex-wrap gap-2">
                                            {occupants.map(u => (
                                                <div
                                                    key={u.id}
                                                    draggable
                                                    onDragStart={(e) => handleDragStart(e, u.id)}
                                                    className="flex items-center gap-1.5 bg-slate-900 border border-slate-700 rounded-full pl-0.5 pr-2 py-0.5 cursor-grab active:cursor-grabbing hover:border-slate-500"
                                                >
                                                    <img src={u.avatarUrl} className="w-4 h-4 rounded-full" alt="" />
                                                    <span className="text-[10px] font-bold text-slate-300 truncate max-w-[80px]">{u.name}</span>
                                                </div>
                                            ))}
                                            {occupants.length === 0 && (
                                                <span className="text-[9px] text-slate-600 italic px-2">Channel Empty</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

            </div>
            )}

            <DispatchServiceRequestModal
                request={selectedRequest}
                onClose={() => setSelectedRequest(null)}
            />
        </div>
    );
};

export default DispatchCenterView;
