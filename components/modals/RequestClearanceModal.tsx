
import React, { useState, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface RequestClearanceModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const RequestClearanceModal: React.FC<RequestClearanceModalProps> = ({ isOpen, onClose }) => {
    const { currentUser } = useAuth();
    const { rpcAction, refreshHR } = useData();
    const { securityClearances, limitingMarkers } = useMembers();
    const { addToast } = useNotification();

    const [targetLevelId, setTargetLevelId] = useState<string>('');
    const [requestedMarkers, setRequestedMarkers] = useState<Set<number>>(() => new Set());
    const [justification, setJustification] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    // Filter available levels (only higher than current)
    const availableLevels = useMemo(() => {
        if (!securityClearances) return [];
        const currentLevel = currentUser?.clearanceLevel?.level || 0;
        return securityClearances.filter(c => c.level > currentLevel);
    }, [securityClearances, currentUser]);

    // Filter available markers (only those not already held)
    const availableMarkers = useMemo(() => {
        if (!limitingMarkers) return [];
        const heldMarkerIds = new Set(currentUser?.limitingMarkers?.map(m => m.id) || []);
        return limitingMarkers.filter(m => !heldMarkerIds.has(m.id));
    }, [limitingMarkers, currentUser]);

    const handleToggleMarker = (id: number) => {
        setRequestedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);

        try {
            const parts: string[] = [];

            if (targetLevelId) {
                const targetLevel = securityClearances.find(c => c.id === parseInt(targetLevelId));
                if (targetLevel) {
                    parts.push(`REQUESTED LEVEL: Level ${targetLevel.level} (${targetLevel.name})`);
                }
            }

            if (requestedMarkers.size > 0) {
                const markerCodes = limitingMarkers
                    .filter(m => requestedMarkers.has(m.id))
                    .map(m => m.code)
                    .join(', ');
                parts.push(`REQUESTED MARKERS: ${markerCodes}`);
            }

            const notesPayload = `${parts.join('\n')}\n\nJUSTIFICATION: ${justification}`;
            const referralSource = "SECURITY_VETTING";

            await rpcAction('user:submit_application', {
                name: currentUser?.name,
                rsiHandle: currentUser?.rsiHandle,
                referral: referralSource,
                notes: notesPayload,
                userId: currentUser?.id,
                assignedRecruiterId: null // Explicitly unassigned so it goes to the pool
            });

            // UX Optimization: Close immediately, refresh in background
            onClose();
            addToast("Clearance Request Submitted", <i className="fa-solid fa-lock"></i>, "bg-sky-500/10 text-sky-400 border-sky-500/50", { description: "Your security clearance request has been filed for review." });
            refreshHR();

        } catch (err: any) {
            console.error("Failed to submit request:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: err.message || "An error occurred while submitting your request." });
            setIsLoading(false);
        }
    }, [targetLevelId, requestedMarkers, justification, currentUser, rpcAction, refreshHR, onClose, securityClearances, limitingMarkers, addToast]);

    const hasSelection = targetLevelId !== '' || requestedMarkers.size > 0;
    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Request Security Clearance"
            subtitle="Access Control Protocol"
            icon="fa-solid fa-user-shield"
            color="emerald"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    <p className="text-xs text-slate-400 leading-relaxed">
                        Select the Clearance Level upgrade and/or specific Compartmented Access markers you require.
                    </p>

                    <div className="space-y-4 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                        <div>
                            <label className={labelClass}>Target Clearance Level (Optional)</label>
                            <select
                                value={targetLevelId}
                                onChange={(e) => setTargetLevelId(e.target.value)}
                                className={inputClass}
                                disabled={isLoading}
                            >
                                <option value="">- No Change -</option>
                                {availableLevels.length > 0 ? availableLevels.map(lvl => (
                                    <option key={lvl.id} value={lvl.id}>Level {lvl.level} - {lvl.name}</option>
                                )) : (
                                    <option value="" disabled>No higher levels available</option>
                                )}
                            </select>
                        </div>

                        <div>
                            <label className={labelClass}>Compartment Markers (Optional)</label>
                            <div className="space-y-2 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                                {availableMarkers.length > 0 ? availableMarkers.map(m => (
                                    <label key={m.id} className="flex items-center space-x-3 cursor-pointer group bg-slate-900/50 p-2 rounded-lg border border-transparent hover:border-slate-700 transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={requestedMarkers.has(m.id)}
                                            onChange={() => handleToggleMarker(m.id)}
                                            className="h-4 w-4 rounded-sm bg-slate-800 border-slate-600 text-emerald-500 focus:ring-emerald-500"
                                        />
                                        <div>
                                            <span className="text-xs font-bold text-slate-200 group-hover:text-white transition-colors">{m.code}</span>
                                            <span className="text-[10px] text-slate-500 ml-2">- {m.name}</span>
                                        </div>
                                    </label>
                                )) : (
                                    <p className="text-xs text-slate-500 italic">No additional markers available.</p>
                                )}
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Justification / Need to Know</label>
                        <textarea
                            value={justification}
                            onChange={(e) => setJustification(e.target.value)}
                            rows={4}
                            className={`${inputClass} resize-none`}
                            placeholder="Explain why you require this access..."
                            required
                            disabled={isLoading}
                        />
                    </div>

                    <div className="bg-emerald-500/5 p-3 rounded-lg border border-emerald-500/30 text-[10px] text-emerald-300">
                        <i className="fa-solid fa-circle-info mr-2"></i>
                        Submitting this request will open a formal vetting file. You may be contacted for an interview.
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition disabled:opacity-50"
                        disabled={isLoading || !hasSelection}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-paper-plane"></i> Submit Application</>}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default RequestClearanceModal;
