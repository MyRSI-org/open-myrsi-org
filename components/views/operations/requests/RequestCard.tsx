import React, { useMemo, useState } from 'react';
import {
    HydratedServiceRequest,
    ServiceRequestStatus,
    ThreatLevel,
    WarrantStatus,
    IntelThreatLevel,
} from '../../../../types';
import { useAuth } from '../../../../contexts/AuthContext';
import { useRequests } from '../../../../contexts/RequestsContext';
import { useConfig } from '../../../../contexts/ConfigContext';
import { useOperations } from '../../../../contexts/OperationsContext';
import { useIntel } from '../../../../contexts/IntelContext';
import { ACCENTS } from '../../../shared/ui/accents';
import ClientFlagPills from '../../../shared/ui/ClientFlagPills';
import { StatusPill, UrgencyPill, ThreatPill, IntelPill, WarrantPill } from './pills';
import StatusAdvancePopover from './StatusAdvancePopover';
import SlaBadge from './SlaBadge';
import ResponderStack from './ResponderStack';
import { statusAccent, timeAgoShort, reputationAccent } from './requestStyles';
import { useNotification } from '../../../../contexts/NotificationContext';
import { isCancellableByClient, isRateableStatus } from '../../../../lib/requestLifecycle';

interface Props {
    request: HydratedServiceRequest;
    onViewDetails: (req: HydratedServiceRequest) => void;
    onComplete: (req: HydratedServiceRequest) => void;
    onRate: (req: HydratedServiceRequest) => void;
    onManageResponders: (req: HydratedServiceRequest) => void;
    onUpdateStatus: (req: HydratedServiceRequest) => void;
    onTriage: (req: HydratedServiceRequest) => void;
}

const SHOW_SLA_FOR = new Set<ServiceRequestStatus>([
    ServiceRequestStatus.Submitted,
    ServiceRequestStatus.Triaged,
    ServiceRequestStatus.Accepted,
    ServiceRequestStatus.InProgress,
]);

