import React, { useState, useMemo } from 'react';
import { HydratedOperation, OperationCommandNode, RSVPStatus } from '../../../../types';
import { useAuth } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';

import OpOrbatNodeGraph from './OpOrbatNodeGraph';
import OpShipSeatsPanel from './OpShipSeatsPanel';
import { useNotification } from '../../../../contexts/NotificationContext';

interface OpOrbatTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    onRefresh: () => void;
    onManageParticipant: (participant: any) => void;
    onRemoveParticipant: (userId: number) => void;
    onAddParticipant?: () => void;
}

const OpOrbatTab: React.FC<OpOrbatTabProps> = ({ operation, canManage, onRefresh, onManageParticipant, onRemoveParticipant, onAddParticipant }) => {
    const { currentUser } = useAuth();
    const { rpcAction } = useData();
    const { confirm } = useNotification();
    const nodes = operation.commandNodes || [];

    const [subView, setSubView] = useState<'roster' | 'structure' | 'seats'>('roster');

    const [rosterSearch, setRosterSearch] = useState('');
    const [rosterSort, setRosterSort] = useState<'name' | 'role' | 'ready' | 'joined'>('ready');

    const [showForm, setShowForm] = useState(false);
    const [editingNode, setEditingNode] = useState<OperationCommandNode | null>(null);
    const [label, setLabel] = useState('');
    const [nodeType, setNodeType] = useState<'command' | 'unit' | 'position'>('position');
    const [parentId, setParentId] = useState<string>('');
    const [assignedUserId, setAssignedUserId] = useState('');
    const [color, setColor] = useState('#3b82f6');
    const [saving, setSaving] = useState(false);

    const activeParticipants = useMemo(() => (operation.participants || []).filter(p => p.timeLeft === null), [operation.participants]);

    const sortedRosterParticipants = useMemo(() => {
        let list = [...activeParticipants];

        if (rosterSearch.trim()) {
            const term = rosterSearch.toLowerCase();
            list = list.filter(p => (p.user?.name || '').toLowerCase().includes(term));
        }

        list.sort((a, b) => {
            if (a.userId === operation.ownerId) return -1;
            if (b.userId === operation.ownerId) return 1;
            switch (rosterSort) {
                case 'name': return (a.user?.name || '').localeCompare(b.user?.name || '');
                case 'role': return (a.roleRequested || '').localeCompare(b.roleRequested || '');
                case 'ready': return (b.isReady ? 1 : 0) - (a.isReady ? 1 : 0);
                case 'joined': return new Date(a.timeJoined).getTime() - new Date(b.timeJoined).getTime();
                default: return 0;
            }
        });

        return list;
    }, [activeParticipants, rosterSearch, rosterSort, operation.ownerId]);

    const rosterStats = useMemo(() => {
        const ready = activeParticipants.filter(p => p.isReady).length;
        const total = activeParticipants.length;
        const accepted = activeParticipants.filter(p => p.rsvpStatus === RSVPStatus.Accepted).length;
        const tentative = activeParticipants.filter(p => p.rsvpStatus === RSVPStatus.Tentative).length;
        const declined = activeParticipants.filter(p => p.rsvpStatus === RSVPStatus.Declined).length;
        const pending = activeParticipants.filter(p => !p.rsvpStatus || p.rsvpStatus === RSVPStatus.Pending).length;
        return { ready, total, accepted, tentative, declined, pending };
    }, [activeParticipants]);

    const openAddForm = (defaultParentId?: number) => {
        setEditingNode(null);
        setLabel('');
        setNodeType('position');
        setParentId(defaultParentId ? String(defaultParentId) : '');
        setAssignedUserId('');
        setColor('#3b82f6');
        setShowForm(true);
    };

    const openEditForm = (node: OperationCommandNode) => {
        setEditingNode(node);
        setLabel(node.label);
        setNodeType(node.nodeType);
        setParentId(node.parentId ? String(node.parentId) : '');
        setAssignedUserId(node.assignedUserId ? String(node.assignedUserId) : '');
        setColor(node.color || '#3b82f6');
        setShowForm(true);
    };

    const handleSaveNode = async () => {
        if (!label.trim()) return;
        setSaving(true);
        try {
            const data = {
                label: label.trim(),
                nodeType,
                parentId: parentId ? parseInt(parentId) : null,
                assignedUserId: assignedUserId ? parseInt(assignedUserId) : null,
                color,
            };
            if (editingNode) {
                await rpcAction('operation:update_command_node', { nodeId: editingNode.id, data, operationId: operation.id });
            } else {
                await rpcAction('operation:add_command_node', { operationId: operation.id, data: { ...data, sortOrder: nodes.length } });
            }
            setShowForm(false);
            setEditingNode(null);
            onRefresh();
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteNode = async (nodeId: number) => {
        await rpcAction('operation:delete_command_node', { nodeId, operationId: operation.id });
        onRefresh();
    };

    const inputClass = "w-full bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2.5 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 transition-all";
    const labelClass = "text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1.5 block";

    return (
        <div className="p-4 md:p-6 space-y-4 flex flex-col h-full">
            {/* Header with sub-view toggle */}
            <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                        <i className="fa-solid fa-sitemap text-slate-500"></i> ORBAT
                    </h3>
                    <div className="flex items-center bg-slate-800/60 border border-slate-700/50 rounded-lg p-0.5">
                        <button onClick={() => setSubView('roster')}
                            className={`px-3 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                                subView === 'roster' ? 'bg-purple-500/20 text-purple-300' : 'text-slate-500 hover:text-slate-300'
                            }`}>Roster</button>
                        <button onClick={() => setSubView('structure')}
                            className={`px-3 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                                subView === 'structure' ? 'bg-purple-500/20 text-purple-300' : 'text-slate-500 hover:text-slate-300'
                            }`}>Structure</button>
                        <button onClick={() => setSubView('seats')}
                            className={`px-3 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                                subView === 'seats' ? 'bg-purple-500/20 text-purple-300' : 'text-slate-500 hover:text-slate-300'
                            }`}>Ships &amp; Seats</button>
                    </div>
                </div>
                <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2">
                    <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider">Ready</span>
                    <span className="text-sm font-bold text-green-400">{rosterStats.ready}</span>
                    <span className="text-slate-600">/</span>
                    <span className="text-sm font-bold text-white">{rosterStats.total}</span>
                    {rosterStats.total > 0 && (
                        <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${(rosterStats.ready / rosterStats.total) * 100}%` }}></div>
                        </div>
                    )}
                </div>
            </div>

            {/* ROSTER Sub-View */}
            {subView === 'roster' && (
                <>
                    {/* Stats Bar */}
                    <div className="flex flex-wrap gap-3 items-center shrink-0">
                        {operation.maxParticipants && (
                            <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2">
                                <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider">Capacity</span>
                                <span className="text-sm font-bold text-white">{rosterStats.total} / {operation.maxParticipants}</span>
                            </div>
                        )}
                        {operation.scheduledStart && (rosterStats.accepted + rosterStats.tentative + rosterStats.declined) > 0 && (
                            <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-[10px] font-mono">
                                <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider mr-1">RSVP</span>
                                {rosterStats.accepted > 0 && <span className="text-green-400">{rosterStats.accepted}<i className="fa-solid fa-check ml-0.5"></i></span>}
                                {rosterStats.tentative > 0 && <span className="text-amber-400">{rosterStats.tentative}<i className="fa-solid fa-question ml-0.5"></i></span>}
                                {rosterStats.declined > 0 && <span className="text-red-400">{rosterStats.declined}<i className="fa-solid fa-xmark ml-0.5"></i></span>}
                                {rosterStats.pending > 0 && <span className="text-slate-500">{rosterStats.pending}<i className="fa-solid fa-minus ml-0.5"></i></span>}
                            </div>
                        )}
                        {canManage && onAddParticipant && (
                            <button onClick={onAddParticipant}
                                className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors">
                                <i className="fa-solid fa-user-plus"></i> Add Participant
                            </button>
                        )}
                    </div>

                    {/* Search + Sort */}
                    <div className="flex gap-3 items-center shrink-0">
                        <div className="relative flex-1">
                            <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-600 text-xs"></i>
                            <input type="text" value={rosterSearch} onChange={e => setRosterSearch(e.target.value)} placeholder="Search participants..."
                                className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-xs text-white outline-hidden focus:border-purple-500/40 placeholder:text-slate-600" />
                        </div>
                        <select value={rosterSort} onChange={e => setRosterSort(e.target.value as any)}
                            className="bg-slate-800 border border-slate-700/50 rounded-lg px-3 py-2 text-[10px] text-slate-300 font-bold uppercase outline-hidden appearance-none cursor-pointer scheme-light"
                            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: '28px' }}>
                            <option value="ready">Sort: Ready</option>
                            <option value="name">Sort: Name</option>
                            <option value="role">Sort: Role</option>
                            <option value="joined">Sort: Joined</option>
                        </select>
                    </div>

                    {/* Roster List */}
                    <div className="flex-1 space-y-2 overflow-y-auto custom-scrollbar pr-1">
                        {sortedRosterParticipants.length > 0 ? (
                            sortedRosterParticipants.map(p => (
                                <div key={p.userId} className={`p-3 rounded-lg flex items-center justify-between space-x-3 border transition-all group ${p.isReady ? 'bg-green-900/10 border-green-500/30 shadow-[inset_0_0_10px_rgba(34,197,94,0.05)]' : 'bg-slate-800/40 border-slate-700/30'}`}>
                                    <div className="flex items-center space-x-3 min-w-0">
                                        <div className="relative">
                                            {p.user?.avatarUrl ? (
                                                <img src={p.user.avatarUrl} alt={p.user.name} className={`h-10 w-10 rounded-full shrink-0 object-cover border-2 ${p.isReady ? 'border-green-500' : 'border-slate-700'}`} />
                                            ) : (
                                                <div className={`h-10 w-10 rounded-full shrink-0 border-2 bg-slate-800 flex items-center justify-center ${p.isReady ? 'border-green-500' : 'border-slate-700'}`}>
                                                    <i className="fa-solid fa-user text-slate-500"></i>
                                                </div>
                                            )}
                                            {p.isReady && <div className="absolute -bottom-1 -right-1 bg-green-500 rounded-full p-0.5 border-2 border-slate-900"><i className="fa-solid fa-check text-[8px] text-black block"></i></div>}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-bold text-sm text-white truncate flex items-center gap-1.5">
                                                {p.user?.name || 'Unknown'}
                                                {p.userId === operation.ownerId && <i className="fa-solid fa-crown text-[10px] text-amber-400" title="Lead"></i>}
                                            </p>
                                            <div className="flex gap-2 items-center flex-wrap">
                                                <span className="text-[10px] text-slate-400 uppercase tracking-wider">{p.user?.rank?.name || p.user?.role || 'Member'}</span>
                                                {p.roleRequested && <span className="text-[9px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-purple-300 border border-slate-700">{p.roleRequested}</span>}
                                                {(p.ship || p.shipUtilized) && (
                                                    <span className="text-[9px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-amber-400 border border-slate-700 flex items-center gap-1">
                                                        {p.ship?.imageUrl ? (
                                                            <img src={p.ship.imageUrl} alt="" className="w-4 h-3 object-cover rounded-sm" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                                        ) : (
                                                            <i className="fa-solid fa-rocket"></i>
                                                        )}
                                                        {p.ship?.name || p.shipUtilized}
                                                    </span>
                                                )}
                                                {p.rsvpStatus && p.rsvpStatus !== RSVPStatus.Pending && (
                                                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                                                        p.rsvpStatus === RSVPStatus.Accepted ? 'bg-green-900/30 text-green-400 border-green-500/30' :
                                                        p.rsvpStatus === RSVPStatus.Tentative ? 'bg-amber-900/30 text-amber-400 border-amber-500/30' :
                                                        p.rsvpStatus === RSVPStatus.Declined ? 'bg-red-900/30 text-red-400 border-red-500/30' :
                                                        'bg-slate-800 text-slate-400 border-slate-700'
                                                    }`}>{p.rsvpStatus}</span>
                                                )}
                                                {p.attendanceStatus && p.attendanceStatus !== 'Registered' && (
                                                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                                                        p.attendanceStatus === 'Attended' ? 'bg-green-900/30 text-green-400 border-green-500/30' :
                                                        p.attendanceStatus === 'Late' ? 'bg-amber-900/30 text-amber-400 border-amber-500/30' :
                                                        p.attendanceStatus === 'No Show' ? 'bg-red-900/30 text-red-400 border-red-500/30' :
                                                        p.attendanceStatus === 'Excused' ? 'bg-slate-700/50 text-slate-400 border-slate-600' :
                                                        'bg-slate-800 text-slate-400 border-slate-700'
                                                    }`}>{p.attendanceStatus}</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {canManage && (
                                            <>
                                                <button onClick={() => onManageParticipant(p)}
                                                    className="text-slate-600 hover:text-purple-300 opacity-0 group-hover:opacity-100 transition-opacity p-2 hover:bg-purple-500/10 rounded-sm" title="Edit Participant">
                                                    <i className="fa-solid fa-pen-to-square"></i>
                                                </button>
                                                {p.userId !== operation.ownerId && (
                                                    <button onClick={async () => { const ok = await confirm({ title: 'Remove Participant', message: `Remove ${p.user?.name} from operation?`, confirmText: 'Remove', variant: 'danger' }); if (ok) onRemoveParticipant(p.userId); }}
                                                        className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-2 hover:bg-red-500/10 rounded-sm" title="Remove Participant">
                                                        <i className="fa-solid fa-xmark"></i>
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="flex flex-col items-center justify-center h-40 text-slate-600 opacity-50">
                                <i className="fa-solid fa-user-slash text-3xl mb-2"></i>
                                <p className="text-xs italic">No active participants.</p>
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* STRUCTURE Sub-View */}
            {subView === 'structure' && (
                <div className="flex-1 min-h-0 flex flex-col gap-3">
                    {/* Add node button */}
                    {canManage && (
                        <div className="flex items-center justify-end shrink-0">
                            <button onClick={() => openAddForm()} className="text-[10px] font-bold text-purple-300 hover:text-purple-200 uppercase">
                                <i className="fa-solid fa-plus mr-1"></i> Add Node
                            </button>
                        </div>
                    )}

                    {/* Node form */}
                    {showForm && (
                        <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4 space-y-3 animate-fade-in shrink-0">
                            <div className="grid grid-cols-3 gap-3">
                                <div>
                                    <label className={labelClass}>Label</label>
                                    <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g., Alpha Lead" className={`${inputClass} w-full`} />
                                </div>
                                <div>
                                    <label className={labelClass}>Node Type</label>
                                    <select value={nodeType} onChange={e => setNodeType(e.target.value as any)} className={`${inputClass} w-full`}>
                                        <option value="command">Command</option>
                                        <option value="unit">Unit</option>
                                        <option value="position">Position</option>
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Color</label>
                                    <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-full h-[34px] rounded-sm cursor-pointer bg-transparent border-0" />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className={labelClass}>Parent Node</label>
                                    <select value={parentId} onChange={e => setParentId(e.target.value)} className={`${inputClass} w-full`}>
                                        <option value="">- Root (Top Level) -</option>
                                        {nodes.filter(n => !editingNode || n.id !== editingNode.id).map(n => (
                                            <option key={n.id} value={n.id}>{n.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Assign Participant</label>
                                    <select value={assignedUserId} onChange={e => setAssignedUserId(e.target.value)} className={`${inputClass} w-full`}>
                                        <option value="">- None -</option>
                                        {activeParticipants.map(p => <option key={p.userId} value={p.userId}>{p.user?.name}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={() => { setShowForm(false); setEditingNode(null); }} className="text-xs text-slate-400 hover:text-white px-3 py-1.5">Cancel</button>
                                <button onClick={handleSaveNode} disabled={saving || !label.trim()} className="text-xs text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-1.5 rounded-sm disabled:opacity-50">
                                    {saving ? <i className="fa-solid fa-spinner animate-spin"></i> : editingNode ? 'Update Node' : 'Add Node'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Node Graph */}
                    <OpOrbatNodeGraph
                        operation={operation}
                        canManage={canManage}
                        onAddNode={openAddForm}
                        onEditNode={openEditForm}
                        onDeleteNode={handleDeleteNode}
                        fillParent
                    />
                </div>
            )}

            {/* SHIPS & SEATS — organiser-designed ships with named seats, or flat
                capacity groups. A separate sub-view rather than folded into the
                command graph: the two are different ORBAT structures that happen to
                share a tab, and merging them is not this port's job. */}
            {subView === 'seats' && (
                <OpShipSeatsPanel operation={operation} canManage={canManage} onRefresh={onRefresh} />
            )}
        </div>
    );
};

export default OpOrbatTab;
