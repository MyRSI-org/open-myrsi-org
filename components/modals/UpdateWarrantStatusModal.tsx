
import React, { useState, useCallback } from 'react';
import { HydratedWarrant, WarrantStatus, WarrantAction } from '../../types';
import { useOperations } from '../../contexts/OperationsContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface UpdateWarrantModalProps {
    isOpen: boolean;
    onClose: () => void;
    warrant: HydratedWarrant;
}

const UpdateWarrantModal: React.FC<UpdateWarrantModalProps> = ({ isOpen, onClose, warrant }) => {
    const { updateWarrant } = useOperations();
    const { addToast } = useNotification();

    const [targetRsiHandle, setTargetRsiHandle] = useState(warrant.targetRsiHandle);
    const [reason, setReason] = useState(warrant.reason);
    const [action, setAction] = useState<WarrantAction>(warrant.action);
    const [uecReward, setUecReward] = useState(warrant.uecReward.toString());
    const [status, setStatus] = useState<WarrantStatus>(warrant.status);
    const [isLoading, setIsLoading] = useState(false);

    // Seed/reset the editable form from props when the modal opens or the edited
    // warrant changes. React-documented "adjust state during render" pattern
    // (previous-value tracker): behaviour-equivalent to the prior effect, which had
    // deps [isOpen, warrant] and re-seeded whenever isOpen was true and either input
    // changed. We re-seed during render on the same input changes, only when isOpen.
    const [prevSeedKey, setPrevSeedKey] = useState({ isOpen, warrant });
    if (prevSeedKey.isOpen !== isOpen || prevSeedKey.warrant !== warrant) {
        setPrevSeedKey({ isOpen, warrant });
        if (isOpen) {
            setTargetRsiHandle(warrant.targetRsiHandle);
            setReason(warrant.reason);
            setAction(warrant.action);
            setUecReward(warrant.uecReward.toString());
            setStatus(warrant.status);
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        const reward = parseInt(uecReward);
        if (targetRsiHandle.trim() && reason.trim() && !isNaN(reward) && reward > 0) {
            setIsLoading(true);
            try {
                // Notes are an append-only thread on the warrant detail view; this
                // modal stays focused on status + reason. Pass the existing notes
                // value through unchanged so the legacy notes column isn't wiped
                // on a status update.
                await updateWarrant(warrant.id, {
                    targetRsiHandle: targetRsiHandle.trim(),
                    reason: reason.trim(),
                    action,
                    uecReward: reward,
                    status,
                    notes: warrant.notes,
                });
                onClose();
            } catch (err) {
                console.error("Failed to update warrant:", err);
                addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while updating the caution. Please try again." });
                setIsLoading(false);
            }
        }
    }, [updateWarrant, warrant.id, warrant.notes, targetRsiHandle, reason, action, uecReward, status, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-red-500 focus:ring-1 focus:ring-red-500/50 outline-hidden transition-all disabled:opacity-50 disabled:cursor-not-allowed";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    const isConcluded = warrant.status === WarrantStatus.Claimed || warrant.status === WarrantStatus.Cancelled;
    const canEditDetails = !isConcluded;

    const getStatusOptions = () => {
        switch (warrant.status) {
            case WarrantStatus.Active:
                return [WarrantStatus.Active, WarrantStatus.Claimed, WarrantStatus.Cancelled, WarrantStatus.Standing];
            case WarrantStatus.Standing:
                return [WarrantStatus.Standing, WarrantStatus.Cancelled];
            default:
                return [warrant.status];
        }
    }

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Update Caution"
            subtitle={`CN-${warrant.id.substring(0, 6)}`}
            icon="fa-solid fa-triangle-exclamation"
            color="red"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    {/* Code-of-conduct compliance notice */}
                    <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                        <i className="fa-solid fa-circle-info text-amber-400 mt-0.5 shrink-0"></i>
                        <p className="text-[11px] leading-relaxed text-amber-100/90">
                            Caution notes are only for alerting service request responders to potential risks. Using this feature for kill-on-sight lists, targeted attacks, or griefing is against CIG's{' '}
                            <a
                                href="https://support.robertsspaceindustries.com/hc/en-us/articles/4409491235351-Rules-of-Conduct"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold text-amber-300 underline hover:text-amber-200"
                            >Rules of Conduct</a>.
                        </p>
                    </div>
                    <div>
                        <label className={labelClass}>Target RSI Handle</label>
                        <input type="text" value={targetRsiHandle} onChange={(e) => setTargetRsiHandle(e.target.value)} className={inputClass} required disabled={isLoading || !canEditDetails} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                            <label className={labelClass}>Action</label>
                            <select value={action} onChange={(e) => setAction(e.target.value as WarrantAction)} className={inputClass} disabled={isLoading || !canEditDetails}>
                                {Object.values(WarrantAction).map(act => <option key={act} value={act}>{act}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>UEC Reward</label>
                            <input type="number" value={uecReward} onChange={(e) => setUecReward(e.target.value)} className={inputClass} required disabled={isLoading || !canEditDetails} />
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Reason</label>
                        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={`${inputClass} resize-none`} required disabled={isLoading || !canEditDetails} />
                    </div>
                    <div className="border-t border-slate-700/50 pt-5 space-y-5">
                        <div>
                            <label className={labelClass}>New Status</label>
                            <select value={status} onChange={(e) => setStatus(e.target.value as WarrantStatus)} className={inputClass} disabled={isLoading || isConcluded}>
                                {getStatusOptions().map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                        </div>
                        <p className="text-[10px] text-slate-500 italic">
                            <i className="fa-solid fa-circle-info mr-1 text-slate-600"></i>
                            Notes are now posted as an append-only thread from the caution note detail view.
                        </p>
                    </div>
                </div>
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-lg shadow-red-900/30 disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Update Caution'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};
export default UpdateWarrantModal;
