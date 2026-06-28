
import React, { useMemo, useState, useEffect } from 'react';
import { HydratedOperation, OperationStatus, OperationLiveStatus, OperationCommandNode } from '../../../../types';
import { useAuth } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';

const STATUS_OPTIONS: { value: OperationLiveStatus; label: string }[] = [
    { value: OperationLiveStatus.Standby, label: 'Standby' },
    { value: OperationLiveStatus.Engaged, label: 'Engaged' },
    { value: OperationLiveStatus.Holding, label: 'Holding' },
    { value: OperationLiveStatus.RTB, label: 'RTB' },
    { value: OperationLiveStatus.Disengaging, label: 'Disengaging' },
    { value: OperationLiveStatus.Regrouping, label: 'Regrouping' },
];

interface OpLiveOverviewTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    onRefresh: () => void;
}

const statusColor = (status?: string) => {
    switch (status) {
        case 'Engaged': return { bg: 'bg-red-500/15', text: 'text-red-400', border: 'border-red-500/30', dot: 'bg-red-500' };
        case 'Holding': return { bg: 'bg-amber-500/15', text: 'text-amber-400', border: 'border-amber-500/30', dot: 'bg-amber-500' };
        case 'RTB': return { bg: 'bg-green-500/15', text: 'text-green-400', border: 'border-green-500/30', dot: 'bg-green-500' };
        case 'Regrouping': return { bg: 'bg-yellow-500/15', text: 'text-yellow-400', border: 'border-yellow-500/30', dot: 'bg-yellow-500' };
        case 'Disengaging': return { bg: 'bg-orange-500/15', text: 'text-orange-400', border: 'border-orange-500/30', dot: 'bg-orange-500' };
        case 'Standby': return { bg: 'bg-slate-500/15', text: 'text-slate-400', border: 'border-slate-500/30', dot: 'bg-slate-500' };
        default: return { bg: 'bg-slate-800/40', text: 'text-slate-500', border: 'border-slate-700/40', dot: 'bg-slate-600' };
    }
};

