import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ServiceRequestStatus,
    UserRole,
    HydratedServiceRequest,
    ThreatLevel,
    WarrantStatus,
    IntelThreatLevel,
    User,
} from '../../../types';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useRequests } from '../../../contexts/RequestsContext';
import { useData } from '../../../contexts/DataContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useOperations } from '../../../contexts/OperationsContext';
import CallsignChip from '../../shared/ui/CallsignChip';
import { ACCENTS } from '../../shared/ui/accents';
import { StatusPill, UrgencyPill, ThreatPill } from './requests/pills';
import SlaBadge from './requests/SlaBadge';
import MissionLogTimeline, { MissionLogEntry } from './requests/MissionLogTimeline';
import { useNotification } from '../../../contexts/NotificationContext';
import {
    statusAccent,
    reputationAccent,
    formatDateFull,
    timeAgo,
} from './requests/requestStyles';

interface ServiceRequestDetailViewProps {
    request: HydratedServiceRequest;
    onBack: () => void;
    openCompleteModal: (req: HydratedServiceRequest) => void;
    openRateRequestModal: (req: HydratedServiceRequest) => void;
    openAddResponderModal: (req: HydratedServiceRequest) => void;
    openUpdateStatusModal: (req: HydratedServiceRequest) => void;
    openTriageModal: (req: HydratedServiceRequest) => void;
    openDispatchModal: (req: HydratedServiceRequest) => void;
}

const SHOW_SLA_FOR = new Set<ServiceRequestStatus>([
    ServiceRequestStatus.Submitted,
    ServiceRequestStatus.Triaged,
    ServiceRequestStatus.Accepted,
    ServiceRequestStatus.InProgress,
]);

const StarRatingDisplay: React.FC<{ rating: number }> = ({ rating }) => (
    <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map(star => (
            <i
                key={star}
                className={`fa-solid fa-star text-sm transition-colors ${rating >= star ? 'text-amber-400' : 'text-slate-700'}`}
                style={{ animationDelay: `${star * 60}ms` }}
            />
        ))}
    </div>
);

