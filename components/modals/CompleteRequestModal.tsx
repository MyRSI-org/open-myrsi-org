
import React, { useState, useCallback } from 'react';
import { HydratedServiceRequest, ServiceRequestStatus } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useRequests } from '../../contexts/RequestsContext';

import CreateIntelReportModal from './CreateIntelReportModal';
import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface CompleteRequestModalProps {
    isOpen: boolean;
    onClose: () => void;
    request: HydratedServiceRequest;
}

const outcomeOptions: ServiceRequestStatus[] = [
    ServiceRequestStatus.Success,
    ServiceRequestStatus.Failed,
    ServiceRequestStatus.Aborted,
    ServiceRequestStatus.GameError,
];

const RepButton: React.FC<{
    value: number;
    label: string;
    icon: React.ReactNode;
    activeClass: string;
    repChange: number;
    isLoading: boolean;
    onSelect: (value: number) => void;
}> = ({ value, label, icon, activeClass, repChange, isLoading, onSelect }) => (
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

const CompleteRequestModal: React.FC<CompleteRequestModalProps> = ({ isOpen, onClose, request }) => {
    const { currentUser } = useAuth();
    const { completeRequest } = useRequests();
    const { addToast } = useNotification();
    const [notes, setNotes] = useState('');
    const [uecEarned, setUecEarned] = useState('');
    const [medigelConsumed, setMedigelConsumed] = useState('');
    const [repChange, setRepChange] = useState<number>(0);
    const [outcome, setOutcome] = useState<ServiceRequestStatus>(ServiceRequestStatus.Success);
    const [fileIntelReport, setFileIntelReport] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [showIntelModal, setShowIntelModal] = useState(false);

    // Reset the whole form to its initial state each time the modal transitions from
    // closed to open. Using the React "adjust state during render" pattern (a previous-value
    // tracker) instead of an effect: it runs during render and React re-renders before paint,
    // so it is behaviour-equivalent to the old open-reset effect with no extra paint.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen && !prevIsOpen) {
        setPrevIsOpen(isOpen);
        setNotes('');
        setUecEarned('');
        setMedigelConsumed('');
        setRepChange(0);
        setOutcome(ServiceRequestStatus.Success);
        setFileIntelReport(false);
        setIsLoading(false);
        setShowIntelModal(false);
    } else if (!isOpen && prevIsOpen) {
        setPrevIsOpen(isOpen);
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentUser) return;
        setIsLoading(true);
        try {
            await completeRequest(request.id, {
                notes: notes.trim(),
                uecEarned: parseInt(uecEarned, 10) || 0,
                medigelConsumed: Number(medigelConsumed) || 0,
                clientReputationChange: repChange,
                outcome: outcome
            }, currentUser.id);

            if (fileIntelReport) {
                setShowIntelModal(true);
            } else {
                onClose();
            }
        } catch (err) {
            console.error("Failed to complete request:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while completing the request. Please try again." });
            setIsLoading(false);
        }
    }, [request, notes, uecEarned, medigelConsumed, repChange, outcome, completeRequest, onClose, fileIntelReport, currentUser, addToast]);

    const handleIntelClose = () => {
        setShowIntelModal(false);
        onClose();
    };

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-green-500 focus:ring-1 focus:ring-green-500/50 outline-hidden transition-all font-mono";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    const showIntelOption = outcome === ServiceRequestStatus.Failed || outcome === ServiceRequestStatus.Aborted || repChange < 0;

    return (
        <>
            <WindowFrame
                isOpen={isOpen && !showIntelModal}
                onClose={onClose}
                title="Mission Debrief"
                subtitle="Complete & Archive"
                icon="fa-solid fa-flag-checkered"
                color="green"
                width="max-w-lg"
            >
                <form onSubmit={handleSubmit} className="flex flex-col h-full">
                    <div className="p-6 space-y-6">
                        <div>
                            <label className={labelClass}>Outcome</label>
                            <select
                                value={outcome}
                                onChange={(e) => setOutcome(e.target.value as ServiceRequestStatus)}
                                className={inputClass.replace('font-mono', '')}
                                disabled={isLoading}
                            >
                                {outcomeOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                            </select>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className={labelClass}>UEC Earned</label>
                                <div className="relative">
                                    <i className="fa-solid fa-coins absolute left-3 top-1/2 -translate-y-1/2 text-slate-600"></i>
                                    <input
                                        type="number"
                                        step="1"
                                        min="0"
                                        value={uecEarned}
                                        onChange={(e) => setUecEarned(e.target.value.replace(/[^0-9]/g, ''))}
                                        onKeyDown={(e) => { if (e.key === '.' || e.key === 'e' || e.key === 'E' || e.key === '+' || e.key === '-') e.preventDefault(); }}
                                        placeholder="0"
                                        className={`${inputClass} pl-10`}
                                        disabled={isLoading}
                                    />
                                </div>
                            </div>
                            <div>
                                <label className={labelClass}>Medigel (L)</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={medigelConsumed}
                                    onChange={(e) => setMedigelConsumed(e.target.value)}
                                    placeholder="0.0"
                                    className={inputClass}
                                    disabled={isLoading}
                                />
                            </div>
                        </div>

                        <div>
                            <label className={labelClass}>Client Conduct Assessment</label>
                            <div className="flex items-center space-x-3">
                                <RepButton value={1} label="Positive" icon={<i className="fa-solid fa-thumbs-up" />} activeClass="bg-green-500/20 border-green-500 text-green-400 shadow-lg shadow-green-900/20" repChange={repChange} isLoading={isLoading} onSelect={setRepChange} />
                                <RepButton value={0} label="Neutral" icon={<span className="font-mono text-lg font-bold">-</span>} activeClass="bg-slate-700 border-slate-500 text-white" repChange={repChange} isLoading={isLoading} onSelect={setRepChange} />
                                <RepButton value={-1} label="Negative" icon={<i className="fa-solid fa-thumbs-down" />} activeClass="bg-red-500/20 border-red-500 text-red-400 shadow-lg shadow-red-900/20" repChange={repChange} isLoading={isLoading} onSelect={setRepChange} />
                            </div>
                        </div>

                        <div>
                            <label className={labelClass}>After-Action Report</label>
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                rows={4}
                                placeholder="Detail the outcome, key events, and any issues..."
                                className={`${inputClass.replace('font-mono', '')} resize-none`}
                                disabled={isLoading}
                            />
                        </div>

                        {showIntelOption && (
                            <div className="pt-4 border-t border-slate-800">
                                <label className="flex items-start space-x-3 cursor-pointer bg-red-900/10 p-4 rounded-xl border border-red-900/30 hover:bg-red-900/20 transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={fileIntelReport}
                                        onChange={(e) => setFileIntelReport(e.target.checked)}
                                        className="mt-1 h-5 w-5 rounded-sm bg-slate-800 border-slate-600 text-red-500 focus:ring-red-500"
                                        disabled={isLoading}
                                    />
                                    <div>
                                        <span className="text-red-400 font-bold block text-sm">File Intelligence Report</span>
                                        <span className="text-xs text-red-300/60 block mt-1">Flag this client or incident in the Intelligence Hub due to negative outcome.</span>
                                    </div>
                                </label>
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end items-center p-4 bg-slate-900/50 border-t border-slate-800 rounded-b-xl shrink-0 gap-3">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                        <button
                            type="submit"
                            className="px-6 py-2 bg-green-600/10 text-green-400 border border-green-600/30 hover:bg-green-600/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                            disabled={isLoading}
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Archive Mission'}
                        </button>
                    </div>
                </form>
            </WindowFrame>

            {/* Intel Modal is separate, triggered after main form success if checked */}
            <CreateIntelReportModal
                isOpen={showIntelModal}
                onClose={handleIntelClose}
                onSuccess={() => { }}
                initialData={{ targetId: request.client?.rsiHandle || request.unregisteredClientRsiHandle }}
            />
        </>
    );
};

export default CompleteRequestModal;