const OpLiveOverviewTab: React.FC<OpLiveOverviewTabProps> = ({ operation, canManage, onRefresh }) => {
    const { currentUser } = useAuth();
    const { rpcAction } = useData();
    const [now, setNow] = useState(() => Date.now());
    const [updatingNodeId, setUpdatingNodeId] = useState<number | null>(null);

    useEffect(() => {
        if (operation.status !== OperationStatus.Active) return;
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, [operation.status]);

    const activeParticipants = useMemo(() =>
        (operation.participants || []).filter(p => p.timeLeft === null),
        [operation.participants]
    );

    const readyCount = activeParticipants.filter(p => p.isReady).length;
    const totalCount = activeParticipants.length;
    const readyPct = totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 0;

    const missionClock = useMemo(() => {
        if (operation.status !== OperationStatus.Active || !operation.activeStartTime) return null;
        const elapsed = now - new Date(operation.activeStartTime).getTime();
        const h = Math.floor(elapsed / 3600000);
        const m = Math.floor((elapsed % 3600000) / 60000);
        const s = Math.floor((elapsed % 60000) / 1000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }, [operation.status, operation.activeStartTime, now]);

    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        activeParticipants.forEach(p => {
            const key = p.liveStatus || 'Unset';
            counts[key] = (counts[key] || 0) + 1;
        });
        return counts;
    }, [activeParticipants]);

    const isJoint = operation.isJoint && operation.alliedOrgs && operation.alliedOrgs.length > 0;

    // Formation status: hierarchical command + unit nodes
    const { topLevelNodes, childrenMap } = useMemo(() => {
        const filtered = (operation.commandNodes || []).filter(n => n.nodeType === 'command' || n.nodeType === 'unit');
        const filteredIds = new Set(filtered.map(n => n.id));
        const top: OperationCommandNode[] = [];
        const children = new Map<number, OperationCommandNode[]>();
        for (const node of filtered) {
            if (!node.parentId || !filteredIds.has(node.parentId)) {
                top.push(node);
            } else {
                const existing = children.get(node.parentId) || [];
                existing.push(node);
                children.set(node.parentId, existing);
            }
        }
        return { topLevelNodes: top, childrenMap: children };
    }, [operation.commandNodes]);

    const handleNodeStatus = async (nodeId: number, liveStatus: string) => {
        setUpdatingNodeId(nodeId);
        try {
            await rpcAction('operation:update_command_node', { nodeId, data: { liveStatus }, operationId: operation.id });
            onRefresh();
        } catch (e) {
            console.error('Failed to update node status:', e);
        } finally {
            setUpdatingNodeId(null);
        }
    };

    const renderNode = (node: OperationCommandNode, indented: boolean) => {
        const sc = statusColor(node.liveStatus);
        const kids = childrenMap.get(node.id) || [];
        return (
            <React.Fragment key={node.id}>
                <div className={`p-3 rounded-xl bg-slate-900/80 backdrop-blur-md border border-slate-700/50 space-y-2 ${indented ? 'ml-4' : ''}`}>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${sc.dot}`} />
                        <span className="text-[11px] font-bold text-white flex-1 min-w-0 truncate">{node.label}</span>
                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm shrink-0 border ${sc.bg} ${sc.text} ${sc.border}`}>
                            {node.liveStatus || 'None'}
                        </span>
                    </div>
                    {canManage && (
                        <div className="grid grid-cols-3 gap-1">
                            {STATUS_OPTIONS.map(opt => (
                                <button key={opt.value}
                                    onClick={() => handleNodeStatus(node.id, node.liveStatus === opt.value ? '' : opt.value)}
                                    disabled={updatingNodeId === node.id}
                                    className={`px-1.5 py-1 rounded text-[9px] font-black uppercase tracking-wider transition-all border ${
                                        node.liveStatus === opt.value
                                            ? `${statusColor(opt.value).bg} ${statusColor(opt.value).text} ${statusColor(opt.value).border}`
                                            : 'bg-slate-900/60 text-slate-500 border-slate-700/50 hover:text-slate-300 hover:border-slate-600'
                                    } disabled:opacity-50`}>
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                {kids.map(child => renderNode(child, true))}
            </React.Fragment>
        );
    };

    return (
        <div className="p-4 md:p-6 space-y-6 overflow-y-auto custom-scrollbar h-full">
            {/* Summary Bar */}
            <div className="flex flex-wrap items-center gap-4 bg-slate-900/60 backdrop-blur-md rounded-xl p-4 border border-slate-700/50">
                {/* Mission Clock */}
                {missionClock && (
                    <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_6px_#22c55e]" />
                        <span className="text-green-400 font-mono text-sm font-bold tabular-nums">{missionClock}</span>
                    </div>
                )}

                {/* Participant Count */}
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <i className="fa-solid fa-users text-[10px]" />
                    <span className="font-bold text-white">{totalCount}</span> personnel
                </div>

                {/* Readiness */}
                <div className="flex items-center gap-2 text-xs">
                    <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full transition-all shadow-[0_0_6px_rgba(34,197,94,0.5)]" style={{ width: `${readyPct}%` }} />
                    </div>
                    <span className="text-green-400 font-bold">{readyPct}%</span>
                    <span className="text-slate-500 uppercase tracking-wider text-[10px] font-bold">Ready</span>
                </div>

                {/* Operation Live Status */}
                {operation.liveStatus && (
                    <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-sm border ${statusColor(operation.liveStatus).bg} ${statusColor(operation.liveStatus).text} ${statusColor(operation.liveStatus).border}`}>
                        {operation.liveStatus}
                    </span>
                )}

                {/* Status breakdown */}
                <div className="flex items-center gap-1.5 ml-auto flex-wrap">
                    {Object.entries(statusCounts).map(([status, count]) => {
                        const colors = statusColor(status === 'Unset' ? undefined : status);
                        return (
                            <span key={status} className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${colors.bg} ${colors.text} ${colors.border}`}>
                                {count} {status}
                            </span>
                        );
                    })}
                </div>
            </div>

            {/* Formation Status */}
            {topLevelNodes.length > 0 && (
                <div className="space-y-2">
                    <label className="text-[10px] uppercase tracking-widest text-slate-500 font-black flex items-center gap-1.5">
                        <i className="fa-solid fa-users-viewfinder text-[9px]" />
                        Formation Status
                    </label>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                        {topLevelNodes.map(node => renderNode(node, false))}
                    </div>
                </div>
            )}

            {/* Personnel Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {activeParticipants.map(p => {
                    const colors = statusColor(p.liveStatus);
                    const isMe = p.userId === currentUser?.id;
                    return (
                        <div
                            key={p.userId}
                            className={`relative rounded-xl p-3 border transition-all bg-slate-900/80 backdrop-blur-md ${p.liveStatus ? colors.border : 'border-slate-700/50'} hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-900/20 ${
                                isMe ? 'ring-1 ring-purple-500/40' : ''
                            }`}
                        >
                            {/* Ready indicator */}
                            <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${
                                p.isReady ? 'bg-green-500 shadow-[0_0_4px_#22c55e]' : 'bg-slate-600'
                            }`} />

                            {/* Avatar + Name */}
                            <div className="flex items-center gap-2 mb-2">
                                {p.user?.avatarUrl ? (
                                    <img src={p.user.avatarUrl} className="w-8 h-8 rounded-full border border-slate-700 object-cover shrink-0" />
                                ) : (
                                    <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                                        <i className="fa-solid fa-user text-slate-500 text-xs" />
                                    </div>
                                )}
                                <div className="min-w-0">
                                    <div className="text-xs font-bold text-white truncate">{p.user?.name || 'Unknown'}</div>
                                    {p.user?.rank && (
                                        <div className="flex items-center gap-1">
                                            {p.user.rank.iconUrl && <img src={p.user.rank.iconUrl} className="w-3 h-3" />}
                                            <span className="text-[9px] text-slate-500 truncate">{p.user.rank.name}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Live Status Badge */}
                            {p.liveStatus && (
                                <div className={`text-[10px] font-black uppercase tracking-wider ${colors.text} flex items-center gap-1 mb-1.5`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                                    {p.liveStatus}
                                </div>
                            )}

                            {/* Role + Ship */}
                            <div className="space-y-0.5">
                                {p.roleRequested && (
                                    <div className="text-[9px] text-slate-500 truncate">
                                        <i className="fa-solid fa-tag mr-1 text-[8px]" />{p.roleRequested}
                                    </div>
                                )}
                                {(p.ship?.name || p.shipUtilized) && (
                                    <div className="text-[9px] text-slate-500 truncate">
                                        <i className="fa-solid fa-rocket mr-1 text-[8px]" />{p.ship?.name || p.shipUtilized}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {activeParticipants.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-10 text-center">
                    <i className="fa-solid fa-users-slash text-4xl text-purple-400 opacity-40 mb-3" />
                    <h3 className="text-lg font-bold text-white mb-1">No active participants</h3>
                    <p className="text-sm text-slate-500">Personnel will appear here once they join the operation.</p>
                </div>
            )}
        </div>
    );
};

export default OpLiveOverviewTab;
