import React, { useMemo, useState } from 'react';
import { HydratedOperation, OperationShipSlot, OperationSlotAssignment } from '../../../../types';
import { useAuth } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';
import { useNotification } from '../../../../contexts/NotificationContext';

interface Props {
    operation: HydratedOperation;
    canManage: boolean;
    onRefresh: () => void;
}

// Ships & seats. A TOP-LEVEL slot is a ship or a generic capacity group; a slot with
// parentSlotId set is a named seat on that ship. A top-level slot with capacity > 1
// and no children is a flat group ("Solo Fighters" x10) and is itself fillable.
//
// Every gate here is COSMETIC — the server re-decides all of it
// (api/actions/operations.ts + lib/db/ops.ts). In particular `canManage` only hides
// controls; pending applications are filtered out of the payload server-side, so a
// non-manager cannot see them by editing this file.
const OpShipSeatsPanel: React.FC<Props> = ({ operation, canManage, onRefresh }) => {
    const { currentUser } = useAuth();
    const { rpcAction } = useData();
    const { confirm } = useNotification();

    const slots = useMemo(() => operation.shipSlots || [], [operation.shipSlots]);
    // Seat holders are resolved against the op's ACTIVE roster. The server drops a
    // member's seats when they leave and when the operation concludes, precisely so
    // this lookup cannot go stale and render "User #N".
    const participants = useMemo(() => (operation.participants || []).filter(p => p.timeLeft === null), [operation.participants]);
    const topLevel = useMemo(() => slots.filter(s => !s.parentSlotId).sort((a, b) => a.sortOrder - b.sortOrder), [slots]);
    const childrenOf = (parentId: number) => slots.filter(s => s.parentSlotId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);

    const [busy, setBusy] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const [newCapacity, setNewCapacity] = useState('1');
    const [addSeatFor, setAddSeatFor] = useState<number | null>(null);
    const [seatLabel, setSeatLabel] = useState('');

    const call = async (action: string, payload: Record<string, unknown>) => {
        setBusy(true);
        try { await rpcAction(action, payload); onRefresh(); }
        catch { /* surfaced globally by rpcAction */ }
        finally { setBusy(false); }
    };

    const addGroup = async () => {
        if (!newLabel.trim()) return;
        await call('operation:add_ship_slot', { operationId: operation.id, data: { label: newLabel.trim(), capacity: Math.max(1, parseInt(newCapacity, 10) || 1), sortOrder: topLevel.length } });
        setNewLabel(''); setNewCapacity('1'); setShowAdd(false);
    };

    const addSeat = async (parentSlotId: number, count: number) => {
        if (!seatLabel.trim()) return;
        await call('operation:add_ship_slot', { operationId: operation.id, data: { label: seatLabel.trim(), parentSlotId, capacity: 1, sortOrder: count } });
        setSeatLabel(''); setAddSeatFor(null);
    };

    const deleteSlot = async (slot: OperationShipSlot, isGroup: boolean) => {
        const ok = await confirm({
            title: isGroup ? 'Remove ship / group' : 'Remove seat',
            message: isGroup ? `Remove "${slot.label}" and all its seats + assignments?` : `Remove the "${slot.label}" seat?`,
            confirmText: 'Remove', variant: 'danger',
        });
        if (ok) await call('operation:delete_ship_slot', { slotId: slot.id, operationId: operation.id });
    };

    const assign = (slot: OperationShipSlot, targetUserId: number) =>
        call('operation:assign_slot', { operationId: operation.id, slotId: slot.id, targetUserId });
    const removeAssignment = (slot: OperationShipSlot, targetUserId: number) =>
        call('operation:remove_slot_assignment', { operationId: operation.id, slotId: slot.id, targetUserId });
    const decide = (slot: OperationShipSlot, targetUserId: number, decision: 'approve' | 'deny') =>
        call('operation:decide_slot_application', { operationId: operation.id, slotId: slot.id, targetUserId, decision });
    const applySelf = (slot: OperationShipSlot) => call('operation:apply_for_slot', { operationId: operation.id, slotId: slot.id });
    // No targetUserId, by design: the server takes the dispatcher-forced userId, so
    // this action can only ever act on the caller's own seat.
    const withdrawSelf = (slot: OperationShipSlot) => call('operation:withdraw_slot', { operationId: operation.id, slotId: slot.id });

    const nameOf = (userId: number) => participants.find(p => p.userId === userId)?.user?.name || `User #${userId}`;

    // Renders a single FILLABLE slot: a named seat, or a capacity group with no children.
    const renderSlot = (slot: OperationShipSlot) => {
        const assignments = slot.assignments || [];
        const assigned = assignments.filter(a => a.status === 'assigned');
        const applied = assignments.filter(a => a.status === 'applied');
        const full = assigned.length >= slot.capacity;
        const mine = currentUser ? assignments.find(a => a.userId === currentUser.id) : undefined;
        // Only members already on the roster can be seated — the server requires an
        // ACTIVE participant rather than enrolling the target, so offering anyone
        // else here would just produce a refusal.
        const assignable = participants.filter(p => !assignments.some(a => a.userId === p.userId));

        return (
            <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <span className="text-sm font-bold text-white truncate">{slot.label}</span>
                        {slot.seatRole && <span className="ml-2 text-[9px] uppercase tracking-wider text-slate-500">{slot.seatRole}</span>}
                    </div>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-sm border ${full ? 'text-amber-300 border-amber-500/30 bg-amber-900/20' : 'text-slate-400 border-slate-700 bg-slate-800/60'}`}>
                        {assigned.length}/{slot.capacity}
                    </span>
                </div>

                {assigned.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {assigned.map((a: OperationSlotAssignment) => (
                            <span key={a.id} className="inline-flex items-center gap-1.5 text-[11px] bg-green-900/20 text-green-300 border border-green-500/30 rounded-sm pl-2 pr-1 py-0.5">
                                {nameOf(a.userId)}
                                {canManage && (
                                    <button onClick={() => removeAssignment(slot, a.userId)} disabled={busy} title="Remove" className="text-green-400/60 hover:text-red-300">
                                        <i className="fa-solid fa-xmark text-[10px]" />
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                )}

                {/* Applications. The server ships these ONLY to the owner, an
                    operations:manage holder, or the applicant themselves. */}
                {applied.length > 0 && (
                    <div className="mt-2 space-y-1">
                        {applied.map((a: OperationSlotAssignment) => (
                            <div key={a.id} className="flex items-center justify-between text-[11px] bg-slate-900/40 border border-slate-700/40 rounded-sm px-2 py-1">
                                <span className="text-amber-200"><i className="fa-solid fa-hand text-[10px] mr-1.5 text-amber-400" />{nameOf(a.userId)} applied</span>
                                {canManage && (
                                    <span className="flex items-center gap-1">
                                        <button onClick={() => decide(slot, a.userId, 'approve')} disabled={busy || full} className="text-green-300 hover:text-green-200 disabled:opacity-40 px-1.5 py-0.5" title={full ? 'Slot full' : 'Approve'}><i className="fa-solid fa-check" /></button>
                                        <button onClick={() => decide(slot, a.userId, 'deny')} disabled={busy} className="text-red-300 hover:text-red-200 px-1.5 py-0.5" title="Deny"><i className="fa-solid fa-xmark" /></button>
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {canManage && !full && assignable.length > 0 && (
                        <select
                            value=""
                            onChange={e => { if (e.target.value) assign(slot, parseInt(e.target.value, 10)); }}
                            disabled={busy}
                            className="bg-slate-900 border border-slate-700/50 rounded-sm px-2 py-1 text-[11px] text-slate-300"
                        >
                            <option value="">+ Assign…</option>
                            {assignable.map(p => <option key={p.userId} value={p.userId}>{p.user?.name}</option>)}
                        </select>
                    )}
                    {!mine && !full && (
                        <button onClick={() => applySelf(slot)} disabled={busy} className="text-[10px] font-bold uppercase tracking-wider text-purple-300 hover:text-purple-200 bg-purple-500/10 border border-purple-500/30 rounded-sm px-2 py-1">
                            <i className="fa-solid fa-hand mr-1" />Apply
                        </button>
                    )}
                    {mine && mine.status === 'applied' && (
                        <button onClick={() => withdrawSelf(slot)} disabled={busy} className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-300 border border-slate-700 rounded-sm px-2 py-1">
                            Withdraw application
                        </button>
                    )}
                    {mine && mine.status === 'assigned' && (
                        <button onClick={() => withdrawSelf(slot)} disabled={busy} className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-300 border border-slate-700 rounded-sm px-2 py-1">
                            Leave seat
                        </button>
                    )}
                    {full && !mine && <span className="text-[10px] text-slate-500 uppercase tracking-wider">Full</span>}
                </div>
            </div>
        );
    };

    return (
        <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto custom-scrollbar pr-1">
            {canManage && (
                <div className="flex items-center justify-between shrink-0">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Designate ships &amp; seats — members apply or you assign them.</p>
                    <button onClick={() => setShowAdd(v => !v)} className="text-[10px] font-bold text-purple-300 hover:text-purple-200 uppercase">
                        <i className={`fa-solid ${showAdd ? 'fa-xmark' : 'fa-plus'} mr-1`} />{showAdd ? 'Cancel' : 'Add Ship / Slot'}
                    </button>
                </div>
            )}

            {canManage && showAdd && (
                <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 flex flex-col sm:flex-row gap-2 shrink-0">
                    <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Ship or slot name (e.g. Perseus, Solo Fighters)" maxLength={80}
                        className="flex-1 bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40" />
                    <input type="number" min={1} max={500} value={newCapacity} onChange={e => setNewCapacity(e.target.value)} title="Capacity (use >1 for a generic slot like '10 fighters')"
                        className="w-24 bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40" />
                    <button onClick={addGroup} disabled={busy || !newLabel.trim()} className="text-xs text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-2 rounded-lg disabled:opacity-50">Add</button>
                </div>
            )}

            {topLevel.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-slate-600 opacity-60">
                    <i className="fa-solid fa-jet-fighter-up text-3xl mb-2" />
                    <p className="text-xs italic">No ships or seats yet.{canManage ? ' Use "Add Ship / Slot" to designate them.' : ''}</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {topLevel.map(group => {
                        const seats = childrenOf(group.id);
                        const groupAssignments = group.assignments || [];
                        return (
                            <div key={group.id} className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-3">
                                <div className="flex items-center justify-between gap-2 mb-2">
                                    <h4 className="text-sm font-black text-white flex items-center gap-2 min-w-0">
                                        <i className="fa-solid fa-rocket text-slate-500" />
                                        <span className="truncate">{group.label}</span>
                                        {group.ship?.name && <span className="text-[10px] text-slate-500 font-normal truncate">· {group.ship.name}</span>}
                                    </h4>
                                    {canManage && (
                                        <div className="flex items-center gap-1 shrink-0">
                                            {/* A ship holds EITHER direct members OR named seats, never both —
                                                hide "Add seat" once it has its own assignments, matching the
                                                server invariant rather than letting the click 400. */}
                                            {groupAssignments.length === 0 && (
                                                <button onClick={() => { setAddSeatFor(addSeatFor === group.id ? null : group.id); setSeatLabel(''); }} className="text-[10px] font-bold text-purple-300 hover:text-purple-200 uppercase px-1.5">
                                                    <i className="fa-solid fa-plus mr-1" />Seat
                                                </button>
                                            )}
                                            <button onClick={() => deleteSlot(group, true)} disabled={busy} className="text-slate-600 hover:text-red-400 p-1" title="Remove ship/group">
                                                <i className="fa-solid fa-trash-can text-xs" />
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {canManage && addSeatFor === group.id && (
                                    <div className="flex gap-2 mb-2">
                                        <input type="text" value={seatLabel} onChange={e => setSeatLabel(e.target.value)} placeholder="Seat name (e.g. Captain, Main Gun 1)" maxLength={80} autoFocus
                                            className="flex-1 bg-black/20 border border-slate-700/50 text-white text-xs rounded-lg px-3 py-1.5 outline-hidden focus:border-purple-500/40"
                                            onKeyDown={e => { if (e.key === 'Enter') addSeat(group.id, seats.length); }} />
                                        <button onClick={() => addSeat(group.id, seats.length)} disabled={busy || !seatLabel.trim()} className="text-[11px] text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-3 rounded-lg disabled:opacity-50">Add seat</button>
                                    </div>
                                )}

                                {seats.length > 0 ? (
                                    <div className="space-y-2">
                                        {seats.map(seat => (
                                            <div key={seat.id} className="flex gap-2 items-start">
                                                <div className="flex-1">{renderSlot(seat)}</div>
                                                {canManage && (
                                                    <button onClick={() => deleteSlot(seat, false)} disabled={busy} className="text-slate-600 hover:text-red-400 p-1.5 mt-1" title="Remove seat">
                                                        <i className="fa-solid fa-xmark text-xs" />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    // No named seats → the group itself is the fillable slot.
                                    renderSlot(group)
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default OpShipSeatsPanel;
