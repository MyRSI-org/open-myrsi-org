
import React, { useState, useCallback } from 'react';
import { ServiceRequestStatus, HydratedServiceRequest } from '../../types';
import { useRequests } from '../../contexts/RequestsContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface UpdateRequestModalProps {
    isOpen: boolean;
    onClose: () => void;
    request: HydratedServiceRequest;
}

const completionStatuses = [
    ServiceRequestStatus.Success,
    ServiceRequestStatus.Failed,
    ServiceRequestStatus.Aborted,
    ServiceRequestStatus.GameError,
];

interface RepButtonProps {
    value: number;
    label: string;
    icon: React.ReactNode;
    activeClass: string;
    repChange: number;
    isLoading: boolean;
    onSelect: (value: number) => void;
}

const RepButton: React.FC<RepButtonProps> = ({ value, label, icon, activeClass, repChange, isLoading, onSelect }) => (
    <button
        type="button"
        onClick={() => onSelect(value)}
        disabled={isLoading}
        className={`flex-1 flex flex-col items-center justify-center p-3 rounded-xl border transition-all disabled:opacity-50 ${repChange === value ? activeClass : 'border-slate-700 bg-slate-900/50 text-slate-500 hover:border-slate-600 hover:text-slate-300'}`}
    >
        <div className={`text-xl mb-1 ${repChange === value ? 'text-white' : ''}`}>{icon}</div>
        <span className="text-[10px] font-black uppercase tracking-wider">{label}</span>
    </button>
);

const UpdateRequestModal: React.FC<UpdateRequestModalProps> = ({ isOpen, onClose, request }) => {
    const { updateRequestStatus } = useRequests();
    const { addToast } = useNotification();
    const [status, setStatus] = useState(request.status);
    const [notes, setNotes] = useState('');
    const [uecEarned, setUecEarned] = useState(request.uecEarned?.toString() || '');
    const [medigelConsumed, setMedigelConsumed] = useState(request.medigelConsumed?.toString() || '');
    const [repChange, setRepChange] = useState<number>(0);
    const [isLoading, setIsLoading] = useState(false);

    const isCompletion = completionStatuses.includes(status);

    // Form-reset when the modal opens. React-documented "adjust state during render"
    // pattern (previous-value tracker): re-seed the user-editable fields only on the
    // closed -> open transition, exactly as the prior open-reset effect did. Reading
    // request.* only here (not on every render) preserves the original behavior of NOT
    // clobbering the user's in-progress edits when a realtime row update arrives while
    // the modal is open.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (isOpen) {
            setStatus(request.status);
            setNotes('');
            setUecEarned(request.uecEarned?.toString() || '');
            setMedigelConsumed(request.medigelConsumed?.toString() || '');
            setRepChange(0);
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();

        let report;
        if (isCompletion) {
            report = {
                uecEarned: Number(uecEarned) || 0,
                medigelConsumed: request.serviceType === 'Rescue' ? (Number(medigelConsumed) || 0) : undefined,
                clientReputationChange: repChange
            };
        }

        setIsLoading(true);
        try {
            await updateRequestStatus(request.id, status, notes.trim(), report);
            onClose();
        } catch (err) {
            console.error("Failed to update status:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while updating the status. Please try again." });
            setIsLoading(false);
        }

    }, [request, status, notes, updateRequestStatus, isCompletion, uecEarned, medigelConsumed, repChange, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Update Status"
            subtitle="Manual Log Entry"
            icon="fa-solid fa-pen-to-square"
            color="amber"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-6">
                    <div>
                        <label className={labelClass}>Request Status</label>
                        <select
                            value={status}
                            onChange={(e) => setStatus(e.target.value as ServiceRequestStatus)}
                            className={inputClass}
                            disabled={isLoading}
                        >
                            {Object.values(ServiceRequestStatus).map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>

                    {isCompletion && (
                        <div className="space-y-6 pt-6 border-t border-slate-800 animate-fade-in">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div>
                                    <label className={labelClass}>UEC Earned</label>
                                    <div className="relative">
                                        <i className="fa-solid fa-coins absolute left-3 top-1/2 -translate-y-1/2 text-slate-600"></i>
                                        <input
                                            type="number"
                                            value={uecEarned}
                                            onChange={(e) => setUecEarned(e.target.value)}
                                            placeholder="0"
                                            className={`${inputClass} pl-10 font-mono`}
                                            disabled={isLoading}
                                        />
                                    </div>
                                </div>
                                {request.serviceType === 'Rescue' && (
                                    <div>
                                        <label className={labelClass}>Medigel (L)</label>
                                        <input
                                            type="number"
                                            step="0.1"
                                            value={medigelConsumed}
                                            onChange={(e) => setMedigelConsumed(e.target.value)}
                                            placeholder="0.0"
                                            className={`${inputClass} font-mono`}
                                            disabled={isLoading}
                                        />
                                    </div>
                                )}
                            </div>
                            <div>
                                <label className={labelClass}>Client Conduct</label>
                                <div className="flex items-center space-x-3">
                                    <RepButton value={1} label="Positive" icon={<i className="fa-solid fa-thumbs-up" />} activeClass="bg-green-500/20 border-green-500 text-green-400 shadow-lg shadow-green-900/20" repChange={repChange} isLoading={isLoading} onSelect={setRepChange} />
                                    <RepButton value={0} label="Neutral" icon={<span className="font-mono text-lg font-bold">-</span>} activeClass="bg-slate-700 border-slate-500 text-white" repChange={repChange} isLoading={isLoading} onSelect={setRepChange} />
                                    <RepButton value={-1} label="Negative" icon={<i className="fa-solid fa-thumbs-down" />} activeClass="bg-red-500/20 border-red-500 text-red-400 shadow-lg shadow-red-900/20" repChange={repChange} isLoading={isLoading} onSelect={setRepChange} />
                                </div>
                            </div>
                        </div>
                    )}

                    <div>
                        <label className={labelClass}>
                            {isCompletion ? 'After-Action Notes' : 'Log Entry Notes'}
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={4}
                            placeholder={isCompletion ? "Detail the outcome of the mission..." : "Add any relevant notes for this status change..."}
                            className={`${inputClass} resize-none`}
                            disabled={isLoading}
                        />
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/50 hover:bg-amber-500/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Update Status'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default UpdateRequestModal;
