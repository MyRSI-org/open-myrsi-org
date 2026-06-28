
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HydratedOperation, OperationStatus, OperationType, UserShip } from '../../../types';
import { useAuth } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useOperations } from '../../../contexts/OperationsContext';

import AddUecModal from '../../modals/AddUecModal';
import AddCostModal from '../../modals/AddCostModal';
import AddParticipantModal from '../../modals/AddParticipantModal';
import ManageParticipantModal from '../../modals/ManageParticipantModal';
import OpSituationTab from './tabs/OpSituationTab';
import OpMissionTab from './tabs/OpMissionTab';
import OpExecutionTab from './tabs/OpExecutionTab';
import OpAdminLogisticsTab from './tabs/OpAdminLogisticsTab';
import OpCommandSignalsTab from './tabs/OpCommandSignalsTab';
import OpAARTab from './tabs/OpAARTab';
import OpAdministerTab from './tabs/OpAdministerTab';
import OpLiveMyStatusTab from './tabs/OpLiveMyStatusTab';
import OpLiveOverviewTab from './tabs/OpLiveOverviewTab';
import OpLiveCommandTab from './tabs/OpLiveCommandTab';
import { useOpRadio } from '../../../hooks/useOpRadio';
import { useRadio } from '../../../contexts/RadioContext';
import CallsignChip from '../../shared/ui/CallsignChip';
import { useNotification } from '../../../contexts/NotificationContext';

const getTypeStyles = (type: OperationType) => {
    switch (type) {
        case OperationType.PvP: return { class: 'text-red-400 border-red-500/30 bg-red-500/10', icon: 'fa-solid fa-skull-crossbones' };
        case OperationType.PvE: return { class: 'text-orange-400 border-orange-500/30 bg-orange-500/10', icon: 'fa-solid fa-shield-halved' };
        case OperationType.Mixed: return { class: 'text-purple-400 border-purple-500/30 bg-purple-500/10', icon: 'fa-solid fa-arrows-split-up-and-left' };
        case OperationType.NonCombat:
        default: return { class: 'text-sky-400 border-sky-500/30 bg-sky-500/10', icon: 'fa-solid fa-handshake' };
    }
};

const PHASE_STEPS = [
    { key: OperationStatus.Planning, label: 'Planning', icon: 'fa-solid fa-drafting-compass', color: 'purple' },
    { key: OperationStatus.Scheduled, label: 'Scheduled', icon: 'fa-solid fa-clock', color: 'amber' },
    { key: OperationStatus.Active, label: 'Active', icon: 'fa-solid fa-bolt', color: 'green' },
    { key: OperationStatus.Concluded, label: 'Concluded', icon: 'fa-solid fa-flag-checkered', color: 'slate' },
] as const;

const MissionClock: React.FC<{ operation: HydratedOperation }> = ({ operation }) => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (operation.status !== OperationStatus.Active && operation.status !== OperationStatus.Scheduled) return;
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, [operation.status]);

    if (operation.status === OperationStatus.Active && operation.activeStartTime) {
        const elapsed = now - new Date(operation.activeStartTime).getTime();
        const h = Math.floor(elapsed / 3600000);
        const m = Math.floor((elapsed % 3600000) / 60000);
        const s = Math.floor((elapsed % 60000) / 1000);
        return (
            <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_6px_#22c55e]"></span>
                <span className="text-green-400 font-mono text-sm font-bold tabular-nums">
                    {h.toString().padStart(2, '0')}:{m.toString().padStart(2, '0')}:{s.toString().padStart(2, '0')}
                </span>
            </div>
        );
    }

    if (operation.status === OperationStatus.Scheduled && operation.scheduledStart) {
        const diff = new Date(operation.scheduledStart).getTime() - now;
        if (diff <= 0) {
            return (
                <div className="flex items-center gap-2 animate-pulse">
                    <i className="fa-solid fa-triangle-exclamation text-red-400 text-[10px]"></i>
                    <span className="text-red-400 font-mono text-sm font-bold">OVERDUE</span>
                </div>
            );
        }
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        return (
            <div className="flex items-center gap-2">
                <i className="fa-solid fa-clock text-amber-400 text-[10px]"></i>
                <span className="text-amber-400 font-mono text-sm font-bold tabular-nums">
                    T-{h > 0 ? `${h}:` : ''}{m.toString().padStart(2, '0')}:{s.toString().padStart(2, '0')}
                </span>
            </div>
        );
    }

    return null;
};

type OpSection = 'situation' | 'mission' | 'execution' | 'admin-logistics' | 'command-signals' | 'administer' | 'aar' | 'live-status' | 'live-overview' | 'live-command';

interface OperationDetailViewProps {
    operation: HydratedOperation;
    onBack: () => void;
}