const RequestCard: React.FC<Props> = ({
    request,
    onViewDetails,
    onComplete,
    onRate,
    onManageResponders,
    onUpdateStatus,
    onTriage,
}) => {
    const { currentUser, hasPermission } = useAuth();
    const { acceptRequest, refuseRequest, cancelRequest, deleteRequest } = useRequests();
    const { serviceTypes } = useConfig();
    const { warrants } = useOperations();
    const { intelTargetIndex } = useIntel();
    const { confirm, addToast } = useNotification();

    const isClientOwner = currentUser?.id === request.clientId;
    const isLead = currentUser?.id === request.leadResponderId;
    const isActionable = [ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress].includes(request.status);
    const canRefuse = request.client && request.client.reputation <= 15;

    const serviceConfig = serviceTypes.find(t => t.name === request.serviceType) || { color: '#cbd5e1', icon: 'fa-clipboard' };
    const clientRsiHandle = request.unregisteredClientRsiHandle || request.client?.rsiHandle;

    const hasActiveWarrant = useMemo(() => {
        if (!clientRsiHandle) return false;
        return warrants.some(w => w.targetRsiHandle.toLowerCase() === clientRsiHandle.toLowerCase() && w.status === WarrantStatus.Active);
    }, [warrants, clientRsiHandle]);

    const intelThreat = useMemo(() => {
        if (!clientRsiHandle) return null;
        return intelTargetIndex.get(clientRsiHandle.toLowerCase()) ?? null;
    }, [intelTargetIndex, clientRsiHandle]);

    const [loadingAction, setLoadingAction] = useState<string | null>(null);

    const statusA = ACCENTS[statusAccent(request.status)];
    const reqShortId = request.id.split('-')[1] ?? request.id.slice(0, 8);

    const handleAction = async (e: React.MouseEvent, action: () => Promise<void>, actionName: string) => {
        e.stopPropagation();
        if (loadingAction) return;
        setLoadingAction(actionName);
        try { await action(); }
        catch (err) { console.error(`Failed to ${actionName}`, err); }
        finally { setLoadingAction(null); }
    };

    const handleAccept = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (loadingAction || !currentUser) return;
        setLoadingAction('accept');
        try {
            await acceptRequest(request.id, currentUser.id);
            onViewDetails(request);
        } catch (err) { console.error('Failed to accept', err); }
        finally { setLoadingAction(null); }
    };

    const handleDelete = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (loadingAction) return;
        const confirmed = await confirm({
            title: 'Delete Request?',
            message: `Are you sure you want to permanently delete request ${request.id}? This action cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (confirmed) {
            setLoadingAction('delete');
            try { await deleteRequest(request.id); }
            catch (err) {
                console.error('Failed to delete', err);
                addToast('Delete Failed', <i className="fa-solid fa-circle-exclamation"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Could not delete the service request.' });
            } finally { setLoadingAction(null); }
        }
    };

    const handleCancel = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (loadingAction) return;
        const confirmed = await confirm({
            title: 'Cancel Request',
            message: 'Are you sure you want to cancel this request?',
            confirmText: 'Cancel Request',
            variant: 'danger',
        });
        if (!confirmed) return;
        setLoadingAction('cancel');
        try { await cancelRequest(request.id); }
        catch (err) {
            // The server refuses a cancel once the request has been picked up, and a stale tab
            // reaches that honestly. Swallowing the message into the console left the user
            // watching a spinner stop with nothing changed and no reason given.
            console.error('Failed to cancel', err);
            addToast(
                'Cancel failed',
                <i className="fa-solid fa-triangle-exclamation" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err instanceof Error ? err.message : 'Could not cancel this request.' },
            );
        }
        finally { setLoadingAction(null); }
    };

    const showSla = SHOW_SLA_FOR.has(request.status);
    const clientName = clientRsiHandle || 'Ad-Hoc Client';
    const repAccent = request.client ? ACCENTS[reputationAccent(request.client.reputation)] : null;

    return (
        <div
            onClick={() => !loadingAction && onViewDetails(request)}
            className={`group relative flex flex-col h-full rounded-xl overflow-hidden border border-white/10 bg-linear-to-br from-slate-900/80 via-slate-900/60 to-slate-950/80 backdrop-blur-xs shadow-lg transition-all duration-300 cursor-pointer hover:border-white/20 hover:shadow-xl ${loadingAction ? 'opacity-70 pointer-events-none' : ''}`}
        >
            <div className={`absolute inset-y-0 left-0 w-1 ${statusA.dot}`} aria-hidden />

            <div
                className={`absolute -top-20 -left-10 w-64 h-64 ${statusA.bg} rounded-full blur-[90px] opacity-0 group-hover:opacity-60 pointer-events-none transition-opacity duration-500`}
                aria-hidden
            />

            <div className="relative pl-4 pr-3 py-3 bg-slate-950/40 border-b border-white/5 flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <div
                        className="w-10 h-10 rounded-lg bg-slate-900/80 border border-white/10 flex items-center justify-center shrink-0 shadow-inner"
                        style={{ color: serviceConfig.color }}
                    >
                        <i className={`fa-solid ${serviceConfig.icon} text-base`} aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-bold text-sm leading-tight text-white truncate">{request.serviceType}</h3>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="font-mono text-[10px] text-slate-500 tracking-wider">REF-{reqShortId.toUpperCase()}</span>
                            <span className="text-slate-700">·</span>
                            <span className="text-[10px] text-slate-500 font-mono">
                                <i className="fa-regular fa-clock mr-1" aria-hidden />
                                {timeAgoShort(request.createdAt)}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {request.rated && request.clientRating && (
                        <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border bg-amber-500/10 border-amber-500/30 text-amber-400">
                            <i className="fa-solid fa-star text-[10px]" aria-hidden />
                            <span className="text-[10px] font-bold">{request.clientRating}/5</span>
                        </span>
                    )}
                    {showSla && (
                        <SlaBadge createdAt={request.createdAt} urgency={request.urgency} />
                    )}
                    {hasPermission('request:update') ? (
                        <StatusAdvancePopover
                            requestId={request.id}
                            currentStatus={request.status}
                            onMoreOptions={() => onUpdateStatus(request)}
                        />
                    ) : (
                        <StatusPill status={request.status} />
                    )}
                </div>
            </div>

            <div className="relative pl-4 pr-4 py-4 grow grid grid-cols-1 md:grid-cols-5 gap-4 min-h-0">
                <div className="md:col-span-2 flex flex-col gap-3 min-w-0">
                    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-950/40 border border-white/5">
                        {request.client?.avatarUrl ? (
                            <img
                                src={request.client.avatarUrl}
                                alt=""
                                className={`w-10 h-10 rounded-full border-2 shrink-0 object-cover ${repAccent ? repAccent.border : 'border-slate-700'}`}
                            />
                        ) : (
                            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center border-2 border-slate-700 shrink-0">
                                <i className="fa-solid fa-user text-slate-500" aria-hidden />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest">Client</p>
                            <div className="flex items-center gap-2 min-w-0">
                                <p className="text-white font-bold text-sm truncate">{clientName}</p>
                                <ClientFlagPills isAffiliate={request.client?.isAffiliate} isVip={request.client?.isVip} className="shrink-0" />
                            </div>
                            {request.client && (
                                <p className={`text-[10px] font-mono ${repAccent?.text ?? 'text-slate-400'}`}>
                                    REP · {request.client.reputation}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div>
                            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Location</p>
                            <p className="text-slate-200 text-sm font-medium leading-snug wrap-break-word flex items-start gap-2">
                                <i className="fa-solid fa-map-pin text-sky-400 mt-0.5 shrink-0" aria-hidden />
                                <span className="min-w-0">{request.location}</span>
                            </p>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                            <UrgencyPill urgency={request.urgency} />
                            {request.threatLevel !== ThreatLevel.None && <ThreatPill threat={request.threatLevel} />}
                            {hasActiveWarrant && !isClientOwner && <WarrantPill />}
                            {intelThreat && intelThreat !== IntelThreatLevel.None && <IntelPill level={intelThreat} />}
                        </div>
                    </div>
                </div>

                <div className="md:col-span-3 flex flex-col gap-3 min-w-0 md:border-l md:border-white/5 md:pl-4">
                    <div className="grow min-w-0">
                        <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Mission Briefing</p>
                        <p className="text-slate-300 text-sm leading-relaxed italic line-clamp-3">
                            &ldquo;{request.description}&rdquo;
                        </p>
                    </div>

                    {request.assignedMembers.length > 0 && (
                        <div>
                            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-2">
                                Responding Unit · {request.assignedMembers.length}
                            </p>
                            <ResponderStack
                                members={request.assignedMembers}
                                leadId={request.leadResponderId}
                            />
                        </div>
                    )}
                </div>
            </div>

            <div className="relative pl-4 pr-3 py-2.5 bg-slate-950/40 border-t border-white/5 flex flex-wrap justify-end gap-2 shrink-0">
                {isClientOwner && isCancellableByClient(request.status) && (
                    <button
                        onClick={handleCancel}
                        disabled={!!loadingAction}
                        className="px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                    >
                        {loadingAction === 'cancel' ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Cancel'}
                    </button>
                )}
                {hasPermission('request:accept') && !hasPermission('request:triage') && [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged].includes(request.status) && (
                    <>
                        {canRefuse && (
                            <button
                                onClick={(e) => handleAction(e, async () => { await refuseRequest(request.id, 'Low reputation'); }, 'refuse')}
                                disabled={!!loadingAction}
                                className="px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                            >
                                {loadingAction === 'refuse' ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Refuse'}
                            </button>
                        )}
                        <button
                            onClick={handleAccept}
                            disabled={!!loadingAction}
                            className="px-3 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-wider text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 shadow-lg shadow-emerald-900/30 transition-colors disabled:opacity-50"
                        >
                            {loadingAction === 'accept' ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : 'Accept'}
                        </button>
                    </>
                )}
                {hasPermission('request:triage') && request.status === ServiceRequestStatus.Submitted && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (!loadingAction) onTriage(request); }}
                        disabled={!!loadingAction}
                        className="px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                    >
                        Triage
                    </button>
                )}
                {(hasPermission('request:manage_responders') || hasPermission('request:set_lead') || (isLead && isActionable)) && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (!loadingAction) onManageResponders(request); }}
                        disabled={!!loadingAction}
                        className="px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-teal-500/10 text-teal-300 border border-teal-500/30 hover:bg-teal-500/20 transition-colors disabled:opacity-50"
                    >
                        Responders
                    </button>
                )}
                {hasPermission('request:update') && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (!loadingAction) onUpdateStatus(request); }}
                        disabled={!!loadingAction}
                        className="px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-slate-800/60 text-slate-300 border border-white/10 hover:bg-slate-700/80 transition-colors disabled:opacity-50"
                    >
                        Status / Log
                    </button>
                )}
                {hasPermission('request:complete') && isActionable && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (!loadingAction) onComplete(request); }}
                        disabled={!!loadingAction}
                        className="px-3 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-wider text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 shadow-lg shadow-emerald-900/30 transition-colors disabled:opacity-50"
                    >
                        Complete
                    </button>
                )}
                {isClientOwner && hasPermission('request:rate') && isRateableStatus(request.status) && !request.rated && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (!loadingAction) onRate(request); }}
                        disabled={!!loadingAction}
                        className="px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 transition-colors animate-pulse disabled:opacity-50"
                    >
                        Rate
                    </button>
                )}
                {hasPermission('request:delete') && (
                    <button
                        onClick={handleDelete}
                        disabled={!!loadingAction}
                        className="px-2 py-1.5 rounded-sm text-[10px] font-bold uppercase text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors flex items-center justify-center min-w-[32px] disabled:opacity-50"
                        title="Delete request"
                    >
                        {loadingAction === 'delete' ? <i className="fa-solid fa-spinner animate-spin" aria-hidden /> : <i className="fa-solid fa-trash" aria-hidden />}
                    </button>
                )}
            </div>
        </div>
    );
};

export default React.memo(RequestCard);
