import React, { useState, useMemo, useEffect } from 'react';
import { HydratedOperation, OperationStatus, RSVPStatus } from '../../../../types';
import { useAuth, useFormatDate } from '../../../../contexts/AuthContext';
import { useOperations } from '../../../../contexts/OperationsContext';
import { useFleet } from '../../../../contexts/FleetContext';

import ShipPickerDropdown, { ShipPickerSelection } from '../../fleet/ShipPickerDropdown';
import { useNotification } from '../../../../contexts/NotificationContext';
import { isFormerRow } from '../participantRoster';
import FormerParticipantBadge from '../FormerParticipantBadge';

interface OpSituationTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    /** ACT term — the viewer holds an ACTIVE row. Gates the ready / RSVP / withdraw bar. */
    isParticipant: boolean;
    /**
     * The rows this tab LISTS and COUNTS (participantRoster displayRoster): the whole
     * roster on a concluded op, otherwise the active rows. Display only — never used to
     * decide what the viewer may do.
     */
    rosterParticipants: HydratedOperation['participants'];
    onRefresh: () => void;
    loadingAction: string | null;
    onAction: (action: () => Promise<void>, actionName: string) => Promise<void>;
}

const OpSituationTab: React.FC<OpSituationTabProps> = ({ operation, canManage, isParticipant, rosterParticipants, onRefresh, loadingAction, onAction }) => {
    const { currentUser } = useAuth();
    const { toggleParticipantReady, leaveOperation, joinOperationWithShip, rsvpOperation } = useOperations();
    const fmt = useFormatDate();
    const formatDate = (iso: string | null | undefined) => iso ? fmt(iso) : 'TBD';
    const { userShips, refreshFleet } = useFleet();
    const { addToast } = useNotification();

    const isOwner = currentUser?.id === operation.ownerId;
    const isReady = operation.participants?.find(p => p.userId === currentUser?.id && p.timeLeft === null)?.isReady || false;

    // Join flow state
    const [joinCodeInput, setJoinCodeInput] = useState('');
    const [showJoinInput, setShowJoinInput] = useState(false);
    const [showJoinExpanded, setShowJoinExpanded] = useState(false);
    const [joinRoleInput, setJoinRoleInput] = useState('');
    const [joinShipSelection, setJoinShipSelection] = useState<ShipPickerSelection | null>(null);

    const myShips = useMemo(() => userShips.filter(s => s.userId === currentUser?.id), [userShips, currentUser?.id]);

    useEffect(() => {
        if (showJoinExpanded && userShips.length === 0) refreshFleet();
    }, [showJoinExpanded, userShips.length, refreshFleet]);

    const handleJoin = async () => {
        if (operation.isSpecial && !joinCodeInput) {
            setShowJoinInput(true);
            return;
        }
        if (!showJoinExpanded) {
            setShowJoinExpanded(true);
            return;
        }
        try {
            await onAction(async () => {
                await joinOperationWithShip(operation.id, {
                    joinCode: joinCodeInput || undefined,
                    roleRequested: joinRoleInput.trim() || undefined,
                    shipUtilized: joinShipSelection?.shipName || undefined,
                    shipId: joinShipSelection?.shipId || undefined,
                    userShipId: joinShipSelection?.userShipId || undefined,
                });
                setShowJoinInput(false);
                setShowJoinExpanded(false);
                setJoinCodeInput('');
                setJoinRoleInput('');
                setJoinShipSelection(null);
            }, 'join');
        } catch (error: any) {
            addToast("Join Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: error.message || "Failed to join operation." });
        }
    };

    const readyCount = rosterParticipants.filter(p => p.isReady).length;
    const totalCount = rosterParticipants.length;
    const readyPct = totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 0;

    const rsvpStats = useMemo(() => {
        const accepted = rosterParticipants.filter(p => p.rsvpStatus === RSVPStatus.Accepted).length;
        const tentative = rosterParticipants.filter(p => p.rsvpStatus === RSVPStatus.Tentative).length;
        const declined = rosterParticipants.filter(p => p.rsvpStatus === RSVPStatus.Declined).length;
        const pending = rosterParticipants.filter(p => !p.rsvpStatus || p.rsvpStatus === RSVPStatus.Pending).length;
        return { accepted, tentative, declined, pending };
    }, [rosterParticipants]);

    const ownerName = operation.owner?.name || 'Unknown Commander';
    const ownerAvatar = operation.owner?.avatarUrl || '';

    const myParticipant = operation.participants?.find(p => p.userId === currentUser?.id && p.timeLeft === null);
    const currentRsvp = myParticipant?.rsvpStatus || 'Pending';

    return (
        <div className="p-6 lg:p-8 space-y-8">
            {operation.status !== OperationStatus.Concluded && (
                <div className="flex flex-wrap items-center gap-3 p-4 bg-linear-to-r from-slate-800/60 to-slate-900/40 rounded-xl border border-slate-700/40 animate-fade-in-down">
                    {isParticipant ? (
                        <>
                            <button
                                onClick={() => onAction(() => toggleParticipantReady(operation.id), 'ready')}
                                disabled={!!loadingAction}
                                className={`flex items-center gap-2.5 px-6 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${
                                    isReady
                                        ? 'bg-green-500 text-black shadow-lg shadow-green-500/20 hover:bg-green-400'
                                        : 'bg-slate-700/80 text-slate-200 hover:bg-slate-600 border border-slate-600'
                                }`}
                            >
                                <i className={`fa-solid ${isReady ? 'fa-circle-check' : 'fa-check'} fa-fw`}></i>
                                {loadingAction === 'ready' ? <i className="fa-solid fa-spinner animate-spin"></i> : isReady ? 'Ready' : 'Mark Ready'}
                            </button>

                            {/* RSVP buttons inline */}
                            {operation.scheduledStart && (operation.status === OperationStatus.Planning || operation.status === OperationStatus.Scheduled) && (
                                <>
                                    <div className="h-8 w-px bg-slate-700/60"></div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider mr-1">RSVP</span>
                                        {([
                                            { status: RSVPStatus.Accepted, label: 'Accept', icon: 'fa-circle-check', activeClass: 'bg-green-500/20 text-green-400 border-green-500/40' },
                                            { status: RSVPStatus.Tentative, label: 'Maybe', icon: 'fa-circle-question', activeClass: 'bg-amber-500/20 text-amber-400 border-amber-500/40' },
                                            { status: RSVPStatus.Declined, label: 'Decline', icon: 'fa-circle-xmark', activeClass: 'bg-red-500/20 text-red-400 border-red-500/40' },
                                        ] as const).map(btn => (
                                            <button key={btn.status}
                                                onClick={() => onAction(() => rsvpOperation(operation.id, btn.status), 'rsvp')}
                                                disabled={!!loadingAction}
                                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border ${
                                                    currentRsvp === btn.status ? btn.activeClass : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:bg-slate-700/50'
                                                } disabled:opacity-50`}>
                                                <i className={`fa-solid ${btn.icon}`}></i> {btn.label}
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}

                            <div className="flex-1"></div>
                            <button onClick={() => onAction(() => leaveOperation(operation.id), 'leave')} disabled={!!loadingAction || isOwner}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-900/20 text-red-400/80 border border-red-500/20 text-[10px] font-bold uppercase tracking-wider hover:bg-red-900/40 hover:text-red-400 transition-colors disabled:opacity-30"
                                title={isOwner ? "Owner cannot leave operation" : "Leave"}>
                                <i className="fa-solid fa-person-walking-arrow-right fa-fw"></i> Withdraw
                            </button>
                        </>
                    ) : !isOwner ? (
                        <div className="flex items-center gap-3 flex-wrap w-full">
                            {showJoinInput && (
                                <input type="text" value={joinCodeInput} onChange={e => setJoinCodeInput(e.target.value)} placeholder="Enter PIN"
                                    className="bg-black/40 border border-slate-600 text-white text-xs px-3 py-2.5 rounded-lg w-32 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 transition-all font-mono tracking-widest text-center" autoFocus />
                            )}
                            {showJoinExpanded && (
                                <div className="flex items-center gap-2 flex-wrap">
                                    <input type="text" value={joinRoleInput} onChange={e => setJoinRoleInput(e.target.value)} placeholder="Role (optional)"
                                        className="bg-black/40 border border-slate-600 text-white text-xs px-3 py-2.5 rounded-lg w-36 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 transition-all" />
                                    <div className="w-48">
                                        <ShipPickerDropdown ships={myShips} value={joinShipSelection?.userShipId} onChange={setJoinShipSelection} />
                                    </div>
                                    <button onClick={() => { setShowJoinExpanded(false); setJoinRoleInput(''); setJoinShipSelection(null); }}
                                        className="text-slate-500 hover:text-white text-xs px-2 py-2">
                                        <i className="fa-solid fa-xmark"></i>
                                    </button>
                                </div>
                            )}
                            <button onClick={handleJoin} disabled={!!loadingAction}
                                className="flex items-center gap-2.5 px-6 py-2.5 rounded-lg text-white text-xs font-black uppercase tracking-wider transition-all active:scale-95 disabled:bg-slate-700 disabled:cursor-not-allowed bg-green-600 hover:bg-green-500 shadow-lg shadow-green-900/20">
                                <i className={`fa-solid ${operation.isSpecial ? 'fa-lock' : 'fa-right-to-bracket'} fa-fw`}></i>
                                {loadingAction === 'join' ? 'Connecting...' : showJoinExpanded ? 'Confirm Join' : 'Join Operation'}
                            </button>
                        </div>
                    ) : null}
                </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                {/* Left: Op Info */}
                <div className="xl:col-span-2 space-y-6">
                    {/* Operation Details Card */}
                    <div className="bg-slate-900/60 rounded-xl border border-slate-700/30 overflow-hidden">
                        <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                <i className="fa-solid fa-binoculars text-purple-400/70"></i> Situation Overview
                            </p>
                        </div>
                        <div className="p-5">
                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                                {/* Commander */}
                                <div className="col-span-2 lg:col-span-1 flex items-center gap-3 bg-slate-800/30 rounded-lg p-3 border border-slate-700/20">
                                    {ownerAvatar ? (
                                        <img src={ownerAvatar} alt={ownerName} className="h-9 w-9 rounded-full border-2 border-purple-500/30 shrink-0" />
                                    ) : (
                                        <div className="h-9 w-9 rounded-full border-2 border-slate-600 bg-slate-800 flex items-center justify-center shrink-0">
                                            <i className="fa-solid fa-user text-slate-500 text-xs"></i>
                                        </div>
                                    )}
                                    <div className="min-w-0">
                                        <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest">Commander</p>
                                        <p className="text-sm font-bold text-white truncate">{ownerName}</p>
                                    </div>
                                </div>

                                {/* Info Grid */}
                                <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/20">
                                    <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Host Unit</p>
                                    <p className="text-xs font-bold text-white truncate">{operation.unit?.name || 'Joint Command'}</p>
                                </div>
                                <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/20">
                                    <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">AO / Location</p>
                                    <p className="text-xs font-bold text-white truncate flex items-center gap-1.5">
                                        <i className="fa-solid fa-location-dot text-purple-400/70 text-[10px]"></i>
                                        {operation.locationText || operation.location?.name || 'TBD'}
                                    </p>
                                </div>
                                <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/20">
                                    <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Capacity</p>
                                    <p className="text-xs font-mono font-bold text-white">
                                        {rosterParticipants.length}{operation.maxParticipants ? ` / ${operation.maxParticipants}` : ''} <span className="text-slate-500">PAX</span>
                                    </p>
                                </div>

                                {/* Time slots - dynamic */}
                                {operation.scheduledStart && (
                                    <div className="bg-slate-800/30 rounded-lg p-3 border border-purple-500/15">
                                        <p className="text-[9px] text-purple-300/80 uppercase font-black tracking-widest mb-1">Start Time</p>
                                        <p className="text-xs font-mono text-white">{formatDate(operation.scheduledStart)}</p>
                                    </div>
                                )}
                                {operation.scheduledEnd && (
                                    <div className="bg-slate-800/30 rounded-lg p-3 border border-purple-500/15">
                                        <p className="text-[9px] text-purple-300/80 uppercase font-black tracking-widest mb-1">End Time</p>
                                        <p className="text-xs font-mono text-white">{formatDate(operation.scheduledEnd)}</p>
                                    </div>
                                )}
                                {operation.activeStartTime && (
                                    <div className="bg-slate-800/30 rounded-lg p-3 border border-green-500/15">
                                        <p className="text-[9px] text-green-400/70 uppercase font-black tracking-widest mb-1">Active Since</p>
                                        <p className="text-xs font-mono text-white">{formatDate(operation.activeStartTime)}</p>
                                    </div>
                                )}
                                {operation.activeEndTime && (
                                    <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-600/30">
                                        <p className="text-[9px] text-slate-400 uppercase font-black tracking-widest mb-1">Ended</p>
                                        <p className="text-xs font-mono text-white">{formatDate(operation.activeEndTime)}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Security Classification */}
                    {(operation.clearanceLevel > 0 || (operation.limitingMarkers && operation.limitingMarkers.length > 0)) && (
                        <div className="bg-red-950/20 rounded-xl border border-red-500/15 overflow-hidden">
                            <div className="px-5 py-3 bg-red-950/30 border-b border-red-500/10">
                                <p className="text-[10px] text-red-400/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                    <i className="fa-solid fa-shield-halved"></i> Security Classification
                                </p>
                            </div>
                            <div className="p-5 flex flex-wrap gap-2">
                                {operation.clearanceLevel > 0 && (
                                    <span className="text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/20 px-3 py-1 rounded-lg">
                                        Level {operation.clearanceLevel}
                                    </span>
                                )}
                                {operation.limitingMarkers?.map(m => (
                                    <span key={m.id} className="text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 px-3 py-1 rounded-lg">
                                        {m.code || m.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Allied Organizations */}
                    {operation.isJoint && operation.alliedOrgs && operation.alliedOrgs.length > 0 && (
                        <div className="bg-cyan-950/15 rounded-xl border border-cyan-500/15 overflow-hidden">
                            <div className="px-5 py-3 bg-cyan-950/20 border-b border-cyan-500/10">
                                <p className="text-[10px] text-cyan-400/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                    <i className="fa-solid fa-handshake"></i> Allied Organizations
                                </p>
                            </div>
                            <div className="p-5 space-y-2">
                                {operation.alliedOrgs.map(ally => (
                                    <div key={ally.id} className={`flex items-center justify-between p-3 rounded-lg border ${ally.accepted ? 'bg-cyan-900/10 border-cyan-500/15' : 'bg-slate-800/30 border-slate-700/20'}`}>
                                        <div className="flex items-center gap-3">
                                            {ally.peerIconUrl && <img src={ally.peerIconUrl} className="w-8 h-8 rounded-sm" alt="" />}
                                            <div>
                                                <span className="text-sm font-bold text-white">{ally.peerOrgName || ally.label || 'Allied Org'}</span>
                                                <span className={`ml-2 text-[9px] font-black uppercase ${ally.accepted ? 'text-green-400' : 'text-amber-400'}`}>
                                                    {ally.accepted ? 'Confirmed' : 'Pending'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Right: Readiness Panel */}
                <div className="space-y-6">
                    {/* Readiness Gauge */}
                    <div className="bg-slate-900/60 rounded-xl border border-slate-700/30 overflow-hidden">
                        <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30 flex items-center justify-between">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                <i className="fa-solid fa-signal text-green-500/60"></i> Fleet Readiness
                            </p>
                            <div className="flex items-center gap-1.5">
                                <span className="text-lg font-black text-green-400 tabular-nums">{readyCount}</span>
                                <span className="text-slate-600 text-sm">/</span>
                                <span className="text-lg font-black text-white tabular-nums">{totalCount}</span>
                            </div>
                        </div>
                        <div className="p-5 space-y-4">
                            {/* Progress Bar */}
                            <div>
                                <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all duration-500 ${readyPct >= 100 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.3)]' : readyPct >= 50 ? 'bg-purple-500' : 'bg-amber-500'}`}
                                        style={{ width: `${readyPct}%` }}></div>
                                </div>
                                <p className="text-[10px] text-slate-600 font-mono mt-1 text-right">{readyPct}%</p>
                            </div>

                            {/* RSVP Stats */}
                            {operation.scheduledStart && (rsvpStats.accepted + rsvpStats.tentative + rsvpStats.declined) > 0 && (
                                <div className="flex items-center gap-3 bg-slate-800/30 rounded-lg p-2.5 border border-slate-700/20">
                                    <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider">RSVP</span>
                                    <div className="flex items-center gap-3 text-[10px] font-mono">
                                        {rsvpStats.accepted > 0 && <span className="text-green-400 flex items-center gap-0.5">{rsvpStats.accepted}<i className="fa-solid fa-check text-[7px]"></i></span>}
                                        {rsvpStats.tentative > 0 && <span className="text-amber-400 flex items-center gap-0.5">{rsvpStats.tentative}<i className="fa-solid fa-question text-[7px]"></i></span>}
                                        {rsvpStats.declined > 0 && <span className="text-red-400 flex items-center gap-0.5">{rsvpStats.declined}<i className="fa-solid fa-xmark text-[7px]"></i></span>}
                                        {rsvpStats.pending > 0 && <span className="text-slate-500 flex items-center gap-0.5">{rsvpStats.pending}<i className="fa-solid fa-minus text-[7px]"></i></span>}
                                    </div>
                                </div>
                            )}

                            {/* Participant Status Chips */}
                            <div className="space-y-1.5 max-h-80 overflow-y-auto custom-scrollbar pr-1">
                                {rosterParticipants.map(p => (
                                    <div key={p.userId}
                                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all ${
                                            p.isReady
                                                ? 'bg-green-950/20 border-green-500/20'
                                                : 'bg-slate-800/30 border-slate-700/15'
                                        }`}>
                                        <div className="relative shrink-0">
                                            {p.user?.avatarUrl ? (
                                                <img src={p.user.avatarUrl} className={`w-7 h-7 rounded-full border-2 object-cover ${p.isReady ? 'border-green-500/60' : 'border-slate-700'}`} alt="" />
                                            ) : (
                                                <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 ${p.isReady ? 'border-green-500/60 bg-green-950/30' : 'border-slate-700 bg-slate-800'}`}>
                                                    <i className="fa-solid fa-user text-[8px] text-slate-500"></i>
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[11px] font-bold text-white truncate flex items-center gap-1">
                                                {p.user?.name || 'Unknown'}
                                                {p.userId === operation.ownerId && <i className="fa-solid fa-crown text-[8px] text-amber-400"></i>}
                                                {isFormerRow(p) && <FormerParticipantBadge />}
                                            </p>
                                            {(p.roleRequested || p.ship || p.shipUtilized) && (
                                                <p className="text-[9px] text-slate-500 truncate">
                                                    {p.roleRequested && <span>{p.roleRequested}</span>}
                                                    {p.roleRequested && (p.ship || p.shipUtilized) && <span> · </span>}
                                                    {(p.ship || p.shipUtilized) && <span className="text-amber-400/60">{p.ship?.name || p.shipUtilized}</span>}
                                                </p>
                                            )}
                                        </div>
                                        {p.isReady && (
                                            <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                                                <i className="fa-solid fa-check text-[8px] text-black"></i>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {rosterParticipants.length === 0 && (
                                    <div className="text-center py-8">
                                        <i className="fa-solid fa-user-slash text-2xl text-slate-700 mb-2"></i>
                                        <p className="text-xs text-slate-600 italic">No active participants</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OpSituationTab;