const OperationDetailView: React.FC<OperationDetailViewProps> = ({ operation: initialOperation, onBack }) => {
    const { isFetching, refreshOperations, rpcAction } = useData();
    const { radioConfig } = useConfig();
    const {
        operations, joinOperationWithShip,
        deleteOperation, removeOperationParticipant,
    } = useOperations();
    const { currentUser, hasPermission } = useAuth();
    const { confirm, addToast } = useNotification();

    const [fullDetails, setFullDetails] = useState<HydratedOperation | null>(null);

    const fetchFullDetails = useCallback(async () => {
        try {
            const result = await rpcAction('operation:get_details', { operationId: initialOperation.id });
            if (result) setFullDetails(result);
        } catch (err) {
            console.error('Failed to fetch operation details:', err);
        }
    }, [rpcAction, initialOperation.id]);

    // fetchFullDetails awaits a network RPC before its setFullDetails call, so the
    // state update is already off the synchronous effect path. Awaiting it inside
    // an inline async function makes that deferral explicit (the setState happens
    // in an async continuation, not the effect body) without changing timing:
    // both forms fire-and-forget the same promise after the same awaited RPC.
    useEffect(() => { void (async () => { await fetchFullDetails(); })(); }, [fetchFullDetails]);

    // Refetch the per-op detail bundle when a realtime operation_update broadcast lands.
    // Gated by id so unrelated ops don't refetch; trailing-debounced so a burst of remote
    // edits collapses to one get_details instead of one per broadcast.
    useEffect(() => {
        let timer: number | null = null;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { operationId?: string } | undefined;
            if (detail?.operationId !== initialOperation.id) return;
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                fetchFullDetails();
            }, 400);
        };
        window.addEventListener('app:realtime:operation-detail-refresh', handler);
        return () => {
            window.removeEventListener('app:realtime:operation-detail-refresh', handler);
            // Cancel a pending trailing call so a late get_details doesn't setState after unmount.
            if (timer !== null) window.clearTimeout(timer);
        };
    }, [initialOperation.id, fetchFullDetails]);

    const refreshDetails = useCallback(async () => {
        await Promise.all([refreshOperations(), fetchFullDetails()]);
    }, [refreshOperations, fetchFullDetails]);

    const listOp = useMemo(() =>
        operations.find(op => op.id === initialOperation.id) || initialOperation,
        [operations, initialOperation]);

    const operation = useMemo(() => {
        if (!fullDetails) return listOp;
        return {
            ...listOp,
            phases: fullDetails.phases,
            scheduleEntries: fullDetails.scheduleEntries,
            tasks: fullDetails.tasks,
            commandNodes: fullDetails.commandNodes,
            boardElements: fullDetails.boardElements,
            logistics: fullDetails.logistics,
            aarEntries: fullDetails.aarEntries,
            alliedOrgs: fullDetails.alliedOrgs,
            roe: fullDetails.roe ?? listOp.roe,
            commanderNotes: fullDetails.commanderNotes ?? listOp.commanderNotes,
            // commsPlan lives on the operations table, so listOp (refreshed via realtime) is at
            // least as fresh as fullDetails. Prefer it; fall back to fullDetails only if empty.
            commsPlan: listOp.commsPlan?.length ? listOp.commsPlan : fullDetails.commsPlan,
            aarSummary: fullDetails.aarSummary ?? listOp.aarSummary,
            aarLessonsLearned: fullDetails.aarLessonsLearned ?? listOp.aarLessonsLearned,
            aarSubmittedAt: fullDetails.aarSubmittedAt ?? listOp.aarSubmittedAt,
            aarSubmittedBy: fullDetails.aarSubmittedBy ?? listOp.aarSubmittedBy,
        };
    }, [listOp, fullDetails]);

    const [isAddUecModalOpen, setIsAddUecModalOpen] = useState(false);
    const [isAddCostModalOpen, setIsAddCostModalOpen] = useState(false);
    const [isAddParticipantModalOpen, setIsAddParticipantModalOpen] = useState(false);
    const [loadingAction, setLoadingAction] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const [activeSection, setActiveSection] = useState<OpSection>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem(`op_section_${initialOperation.id}`) as OpSection;
            if (saved) return saved;
        }
        return initialOperation.status === OperationStatus.Active ? 'live-status' : 'situation';
    });

    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(`op_section_${initialOperation.id}`, activeSection);
        }
    }, [activeSection, initialOperation.id]);

    // Auto-switch to live-status when operation transitions to Active
    const prevStatusRef = useRef(operation.status);
    useEffect(() => {
        if (operation.status === OperationStatus.Active && prevStatusRef.current !== OperationStatus.Active) {
            setActiveSection('live-status');
        }
        prevStatusRef.current = operation.status;
    }, [operation.status]);

    // Recover from a stale activeSection when the available nav items change
    // (e.g. operation moves out of Active — 'live-status' is no longer valid).
    // activeSection is user-controlled persistent state (localStorage + nav
    // clicks), so it is clamped (not derived): the adjustment only fires when the
    // current selection is no longer valid. Running this during render (React's
    // documented "adjust state during render" pattern) is behavior-equivalent to
    // the old effect — the guard is self-terminating because 'situation' is always
    // valid, so the next render leaves it untouched.
    const canManageOp = currentUser?.id === operation.ownerId || hasPermission('operations:manage');
    const isActiveOp = operation.status === OperationStatus.Active;
    const validSections = new Set<OpSection>([
        'situation', 'mission', 'execution', 'admin-logistics', 'command-signals',
        ...(isActiveOp ? ['live-status', 'live-overview'] as const : []),
        ...(isActiveOp && canManageOp ? ['live-command'] as const : []),
        ...(canManageOp ? ['administer'] as const : []),
        ...(operation.status === OperationStatus.Concluded ? ['aar'] as const : []),
    ]);
    if (!validSections.has(activeSection)) setActiveSection('situation');

    // Op Radio — lives at this level so it persists across tab switches
    const opRadio = useOpRadio(initialOperation.id);
    // Destructure the members the effects below depend on into plain locals so the
    // exhaustive-deps linter can track each one individually instead of the unstable
    // opRadio object (which is a fresh reference every render).
    const { isConnected: opRadioIsConnected, disconnect: opRadioDisconnect, handlePTT: opRadioHandlePTT } = opRadio;
    const [isOpRadioOpen, setIsOpRadioOpen] = useState(false);
    const [opRadioBannerDismissed, setOpRadioBannerDismissed] = useState(false);
    const { isEnabled: isTacticalRadioEnabled, setIsEnabled: setTacticalRadioEnabled, disconnect: disconnectTacticalRadio } = useRadio();

    // Disconnect tactical radio when op radio connects (prevent dual-transmit).
    // Edge-trigger on the op-radio connect transition (rising edge) via a prev-value
    // ref, so re-runs caused by the conditional-only deps are no-ops — only an actual
    // disconnected→connected transition acts.
    const prevOpRadioConnectedRef = useRef(opRadioIsConnected);
    useEffect(() => {
        const justConnected = opRadioIsConnected && !prevOpRadioConnectedRef.current;
        prevOpRadioConnectedRef.current = opRadioIsConnected;
        if (justConnected && isTacticalRadioEnabled) {
            disconnectTacticalRadio();
            setTacticalRadioEnabled(false);
        }
    }, [opRadioIsConnected, isTacticalRadioEnabled, disconnectTacticalRadio, setTacticalRadioEnabled]);

    // Auto-disconnect op radio when operation leaves Active
    useEffect(() => {
        if (operation.status !== OperationStatus.Active && opRadioIsConnected) {
            opRadioDisconnect();
        }
    }, [operation.status, opRadioIsConnected, opRadioDisconnect]);

    const floatingPttRef = useRef<HTMLButtonElement>(null);

    // Touch support for floating op radio PTT
    useEffect(() => {
        const btn = floatingPttRef.current;
        if (!btn) return;
        const onTouchStart = (e: TouchEvent) => { e.preventDefault(); opRadioHandlePTT(true); };
        const onTouchEnd = (e: TouchEvent) => { e.preventDefault(); opRadioHandlePTT(false); };
        btn.addEventListener('touchstart', onTouchStart, { passive: false });
        btn.addEventListener('touchend', onTouchEnd, { passive: false });
        return () => {
            btn.removeEventListener('touchstart', onTouchStart);
            btn.removeEventListener('touchend', onTouchEnd);
        };
    }, [opRadioHandlePTT]);

    const joinCodeRef = useRef('');
    const [alliedShips, setAlliedShips] = useState<UserShip[]>([]);
    const [isManageParticipantModalOpen, setIsManageParticipantModalOpen] = useState(false);
    const [editingParticipant, setEditingParticipant] = useState<any | null>(null);

    // Stable join-key for the active participant set so this effect doesn't
    // re-fetch every time a realtime tick rebuilds the participants array reference.
    const activeParticipantIdsKey = useMemo(() => {
        return (operation.participants || [])
            .filter(p => p.timeLeft === null)
            .map(p => p.userId)
            .sort((a, b) => a - b)
            .join(',');
    }, [operation.participants]);

    useEffect(() => {
        // Not gated on organizationId (always undefined in single-org), which would block the allied-ship fetch.
        if (!operation.isJoint) return;
        if (!activeParticipantIdsKey) return;
        const alliedUserIds = activeParticipantIdsKey.split(',').map(Number);
        rpcAction('operation:get_participant_ships', { operationId: operation.id, userIds: alliedUserIds })
            .then((data: any) => { if (Array.isArray(data)) setAlliedShips(data); })
            .catch(() => {});
    }, [operation.isJoint, operation.id, activeParticipantIdsKey, rpcAction]);

    useEffect(() => {
        if (!isFetching && operations.length > 0 && !operations.find(op => op.id === initialOperation.id)) {
            onBack();
        }
    }, [operations, isFetching, initialOperation.id, onBack]);

    if (!currentUser || !operation) return null;

    const typeStyles = getTypeStyles(operation.type);
    const isOwner = currentUser?.id === operation.ownerId;
    const canManage = isOwner || hasPermission('operations:manage');
    const isParticipant = operation.participants?.some(p => p.userId === currentUser?.id && p.timeLeft === null) ?? false;
    const hasAccess = !operation.isSpecial || isParticipant || canManage;
    const activeParticipants = (operation.participants || []).filter(p => p.timeLeft === null);
    const currentPhaseIdx = PHASE_STEPS.findIndex(p => p.key === operation.status);

    const handleAction = async (action: () => Promise<void>, actionName: string) => {
        setLoadingAction(actionName);
        try {
            await action();
        } catch (error: any) {
            console.error(`Failed to ${actionName} operation:`, error);
            if (actionName !== 'join' && error.message) addToast("Operation Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: error.message });
        } finally {
            setLoadingAction(null);
        }
    };

    const handleDeleteOperation = async () => {
        if (isDeleting) return;
        const confirmed = await confirm({
            title: 'Delete Operation',
            message: `Are you sure you want to permanently delete the operation "${operation.name}"? This action cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (confirmed) {
            setIsDeleting(true);
            try {
                await deleteOperation(operation.id);
                onBack();
            } catch (error) {
                console.error("Failed to delete operation:", error);
                addToast("Delete Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while deleting the operation." });
                setIsDeleting(false);
            }
        }
    };

    const openManageParticipant = (p: any) => {
        setEditingParticipant(p);
        setIsManageParticipantModalOpen(true);
    };

    if (!hasAccess) {
        return (
            <div className="flex flex-col h-full bg-slate-950">
                <div className="shrink-0 border-b border-red-500/20 py-4 px-6 bg-linear-to-b from-red-950/20 via-slate-950/80 to-slate-950">
                    <div className="flex items-center gap-4">
                        <button onClick={onBack} className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-900/60 border border-slate-700 text-slate-400 hover:text-white hover:border-red-500/40 hover:bg-red-500/10 transition-colors">
                            <i className="fa-solid fa-arrow-left text-sm"></i>
                        </button>
                        <div>
                            <h1 className="text-lg font-black text-white tracking-tight uppercase flex items-center gap-2">
                                {operation.name}
                                <span className="bg-red-500/10 text-red-400 border border-red-500/30 text-[10px] font-black px-2 py-0.5 rounded-sm uppercase tracking-widest flex items-center gap-1">
                                    <i className="fa-solid fa-lock text-[8px]"></i> Classified
                                </span>
                            </h1>
                        </div>
                    </div>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden">
                    <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,#dc2626,#dc2626_1px,transparent_1px,transparent_40px)] opacity-[0.02] pointer-events-none"></div>
                    <div className="max-w-md w-full bg-slate-900/80 border border-red-500/20 p-8 rounded-2xl shadow-2xl relative backdrop-blur-md animate-scale-in">
                        <div className="absolute top-0 left-0 w-full h-0.5 bg-linear-to-r from-red-600 via-red-500 to-red-600"></div>
                        <div className="text-center mb-8">
                            <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
                                <i className="fa-solid fa-user-secret text-4xl text-red-500"></i>
                            </div>
                            <h2 className="text-2xl font-black text-white uppercase tracking-widest mb-2">Restricted Access</h2>
                            <p className="text-red-400/80 text-sm font-mono">Authorization code required.</p>
                        </div>
                        <form onSubmit={(e) => { e.preventDefault(); handleAction(() => joinOperationWithShip(operation.id, { joinCode: joinCodeRef.current }), 'join'); }} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-2 tracking-wider text-center">Authorization Code (PIN)</label>
                                <input type="text" onChange={e => { joinCodeRef.current = e.target.value; }}
                                    className="w-full bg-black/40 border border-slate-700 focus:border-red-500 rounded-lg py-3 px-4 text-center text-white font-mono text-lg tracking-[0.5em] outline-hidden transition-colors"
                                    placeholder="&#8226;&#8226;&#8226;&#8226;" autoFocus />
                            </div>
                            <button type="submit" disabled={!!loadingAction}
                                className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded-lg uppercase tracking-wider shadow-lg shadow-red-900/20 transition-all disabled:opacity-50">
                                {loadingAction === 'join' ? (<><i className="fa-solid fa-circle-notch animate-spin mr-2"></i> Verifying...</>) : (<><i className="fa-solid fa-unlock-keyhole mr-2"></i> Authenticate & Join</>)}
                            </button>
                        </form>
                    </div>
                </div>
            </div>
        );
    }

    const isActive = operation.status === OperationStatus.Active;
    const navGroups = [
        ...(isActive ? [{
            title: 'Live Operations',
            items: [
                { id: 'live-status' as OpSection, label: 'My Status', icon: 'fa-solid fa-user-shield' },
                { id: 'live-overview' as OpSection, label: 'Overview', icon: 'fa-solid fa-users-rectangle' },
                ...(canManage ? [{ id: 'live-command' as OpSection, label: 'Command', icon: 'fa-solid fa-tower-broadcast' }] : []),
            ],
        }] : []),
        {
            title: 'Operations',
            items: [
                { id: 'situation' as OpSection, label: 'S1 - Situation', icon: 'fa-solid fa-binoculars' },
                { id: 'mission' as OpSection, label: 'S2 - Mission', icon: 'fa-solid fa-crosshairs' },
                { id: 'execution' as OpSection, label: 'S3 - Execution', icon: 'fa-solid fa-layer-group' },
                { id: 'admin-logistics' as OpSection, label: 'S4 - Admin & Log', icon: 'fa-solid fa-boxes-stacked' },
                { id: 'command-signals' as OpSection, label: 'S5 - Cmd & Sig', icon: 'fa-solid fa-tower-broadcast' },
            ],
        },
        ...(canManage ? [{
            title: 'Command',
            items: [
                { id: 'administer' as OpSection, label: 'Administer', icon: 'fa-solid fa-gear' },
            ],
        }] : []),
        ...(operation.status === OperationStatus.Concluded ? [{
            title: 'Post-Op',
            items: [
                { id: 'aar' as OpSection, label: 'S7 - After Action', icon: 'fa-solid fa-file-lines' },
            ],
        }] : []),
    ];

    return (
        <div className="flex flex-col h-full bg-slate-950">
            <div className="shrink-0 relative overflow-hidden border-b border-white/5 bg-linear-to-b from-purple-950/25 via-slate-950/80 to-slate-950 z-40">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-purple-500/10 rounded-full blur-[120px] pointer-events-none" aria-hidden />

                {/* Top bar: back, title, badges, clock */}
                <div className="relative px-4 sm:px-6 pt-5 pb-3">
                    <div className="flex items-start sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                            <button onClick={onBack} className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg bg-slate-900/60 border border-slate-700 text-slate-400 hover:text-white hover:border-purple-500/40 hover:bg-purple-500/10 transition-all">
                                <i className="fa-solid fa-arrow-left text-sm"></i>
                            </button>
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 mb-1.5">
                                    <CallsignChip label={`OP-${(operation.id || '').split('-')[0].toUpperCase()}`} icon="fa-person-military-rifle" accent="purple" pulse />
                                    {isFetching['operations'] && (
                                        <span className="text-purple-400 text-[10px] font-mono uppercase tracking-widest inline-flex items-center gap-1">
                                            <i className="fa-solid fa-arrows-rotate fa-spin"></i> Syncing
                                        </span>
                                    )}
                                </div>
                                <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-white tracking-tight uppercase truncate">{operation.name}</h1>
                                <div className="flex items-center gap-2 flex-wrap mt-2">
                                    <span className={`px-2.5 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-wider border flex items-center gap-1.5 ${typeStyles.class}`}>
                                        <i className={`${typeStyles.icon} text-[9px]`}></i> {operation.type}
                                    </span>
                                    {operation.isSpecial && (
                                        <span className="bg-red-500/10 text-red-400 border border-red-500/30 text-[10px] font-black px-2.5 py-0.5 rounded-sm uppercase tracking-wider flex items-center gap-1.5">
                                            <i className="fa-solid fa-lock text-[8px]"></i> Classified
                                        </span>
                                    )}
                                    {operation.isJoint && (
                                        <span className="bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 text-[10px] font-black px-2.5 py-0.5 rounded-sm uppercase tracking-wider flex items-center gap-1.5">
                                            <i className="fa-solid fa-handshake text-[8px]"></i> Joint
                                        </span>
                                    )}
                                    {operation.clearanceLevel > 0 && (
                                        <span className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-black px-2.5 py-0.5 rounded-sm uppercase tracking-wider flex items-center gap-1.5">
                                            <i className="fa-solid fa-shield-halved text-[8px]"></i> L{operation.clearanceLevel}
                                        </span>
                                    )}
                                    {operation.liveStatus && operation.status === OperationStatus.Active && (
                                        <span className={`text-[10px] font-black px-2.5 py-0.5 rounded uppercase tracking-wider flex items-center gap-1.5 border ${
                                            operation.liveStatus === 'Engaged' ? 'bg-red-500/10 text-red-400 border-red-500/30 animate-pulse' :
                                            operation.liveStatus === 'Holding' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                                            operation.liveStatus === 'Regrouping' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' :
                                            operation.liveStatus === 'Disengaging' ? 'bg-orange-500/10 text-orange-400 border-orange-500/30' :
                                            operation.liveStatus === 'RTB' ? 'bg-green-500/10 text-green-400 border-green-500/30' :
                                            'bg-slate-500/10 text-slate-400 border-slate-500/30'
                                        }`}>
                                            <i className="fa-solid fa-signal text-[8px]"></i> {operation.liveStatus}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="shrink-0">
                            <MissionClock operation={operation} />
                        </div>
                    </div>
                </div>

                {/* Phase Timeline */}
                <div className="relative px-4 sm:px-6 pb-4">
                    <div className="flex items-center gap-2">
                        {PHASE_STEPS.map((step, i) => {
                            const isActive = i === currentPhaseIdx;
                            const isPast = i < currentPhaseIdx;
                            const colorMap = {
                                green: 'bg-green-500/15 text-green-300 border-green-500/40 shadow-[0_0_12px_rgba(34,197,94,0.3)]',
                                amber: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
                                purple: 'bg-purple-500/15 text-purple-300 border-purple-500/40',
                                slate: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                            } as const;
                            // Green checkmark on the Concluded pill once the AAR is submitted, so finalisation is unambiguous.
                            const aarFinalised = step.key === OperationStatus.Concluded && !!operation.aarSubmittedAt;
                            const stepColor: keyof typeof colorMap = aarFinalised ? 'green' : step.color;
                            const stepIcon = aarFinalised ? 'fa-solid fa-circle-check' : step.icon;
                            return (
                                <React.Fragment key={step.key}>
                                    {i > 0 && (
                                        <div className={`h-px flex-1 transition-colors ${isPast ? 'bg-purple-500/50' : 'bg-slate-800'}`}></div>
                                    )}
                                    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap border ${
                                        isActive
                                            ? `${colorMap[stepColor]} ${stepColor === 'green' && !aarFinalised ? 'animate-pulse' : ''}`
                                            : aarFinalised
                                                ? colorMap.green
                                                : isPast
                                                    ? 'text-purple-300/70 border-purple-500/30 bg-purple-500/5'
                                                    : 'text-slate-600 border-slate-800 bg-slate-900/40'
                                    }`}>
                                        <i className={`${stepIcon} text-[9px]`}></i>
                                        <span className="hidden sm:inline">{step.label}</span>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* Op Radio Join Banner */}
            {isActive && !opRadio.isConnected && !opRadioBannerDismissed && (
                <div className={`shrink-0 ${radioConfig.configured ? 'bg-purple-500/5 border-b border-purple-500/20' : 'bg-slate-900/60 border-b border-slate-700/50'} px-6 py-2.5 flex items-center justify-between gap-4`}>
                    <div className="flex items-center gap-3">
                        <i className={`fa-solid fa-tower-broadcast ${radioConfig.configured ? 'text-purple-400' : 'text-slate-600'} text-sm`}></i>
                        <span className={`text-[10px] font-black uppercase tracking-widest ${radioConfig.configured ? 'text-purple-300' : 'text-slate-500'}`}>
                            {radioConfig.configured ? 'Op radio available' : 'Op radio unavailable — LiveKit not configured'}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {radioConfig.configured ? (
                            <button
                                onClick={() => opRadio.connect()}
                                disabled={opRadio.isConnecting}
                                className="flex items-center gap-2 px-4 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                            >
                                {opRadio.isConnecting ? <i className="fa-solid fa-spinner animate-spin text-[10px]"></i> : <i className="fa-solid fa-headphones text-[10px]"></i>}
                                Join
                            </button>
                        ) : (
                            <span className="px-3 py-1.5 text-slate-600 text-[10px] font-black uppercase tracking-widest">
                                <i className="fa-solid fa-lock text-[9px] mr-1.5"></i>Admin setup required
                            </span>
                        )}
                        <button
                            onClick={() => setOpRadioBannerDismissed(true)}
                            className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors"
                            title="Dismiss"
                        >
                            <i className="fa-solid fa-xmark text-xs"></i>
                        </button>
                    </div>
                </div>
            )}

            {/* ── BODY: Sidebar + Content ── */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
                {/* Mobile nav dropdown */}
                <div className="lg:hidden shrink-0 px-4 py-3 border-b border-slate-800/60 bg-slate-900/50">
                    <div className="relative">
                        <select
                            value={activeSection}
                            onChange={(e) => setActiveSection(e.target.value as OpSection)}
                            className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 text-sm font-bold text-white focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500/40 outline-hidden appearance-none transition-all"
                        >
                            {navGroups.map((group) => (
                                <optgroup key={group.title} label={group.title} className="bg-slate-900 text-slate-400">
                                    {group.items.map(item => (
                                        <option key={item.id} value={item.id} className="text-white">{item.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-purple-400">
                            <i className="fa-solid fa-chevron-down text-xs"></i>
                        </div>
                    </div>
                </div>

                {/* Desktop sidebar */}
                <div className="hidden lg:flex flex-col shrink-0 w-56 border-r border-slate-800/60 bg-slate-900/40 overflow-y-auto custom-scrollbar py-5 px-3 gap-5">
                    {navGroups.map((group) => (
                        <div key={group.title} className="space-y-0.5">
                            <p className="px-3 text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1.5">{group.title}</p>
                            {group.items.map(item => {
                                const active = activeSection === item.id;
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => setActiveSection(item.id)}
                                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all duration-150 ${
                                            active
                                                ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30 shadow-xs shadow-purple-900/20'
                                                : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 border border-transparent'
                                        }`}
                                    >
                                        <i className={`${item.icon} w-4 text-center text-[10px]`}></i>
                                        <span className="truncate">{item.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>

                {/* Main content - full width, no max-w constraint */}
                <div className="flex-1 min-h-0 min-w-0 overflow-y-auto custom-scrollbar bg-slate-950">
                    {activeSection === 'live-status' && isActive && (
                        <div key="live-status" className="animate-fade-in h-full">
                            <OpLiveMyStatusTab operation={operation} canManage={canManage} isParticipant={isParticipant} onRefresh={refreshDetails} radio={opRadio} />
                        </div>
                    )}
                    {activeSection === 'live-overview' && isActive && (
                        <div key="live-overview" className="animate-fade-in h-full">
                            <OpLiveOverviewTab operation={operation} canManage={canManage} onRefresh={refreshDetails} />
                        </div>
                    )}
                    {activeSection === 'live-command' && isActive && canManage && (
                        <div key="live-command" className="animate-fade-in h-full">
                            <OpLiveCommandTab operation={operation} canManage={canManage} isParticipant={isParticipant} onRefresh={refreshDetails} />
                        </div>
                    )}
                    {activeSection === 'situation' && (
                        <div key="situation" className="animate-fade-in h-full">
                            <OpSituationTab
                                operation={operation}
                                canManage={canManage}
                                isParticipant={isParticipant}
                                activeParticipants={activeParticipants}
                                onRefresh={refreshDetails}
                                loadingAction={loadingAction}
                                onAction={handleAction}
                            />
                        </div>
                    )}
                    {activeSection === 'mission' && (
                        <div key="mission" className="animate-fade-in">
                            <OpMissionTab operation={operation} canManage={canManage} onRefresh={refreshDetails} />
                        </div>
                    )}
                    {activeSection === 'execution' && (
                        <div key="execution" className="animate-fade-in">
                            <OpExecutionTab operation={operation} canManage={canManage} onRefresh={refreshDetails} />
                        </div>
                    )}
                    {activeSection === 'admin-logistics' && (
                        <div key="admin-logistics" className="animate-fade-in h-full">
                            <OpAdminLogisticsTab
                                operation={operation}
                                canManage={canManage}
                                isParticipant={isParticipant}
                                onRefresh={refreshDetails}
                                onManageParticipant={openManageParticipant}
                                onRemoveParticipant={(userId) => removeOperationParticipant(operation.id, userId)}
                                onOpenAddUec={() => setIsAddUecModalOpen(true)}
                                onOpenAddCost={() => setIsAddCostModalOpen(true)}
                                onAddParticipant={() => setIsAddParticipantModalOpen(true)}
                            />
                        </div>
                    )}
                    {activeSection === 'command-signals' && (
                        <div key="command-signals" className="animate-fade-in h-full">
                            <OpCommandSignalsTab
                                operation={operation}
                                canManage={canManage}
                                isParticipant={isParticipant}
                                onRefresh={refreshDetails}
                            />
                        </div>
                    )}
                    {activeSection === 'administer' && canManage && (
                        <div key="administer" className="animate-fade-in">
                            <OpAdministerTab
                                operation={operation}
                                canManage={canManage}
                                onRefresh={refreshDetails}
                                onDeleteOperation={handleDeleteOperation}
                                isDeleting={isDeleting}
                                loadingAction={loadingAction}
                                onAction={handleAction}
                            />
                        </div>
                    )}
                    {activeSection === 'aar' && operation.status === OperationStatus.Concluded && (
                        <div key="aar" className="animate-fade-in">
                            <OpAARTab operation={operation} canManage={canManage} isParticipant={isParticipant} onRefresh={refreshDetails} />
                        </div>
                    )}
                </div>
            </div>

            {/* Modals */}
            {isAddUecModalOpen && <AddUecModal isOpen={isAddUecModalOpen} onClose={() => setIsAddUecModalOpen(false)} operation={operation} />}
            {isAddCostModalOpen && <AddCostModal isOpen={isAddCostModalOpen} onClose={() => setIsAddCostModalOpen(false)} operation={operation} />}
            {isAddParticipantModalOpen && <AddParticipantModal isOpen={isAddParticipantModalOpen} onClose={() => setIsAddParticipantModalOpen(false)} operation={operation} />}
            {isManageParticipantModalOpen && editingParticipant && (
                <ManageParticipantModal
                    isOpen={isManageParticipantModalOpen}
                    onClose={() => { setIsManageParticipantModalOpen(false); setEditingParticipant(null); }}
                    operationId={operation.id}
                    participant={editingParticipant}
                    alliedShips={operation.isJoint ? alliedShips : undefined}
                />
            )}

            {/* Floating Op Radio — portaled to body for reliable fixed positioning */}
            {isActive && opRadio.isConnected && activeSection !== 'live-status' && createPortal(
                <>
                    {isOpRadioOpen ? (
                        <div className="fixed bottom-6 right-6 z-200 w-80 shadow-2xl shadow-black/60 rounded-xl overflow-hidden animate-fade-in border border-amber-500/30 bg-slate-900" style={{ position: 'fixed' }}>
                            {/* Floating panel header */}
                            <div className="flex items-center justify-between px-3 py-2.5 bg-slate-950 border-b border-amber-500/20">
                                <div className="flex items-center gap-2">
                                    <i className="fa-solid fa-tower-broadcast text-amber-400 text-sm" />
                                    <span className="text-xs font-bold text-amber-300 uppercase tracking-wider">Op Radio</span>
                                    <span className={`w-1.5 h-1.5 rounded-full ${opRadio.isTransmitting ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]' : 'bg-green-400 shadow-[0_0_4px_rgba(34,197,94,0.6)]'} animate-pulse`} />
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <button onClick={() => setIsOpRadioOpen(false)}
                                        className="w-6 h-6 flex items-center justify-center rounded-sm bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors text-[10px]"
                                        title="Minimize">
                                        <i className="fa-solid fa-minus" />
                                    </button>
                                    <button onClick={() => { opRadio.disconnect(); setIsOpRadioOpen(false); }}
                                        className="w-6 h-6 flex items-center justify-center rounded-sm bg-slate-800 text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors text-[10px]"
                                        title="Disconnect">
                                        <i className="fa-solid fa-power-off" />
                                    </button>
                                </div>
                            </div>

                            {/* Participants */}
                            {opRadio.participants.length > 0 && (
                                <div className="px-3 py-2 border-b border-slate-800/50">
                                    <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-1.5">{opRadio.participants.length} Connected</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {opRadio.participants.map((name) => {
                                            const isSpeaking = opRadio.activeSpeakers.includes(name) || (name === opRadio.participants[0] && opRadio.isTransmitting);
                                            return (
                                                <span
                                                    key={name}
                                                    className={`text-[10px] px-2 py-0.5 rounded transition-all ${
                                                        isSpeaking
                                                            ? 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-500/50 shadow-[0_0_6px_rgba(245,158,11,0.3)]'
                                                            : 'bg-slate-800 text-slate-400'
                                                    }`}
                                                >
                                                    {isSpeaking && <i className="fa-solid fa-microphone text-[8px] mr-1" />}
                                                    {name}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Controls */}
                            <div className="p-3 space-y-3">
                                {opRadio.error && (
                                    <div className="text-xs text-red-400 bg-red-500/10 rounded-sm px-2 py-1">{opRadio.error}</div>
                                )}

                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={opRadio.toggleMute}
                                        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all border ${opRadio.isMuted ? 'bg-red-500/20 border-red-500/40 text-red-400' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-white'}`}
                                        title={opRadio.isMuted ? 'Unmute' : 'Mute'}
                                    >
                                        <i className={`fa-solid ${opRadio.isMuted ? 'fa-volume-xmark' : 'fa-volume-high'} text-sm`} />
                                    </button>
                                    <div className="flex-1 flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 h-9 border border-slate-700/50">
                                        <input
                                            type="range"
                                            min={0}
                                            max={100}
                                            value={opRadio.volume}
                                            onChange={e => opRadio.setVolume(Number(e.target.value))}
                                            className="flex-1 h-1 accent-amber-500"
                                        />
                                        <span className="text-[10px] text-slate-500 w-7 text-right">{opRadio.volume}%</span>
                                    </div>
                                </div>

                                <button
                                    ref={floatingPttRef}
                                    onMouseDown={() => opRadio.handlePTT(true)}
                                    onMouseUp={() => opRadio.handlePTT(false)}
                                    onMouseLeave={() => { if (opRadio.isTransmitting) opRadio.handlePTT(false); }}
                                    disabled={!opRadio.isConnected || opRadio.isMuted}
                                    className={`w-full py-4 rounded-xl font-bold text-sm uppercase tracking-widest transition-all select-none border-b-4 ${
                                        opRadio.isTransmitting
                                            ? 'bg-amber-500 border-amber-700 text-black shadow-lg shadow-amber-500/40 scale-[0.97]'
                                            : opRadio.isConnected && !opRadio.isMuted
                                                ? 'bg-amber-500/15 border-amber-900/50 text-amber-400 hover:bg-amber-500/25 active:bg-amber-500 active:text-black'
                                                : 'bg-slate-800 border-slate-900 text-slate-600 cursor-not-allowed'
                                    }`}
                                >
                                    {opRadio.isTransmitting ? (
                                        <span className="flex items-center justify-center gap-3">
                                            <span className="w-2.5 h-2.5 rounded-full bg-black/40 animate-ping" />
                                            LIVE TX
                                        </span>
                                    ) : (
                                        <><i className="fa-solid fa-microphone-slash mr-2" /> Push to Talk</>
                                    )}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            onClick={() => setIsOpRadioOpen(true)}
                            className={`fixed bottom-6 right-6 z-200 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
                                opRadio.isTransmitting
                                    ? 'bg-amber-500 text-black shadow-amber-500/40 scale-110'
                                    : opRadio.activeSpeakers.length > 0
                                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 shadow-amber-900/20 animate-pulse'
                                        : 'bg-slate-800 text-amber-400 border border-amber-500/20 hover:bg-slate-700'
                            }`}
                            title="Open Op Radio"
                        >
                            <i className={`fa-solid ${opRadio.isTransmitting ? 'fa-microphone' : 'fa-tower-broadcast'}`} />
                            {opRadio.participants.length > 1 && (
                                <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-black text-[9px] font-bold rounded-full flex items-center justify-center">
                                    {opRadio.participants.length}
                                </span>
                            )}
                        </button>
                    )}
                </>,
                document.body
            )}
        </div>
    );
};

export default OperationDetailView;