const CopyChip: React.FC<{ value: string; label: string; accent?: 'sky' | 'slate' }> = ({ value, label, accent = 'sky' }) => {
    const [copied, setCopied] = useState(false);
    const a = ACCENTS[accent];
    return (
        <button
            onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
            className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border font-mono text-[10px] uppercase tracking-widest transition-colors ${a.bg} ${a.border} ${a.text} hover:brightness-125`}
            title="Copy ID"
        >
            <span>{label}</span>
            {copied
                ? <i className="fa-solid fa-check text-emerald-400" aria-hidden />
                : <i className="fa-regular fa-copy opacity-70" aria-hidden />}
        </button>
    );
};

const AddNoteCard: React.FC<{ requestId: string }> = ({ requestId }) => {
    const { addRequestNote } = useRequests();
    const [note, setNote] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async () => {
        if (!note.trim()) return;
        setSubmitting(true);
        try {
            await addRequestNote(requestId, note.trim());
            setNote('');
        } finally {
            setSubmitting(false);
        }
    };

    const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <div className="rounded-lg border border-white/10 bg-slate-950/40 p-3">
            <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={handleKey}
                rows={2}
                placeholder="Add mission log entry…   ⌘/Ctrl+Enter to send"
                disabled={submitting}
                className="w-full bg-slate-900/60 border border-white/10 rounded-md p-2 text-white text-xs focus:ring-1 focus:ring-sky-500/60 focus:border-sky-500/60 outline-hidden resize-none mb-2 placeholder:text-slate-600"
            />
            <button
                onClick={handleSubmit}
                disabled={!note.trim() || submitting}
                className="w-full py-1.5 text-xs font-black uppercase tracking-widest text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
                {submitting ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Log Entry'}
            </button>
        </div>
    );
};

// Reputation bar for the client identity card. Hoisted to module scope so the
// JSX isn't an IIFE (which the React Compiler can't optimize).
const ClientReputationBar: React.FC<{ client: User }> = ({ client }) => {
    const repA = ACCENTS[reputationAccent(client.reputation)];
    const pct = Math.max(0, Math.min(100, client.reputation));
    return (
        <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest mb-1">
                <span className="text-slate-500">Reputation</span>
                <span className={`font-bold ${repA.text}`}>{client.reputation}</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-900 border border-white/5 overflow-hidden">
                <div className={`h-full ${repA.dot} transition-all`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
};

// Operational team roster (lead + responders). Hoisted to module scope so the
// JSX isn't an IIFE (which the React Compiler can't optimize).
const OperationalTeamRoster: React.FC<{ assignedMembers: User[]; leadResponderId?: number }> = ({ assignedMembers, leadResponderId }) => {
    if (assignedMembers.length === 0) {
        return (
            <div className="text-center py-4 text-slate-500 italic text-xs uppercase tracking-widest bg-slate-950/30 rounded-lg border border-dashed border-white/5">
                Unit unassigned
            </div>
        );
    }
    const lead = assignedMembers.find(m => m.id === leadResponderId);
    const others = assignedMembers.filter(m => m.id !== leadResponderId);
    return (
        <div className="space-y-3">
            {lead && (
                <div>
                    <p className="text-[9px] font-black text-amber-400/80 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                        <i className="fa-solid fa-crown text-[9px]" aria-hidden /> Lead Responder
                    </p>
                    <div className="flex items-center gap-3 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
                        <div className="relative shrink-0">
                            <img src={lead.avatarUrl} alt="" className="w-10 h-10 rounded-full border-2 border-amber-400 object-cover" />
                            <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 border-2 border-slate-950 flex items-center justify-center">
                                <i className="fa-solid fa-crown text-[7px] text-black" aria-hidden />
                            </div>
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold truncate text-amber-100">{lead.name}</p>
                            <p className="text-[9px] text-slate-500 uppercase tracking-widest truncate">{lead.rank?.name || 'Operative'}</p>
                        </div>
                    </div>
                </div>
            )}

            {others.length > 0 && (
                <div>
                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                        Responding Unit · {others.length}
                    </p>
                    <div className="space-y-1.5">
                        {others.map(member => (
                            <div
                                key={member.id}
                                className="flex items-center gap-2.5 p-2 rounded-lg border border-white/5 bg-slate-950/30"
                            >
                                <img src={member.avatarUrl} alt="" className="w-8 h-8 rounded-full border-2 border-slate-700 shrink-0 object-cover" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-bold truncate text-slate-200">{member.name}</p>
                                    <p className="text-[9px] text-slate-500 uppercase tracking-widest truncate">{member.rank?.name || 'Operative'}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

interface SectionCardProps {
    id: string;
    icon: string;
    title: string;
    /** Accent hint for the card rail. Defaults to slate. */
    accent?: keyof typeof ACCENTS;
    /** Pulses the rail and tint when true — used for the risk-alarm state. */
    alarm?: boolean;
    children: React.ReactNode;
    collapsedIds: Set<string>;
    onToggle: (id: string) => void;
    /** Content rendered to the right of the title on the header row. */
    trailing?: React.ReactNode;
}

const SectionCard: React.FC<SectionCardProps> = ({ id, icon, title, accent = 'slate', alarm = false, children, collapsedIds, onToggle, trailing }) => {
    const a = ACCENTS[accent];
    const collapsed = collapsedIds.has(id);

    return (
        <section className={`relative rounded-xl border overflow-hidden ${alarm ? 'border-red-500/40 bg-red-950/10' : 'border-white/10 bg-slate-900/40'}`}>
            <div className={`absolute inset-y-0 left-0 w-0.5 ${alarm ? 'bg-red-500 animate-pulse' : a.dot} opacity-70`} aria-hidden />
            <button
                type="button"
                onClick={() => onToggle(id)}
                className="w-full flex items-center justify-between gap-2 px-4 py-3 border-b border-white/5 md:border-b md:cursor-default md:pointer-events-none"
            >
                <div className="flex items-center gap-2 min-w-0">
                    <i className={`fa-solid ${icon} text-sm ${alarm ? 'text-red-400' : a.text}`} aria-hidden />
                    <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest truncate">{title}</h3>
                </div>
                <div className="flex items-center gap-2">
                    {trailing}
                    <i
                        className={`fa-solid fa-chevron-down text-[10px] text-slate-500 transition-transform md:hidden ${collapsed ? '' : 'rotate-180'}`}
                        aria-hidden
                    />
                </div>
            </button>
            <div className={`${collapsed ? 'hidden' : 'block'} md:block p-4`}>
                {children}
            </div>
        </section>
    );
};

const ServiceRequestDetailView: React.FC<ServiceRequestDetailViewProps> = ({
    request: initialRequest,
    onBack,
    openCompleteModal,
    openRateRequestModal,
    openAddResponderModal,
    openUpdateStatusModal,
    openTriageModal,
    openDispatchModal,
}) => {
    const { currentUser, hasPermission } = useAuth();
    const { acceptRequest, cancelRequest, startMission, deleteRequest } = useRequests();
    const fmt = useFormatDate();
    const { rpcAction, hydratedServiceRequests, isFetching } = useData();
    const { serviceTypes } = useConfig();
    const { warrants } = useOperations();
    const { confirm, addToast } = useNotification();
    const [loadingAction, setLoadingAction] = useState<string | null>(null);

    // Always read latest from live data if present (so background refreshes flow in)
    const request = useMemo(() => {
        const live = hydratedServiceRequests.find(r => r.id === initialRequest.id);
        return live ?? initialRequest;
    }, [hydratedServiceRequests, initialRequest]);

    const [intelThreat, setIntelThreat] = useState<IntelThreatLevel | null>(null);
    const [intelLoading, setIntelLoading] = useState(false);
    const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set(['parameters', 'log']));
    const [showMoreActions, setShowMoreActions] = useState(false);
    const [showCheatsheet, setShowCheatsheet] = useState(false);
    const moreRef = useRef<HTMLDivElement>(null);

    const isClientOwner = currentUser?.id === request.clientId;
    const isLead = currentUser?.id === request.leadResponderId;
    const isActiveMission = [ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress].includes(request.status);
    const isStaff = currentUser?.role !== UserRole.Client;
    const canViewFeedback = hasPermission('request:view:feedback');
    const showSla = SHOW_SLA_FOR.has(request.status);

    const clientRsiHandle = (request.client?.rsiHandle || request.unregisteredClientRsiHandle || '').trim();
    const clientDisplayName = request.client?.name || request.unregisteredClientRsiHandle || 'Unknown Client';
    const clientDisplayHandle = request.client?.rsiHandle || request.unregisteredClientRsiHandle || 'N/A';
    const reqShortId = request.id.split('-')[1]?.toUpperCase() ?? request.id.slice(0, 8).toUpperCase();

    const serviceConfig = useMemo(() => {
        return serviceTypes.find(t => t.name === request.serviceType) || { icon: 'fa-circle-question', color: '#94a3b8' };
    }, [request.serviceType, serviceTypes]);

    const hasActiveWarrant = useMemo(() => {
        if (!clientRsiHandle) return false;
        return warrants.some(w =>
            w.targetRsiHandle.toLowerCase() === clientRsiHandle.toLowerCase() &&
            (w.status === WarrantStatus.Active || w.status === WarrantStatus.Standing)
        );
    }, [warrants, clientRsiHandle]);

    const intelAlarm = !!intelThreat && (intelThreat === IntelThreatLevel.Critical || intelThreat === IntelThreatLevel.High);
    const riskAlarm = hasActiveWarrant || intelAlarm;

    // Fetch intel once per handle
    useEffect(() => {
        let mounted = true;
        const fetchIntel = async () => {
            if (!clientRsiHandle || !isStaff) return;
            setIntelLoading(true);
            try {
                const reports = await rpcAction('intel:get_reports', { targetId: clientRsiHandle });
                if (mounted && Array.isArray(reports)) {
                    const levels = [IntelThreatLevel.None, IntelThreatLevel.Low, IntelThreatLevel.Medium, IntelThreatLevel.High, IntelThreatLevel.Critical];
                    let max: IntelThreatLevel = IntelThreatLevel.None;
                    reports.forEach((r: any) => {
                        if (levels.indexOf(r.threatLevel) > levels.indexOf(max)) max = r.threatLevel;
                    });
                    setIntelThreat(max);
                }
            } catch (e) {
                console.error('Failed to fetch intel', e);
            } finally {
                if (mounted) setIntelLoading(false);
            }
        };
        fetchIntel();
        return () => { mounted = false; };
    }, [clientRsiHandle, rpcAction, isStaff]);

    const logEntries: MissionLogEntry[] = useMemo(() => {
        return request.hydratedStatusHistory && request.hydratedStatusHistory.length > 0
            ? [...request.hydratedStatusHistory].reverse()
            : [];
    }, [request.hydratedStatusHistory]);

    const handleAction = useCallback(async (action: () => Promise<void>, actionName: string) => {
        setLoadingAction(actionName);
        try { await action(); }
        catch (err) { console.error(`Failed to ${actionName}`, err); }
        finally { setLoadingAction(null); }
    }, []);

    const handleDelete = async () => {
        const confirmed = await confirm({
            title: 'Confirm Delete',
            message: 'Are you sure you want to permanently delete this request?',
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (!confirmed) return;
        setLoadingAction('delete');
        try {
            await deleteRequest(request.id);
            onBack();
        } catch (err) {
            console.error('Failed to delete request:', err);
            addToast('Delete Failed', <i className="fa-solid fa-xmark" aria-hidden />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Failed to delete the service request.' });
            setLoadingAction(null);
        }
    };

    const copyRef = useCallback(() => {
        navigator.clipboard.writeText(request.id);
        addToast('Copied', <i className="fa-solid fa-check" aria-hidden />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/40', { description: `REF-${reqShortId} copied to clipboard.` });
    }, [request.id, reqShortId, addToast]);

    const toggleSection = useCallback((id: string) => {
        setCollapsedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    /* Close "More" popover when clicking outside */
    useEffect(() => {
        if (!showMoreActions) return;
        const onDoc = (e: MouseEvent) => {
            if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMoreActions(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [showMoreActions]);

    /* Eligibility flags for primary action resolution */
    const canAssign = hasPermission('request:dispatch') && [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged].includes(request.status);
    const canAcceptMission = hasPermission('request:accept') && [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged].includes(request.status);
    // Gate on 'request:dispatch' (the permission); 'request:dispatch_members' is an
    // action name gated server-side by request:dispatch, not a grantable permission.
    const canDispatchUnit = hasPermission('request:dispatch') && [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged].includes(request.status);
    const canLaunch = (hasPermission('request:start') || isLead) && request.status === ServiceRequestStatus.Accepted;
    const canManageResponders = (hasPermission('request:manage_responders') || hasPermission('request:set_lead') || isLead) && isActiveMission;
    const canUpdate = hasPermission('request:update');
    const canComplete = (hasPermission('request:complete') || isLead) && isActiveMission;
    const canCancel = isClientOwner && request.status === ServiceRequestStatus.Submitted;
    const canRate = isClientOwner && hasPermission('request:rate') && request.status === ServiceRequestStatus.Success && !request.rated;
    const canDelete = hasPermission('request:delete');

    /* Keyboard shortcuts */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tgt = e.target as HTMLElement | null;
            if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
            if (e.altKey || e.metaKey || e.ctrlKey) return;
            switch (e.key) {
                case 'Escape': onBack(); break;
                case '?': setShowCheatsheet(s => !s); break;
                case 'c': case 'C': copyRef(); break;
                case 'e': case 'E':
                    if (canUpdate) openUpdateStatusModal(request);
                    break;
                case 'a': case 'A':
                    if (canAcceptMission && !loadingAction && currentUser) handleAction(() => acceptRequest(request.id, currentUser.id), 'accept');
                    break;
                case 'r': case 'R':
                    if (canComplete) openCompleteModal(request);
                    break;
                default: return;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onBack, copyRef, canUpdate, canAcceptMission, canComplete, openUpdateStatusModal, openCompleteModal, request, acceptRequest, currentUser, handleAction, loadingAction]);

    if (!currentUser) return null;

    const statusA = ACCENTS[statusAccent(request.status)];

    return (
        <div className="flex flex-col h-full bg-slate-950 overflow-hidden">
            <header className={`shrink-0 relative overflow-hidden border-b border-white/5 ${statusA.heroGrad}`}>
                <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] ${statusA.heroOrb} rounded-full blur-[120px] pointer-events-none`} aria-hidden />
                <div className="relative px-4 sm:px-8 pt-4 sm:pt-6 pb-4">
                    <div className="max-w-7xl mx-auto w-full">
                        <button
                            onClick={onBack}
                            className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors mb-3"
                        >
                            <i className="fa-solid fa-arrow-left" aria-hidden /> Return to feed
                        </button>

                        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3 lg:gap-4">
                            <div className="min-w-0 flex items-center gap-4">
                                <div
                                    className="hidden sm:flex w-14 h-14 md:w-16 md:h-16 rounded-xl bg-slate-900/80 border border-white/10 items-center justify-center shadow-inner shrink-0"
                                    style={{ color: serviceConfig.color }}
                                >
                                    <i className={`fa-solid ${serviceConfig.icon} text-2xl md:text-3xl`} aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <div className="hidden sm:flex items-center gap-2 mb-2">
                                        <CallsignChip
                                            label={`MISSION · REF-${reqShortId}`}
                                            icon="fa-satellite-dish"
                                            accent={statusAccent(request.status)}
                                            pulse={isActiveMission}
                                        />
                                        <CopyChip value={request.id} label="Copy" accent="slate" />
                                    </div>
                                    <h1 className="text-2xl sm:text-3xl md:text-4xl font-black text-white tracking-tight leading-tight flex items-center gap-3 flex-wrap">
                                        <span className="truncate">{request.serviceType} Request</span>
                                        {isFetching['service_requests'] && (
                                            <span className={`${statusA.text} text-xs font-mono uppercase tracking-widest animate-pulse inline-flex items-center gap-1`}>
                                                <i className="fa-solid fa-arrows-rotate fa-spin" aria-hidden /> Syncing
                                            </span>
                                        )}
                                    </h1>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <StatusPill status={request.status} size="md" showIcon />
                                <UrgencyPill urgency={request.urgency} size="md" />
                                {request.threatLevel !== ThreatLevel.None && <ThreatPill threat={request.threatLevel} size="md" />}
                                {showSla && <SlaBadge createdAt={request.createdAt} urgency={request.urgency} size="md" />}
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            <div className="shrink-0 sticky top-0 z-30 backdrop-blur-md bg-slate-950/80 border-b border-white/5">
                <div className="max-w-7xl mx-auto w-full px-4 sm:px-8 py-3 flex flex-wrap items-center gap-2">
                    {canAssign && (
                        <button onClick={() => openTriageModal(request)} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 transition-colors disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-filter" aria-hidden /> Assign
                        </button>
                    )}
                    {canAcceptMission && (
                        <button onClick={() => handleAction(() => acceptRequest(request.id, currentUser.id), 'accept')} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 shadow-lg shadow-sky-900/30 transition disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-handshake" aria-hidden /> {loadingAction === 'accept' ? 'Syncing…' : 'Accept'}
                        </button>
                    )}
                    {canDispatchUnit && (
                        <button onClick={() => openDispatchModal(request)} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-teal-500/10 text-teal-300 border border-teal-500/30 hover:bg-teal-500/20 transition-colors disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-tower-broadcast" aria-hidden /> Dispatch
                        </button>
                    )}
                    {canLaunch && (
                        <button onClick={() => handleAction(() => startMission(request.id), 'start')} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 shadow-lg shadow-emerald-900/30 transition disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-jet-fighter-up" aria-hidden /> {loadingAction === 'start' ? 'Starting…' : 'Launch'}
                        </button>
                    )}
                    {canManageResponders && (
                        <button onClick={() => openAddResponderModal(request)} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-teal-500/10 text-teal-300 border border-teal-500/30 hover:bg-teal-500/20 transition-colors disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-users-gear" aria-hidden /> Responders
                        </button>
                    )}
                    {canUpdate && (
                        <button onClick={() => openUpdateStatusModal(request)} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-slate-800/60 text-slate-200 border border-white/10 hover:bg-slate-700/80 transition-colors disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-pen-to-square" aria-hidden /> Update
                        </button>
                    )}
                    {canComplete && (
                        <button onClick={() => openCompleteModal(request)} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 shadow-lg shadow-emerald-900/30 transition disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-flag-checkered" aria-hidden /> Complete
                        </button>
                    )}
                    {canRate && (
                        <button onClick={() => openRateRequestModal(request)} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-amber-200 bg-amber-500/20 border border-amber-500/40 hover:bg-amber-500/30 shadow-lg shadow-amber-900/20 transition animate-pulse disabled:opacity-50 flex items-center gap-2">
                            <i className="fa-solid fa-star" aria-hidden /> Rate Service
                        </button>
                    )}

                    {/* Destructive group pushed right */}
                    <div className="ml-auto flex items-center gap-2">
                        {canCancel && (
                            <button onClick={() => handleAction(() => cancelRequest(request.id), 'cancel')} disabled={!!loadingAction} className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20 transition-colors disabled:opacity-50 flex items-center gap-2">
                                <i className="fa-solid fa-ban" aria-hidden /> Cancel
                            </button>
                        )}
                        {canDelete && (
                            <button onClick={handleDelete} disabled={!!loadingAction} className="px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 flex items-center gap-2" title="Delete (permanent)">
                                {loadingAction === 'delete' ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : <i className="fa-solid fa-trash" aria-hidden />}
                                <span className="hidden sm:inline">Delete</span>
                            </button>
                        )}
                        <button
                            onClick={() => setShowCheatsheet(s => !s)}
                            className="hidden lg:flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-slate-300 border border-transparent hover:border-white/10 hover:bg-slate-800/40 transition-colors"
                            title="Keyboard shortcuts (?)"
                        >
                            <i className="fa-solid fa-keyboard" aria-hidden /> Keys
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-7xl mx-auto w-full px-4 sm:px-8 py-6 grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                    <div className="space-y-4 lg:space-y-6">
                        <SectionCard id="client" icon="fa-user-circle" title="Client Identity" accent="sky" collapsedIds={collapsedIds} onToggle={toggleSection}>
                            <div className="flex items-start gap-3">
                                {request.client?.avatarUrl ? (
                                    <img
                                        src={request.client.avatarUrl}
                                        alt=""
                                        className={`w-14 h-14 rounded-full border-2 shrink-0 object-cover ${ACCENTS[reputationAccent(request.client.reputation)].border}`}
                                    />
                                ) : (
                                    <div className="w-14 h-14 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center shrink-0">
                                        <i className="fa-solid fa-user text-slate-500 text-xl" aria-hidden />
                                    </div>
                                )}
                                <div className="min-w-0 flex-1">
                                    <h3 className="text-lg font-bold text-white truncate">{clientDisplayName}</h3>
                                    <p className="text-sky-400 font-mono text-xs truncate">@{clientDisplayHandle}</p>
                                    {request.client && <ClientReputationBar client={request.client} />}
                                </div>
                            </div>
                        </SectionCard>

                        {/* Risk (staff only) */}
                        {isStaff && (
                            <SectionCard
                                id="risk"
                                icon="fa-shield-halved"
                                title="Risk Assessment"
                                accent={riskAlarm ? 'red' : 'emerald'}
                                alarm={riskAlarm}
                                collapsedIds={collapsedIds}
                                onToggle={toggleSection}
                            >
                                <div className="space-y-2.5">
                                    <div className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border ${hasActiveWarrant ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'}`}>
                                        <div className="flex items-center gap-2 min-w-0">
                                            <i className={`fa-solid ${hasActiveWarrant ? 'fa-triangle-exclamation animate-pulse' : 'fa-circle-check'} text-sm shrink-0`} aria-hidden />
                                            <span className="text-[10px] font-black uppercase tracking-widest truncate">{hasActiveWarrant ? 'Active cautions' : 'No active cautions'}</span>
                                        </div>
                                        {hasActiveWarrant && <span className="text-[9px] font-mono opacity-70 shrink-0">CAUTION</span>}
                                    </div>
                                    <div className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border ${intelThreat ? `${ACCENTS[intelAlarm ? 'red' : intelThreat === IntelThreatLevel.None ? 'slate' : 'amber'].border} ${ACCENTS[intelAlarm ? 'red' : intelThreat === IntelThreatLevel.None ? 'slate' : 'amber'].bg} ${ACCENTS[intelAlarm ? 'red' : intelThreat === IntelThreatLevel.None ? 'slate' : 'amber'].text}` : 'border-white/10 bg-slate-950/30 text-slate-500'}`}>
                                        <div className="flex items-center gap-2 min-w-0">
                                            <i className="fa-solid fa-database text-sm shrink-0" aria-hidden />
                                            <span className="text-[10px] font-black uppercase tracking-widest truncate">Intel Analysis</span>
                                        </div>
                                        {intelLoading
                                            ? <i className="fa-solid fa-circle-notch animate-spin text-xs" aria-hidden />
                                            : <span className="text-[10px] font-black uppercase tracking-widest shrink-0">{intelThreat || 'No data'}</span>}
                                    </div>
                                </div>
                            </SectionCard>
                        )}

                        <SectionCard
                            id="team"
                            icon="fa-people-group"
                            title="Operational Team"
                            accent="cyan"
                            collapsedIds={collapsedIds}
                            onToggle={toggleSection}
                            trailing={request.assignedMembers.length > 0 && (
                                <span className="text-[10px] font-mono font-bold text-slate-500 tracking-wider">
                                    {request.assignedMembers.length}
                                </span>
                            )}
                        >
                            <OperationalTeamRoster assignedMembers={request.assignedMembers} leadResponderId={request.leadResponderId} />
                        </SectionCard>

                        {((request.secondaryClientHandles && request.secondaryClientHandles.length > 0) || request.partyInfo) && (
                            <SectionCard id="party" icon="fa-users" title="Party Manifest" accent="purple" collapsedIds={collapsedIds} onToggle={toggleSection}>
                                {request.partyInfo && <p className="text-xs text-slate-400 mb-3 italic leading-relaxed">&ldquo;{request.partyInfo}&rdquo;</p>}
                                {request.secondaryClientHandles && request.secondaryClientHandles.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {request.secondaryClientHandles.map(handle => (
                                            <span key={handle} className="text-[10px] bg-slate-950/40 border border-white/10 text-slate-300 px-2 py-1 rounded-sm font-mono">
                                                @{handle}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </SectionCard>
                        )}

                        {[ServiceRequestStatus.Success, ServiceRequestStatus.Failed, ServiceRequestStatus.GameError, ServiceRequestStatus.Aborted].includes(request.status) && (
                            <SectionCard id="outcome" icon="fa-flag-checkered" title="Mission Outcome" accent={request.status === ServiceRequestStatus.Success ? 'emerald' : 'red'} collapsedIds={collapsedIds} onToggle={toggleSection}>
                                <div className="space-y-3">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="p-3 rounded-lg border border-white/5 bg-slate-950/40">
                                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">UEC Earned</p>
                                            <div className="flex items-center gap-2">
                                                <i className="fa-solid fa-coins text-amber-400" aria-hidden />
                                                <span className="text-white font-black font-mono">{(request.uecEarned || 0).toLocaleString()}</span>
                                            </div>
                                        </div>
                                        <div className="p-3 rounded-lg border border-white/5 bg-slate-950/40">
                                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Medigel</p>
                                            <div className="flex items-center gap-2">
                                                <i className="fa-solid fa-syringe text-emerald-400" aria-hidden />
                                                <span className="text-white font-black font-mono">{request.medigelConsumed || 0}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="p-3 rounded-lg border border-white/5 bg-slate-950/40">
                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Client Rating</p>
                                        {request.clientRating ? (
                                            <div className="flex items-center gap-2.5">
                                                <StarRatingDisplay rating={request.clientRating} />
                                                <span className="text-amber-300 font-black text-sm">{request.clientRating}/5</span>
                                            </div>
                                        ) : (
                                            <p className="text-slate-500 text-xs italic">{request.rated ? 'N/A' : 'Awaiting client…'}</p>
                                        )}
                                    </div>
                                    {request.clientFeedback && canViewFeedback && (
                                        <div className="p-3 rounded-lg border border-white/5 bg-slate-950/50">
                                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Client Feedback</p>
                                            <p className="text-sm text-slate-300 leading-relaxed italic">&ldquo;{request.clientFeedback}&rdquo;</p>
                                        </div>
                                    )}
                                </div>
                            </SectionCard>
                        )}
                    </div>

                    <div className="lg:col-span-2 space-y-4 lg:space-y-6">
                        <SectionCard id="parameters" icon="fa-map-location-dot" title="Mission Parameters" accent="sky" collapsedIds={collapsedIds} onToggle={toggleSection}>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm mb-4">
                                <dt className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 pt-0.5">
                                    <i className="fa-solid fa-map-pin text-sky-400" aria-hidden />
                                    Location
                                </dt>
                                <dd className="text-white font-bold leading-snug wrap-break-word">{request.location}</dd>

                                <dt className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 pt-0.5">
                                    <i className="fa-solid fa-skull-crossbones text-orange-400" aria-hidden />
                                    Threat
                                </dt>
                                <dd className="flex"><ThreatPill threat={request.threatLevel} /></dd>

                                <dt className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 pt-0.5">
                                    <i className="fa-solid fa-bolt text-amber-400" aria-hidden />
                                    Priority
                                </dt>
                                <dd className="flex"><UrgencyPill urgency={request.urgency} /></dd>

                                <dt className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 pt-0.5">
                                    <i className="fa-solid fa-stopwatch text-slate-400" aria-hidden />
                                    Reported
                                </dt>
                                <dd className="text-slate-300 font-mono text-xs">{formatDateFull(request.createdAt, fmt.prefs)} <span className="text-slate-600">· {timeAgo(request.createdAt)}</span></dd>

                                <dt className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 pt-0.5">
                                    <i className="fa-solid fa-clock-rotate-left text-slate-400" aria-hidden />
                                    Last update
                                </dt>
                                <dd className="text-slate-300 font-mono text-xs">{formatDateFull(request.updatedAt, fmt.prefs)} <span className="text-slate-600">· {timeAgo(request.updatedAt)}</span></dd>
                            </dl>

                            <div>
                                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Initial Briefing</p>
                                <div className="rounded-lg border border-white/10 bg-slate-950/50 p-4 text-slate-200 text-sm leading-relaxed whitespace-pre-wrap font-mono min-h-[80px]">
                                    {request.description}
                                </div>
                            </div>
                        </SectionCard>

                        <SectionCard
                            id="log"
                            icon="fa-timeline"
                            title="Mission Log"
                            accent="cyan"
                            collapsedIds={collapsedIds}
                            onToggle={toggleSection}
                            trailing={logEntries.length > 0 && (
                                <span className="text-[10px] font-mono font-bold text-slate-500 tracking-wider">
                                    {logEntries.length}
                                </span>
                            )}
                        >
                            <div className="space-y-4">
                                {isStaff && <AddNoteCard requestId={request.id} />}
                                <MissionLogTimeline entries={logEntries} />
                            </div>
                        </SectionCard>
                    </div>
                </div>
            </div>

            {showCheatsheet && (
                <div className="fixed bottom-6 right-6 z-40 w-72 rounded-xl border border-white/10 bg-slate-950/95 backdrop-blur-md shadow-2xl p-4 animate-fade-in-up">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="text-[10px] font-black text-slate-300 uppercase tracking-widest flex items-center gap-2">
                            <i className="fa-solid fa-keyboard text-sky-400" aria-hidden /> Keyboard
                        </h4>
                        <button onClick={() => setShowCheatsheet(false)} className="text-slate-500 hover:text-white transition-colors">
                            <i className="fa-solid fa-xmark" aria-hidden />
                        </button>
                    </div>
                    <dl className="space-y-1.5 text-xs">
                        {[
                            ['E', 'Update status'],
                            ['A', 'Accept mission'],
                            ['R', 'Resolve / Complete'],
                            ['C', 'Copy REF ID'],
                            ['?', 'Toggle this panel'],
                            ['Esc', 'Return to feed'],
                        ].map(([key, label]) => (
                            <div key={key} className="flex items-center justify-between">
                                <dt className="text-slate-400">{label}</dt>
                                <dd>
                                    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-sm border border-white/10 bg-slate-900 text-[10px] font-mono font-bold text-slate-200">
                                        {key}
                                    </kbd>
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}
        </div>
    );
};

export default ServiceRequestDetailView;
