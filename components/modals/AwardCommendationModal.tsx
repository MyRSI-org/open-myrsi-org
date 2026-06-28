
import React, { useState } from 'react';
import { Commendation } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface AwardCommendationModalProps {
    isOpen: boolean;
    onClose: () => void;
    commendation: Commendation;
}

const AwardCommendationModal: React.FC<AwardCommendationModalProps> = ({ isOpen, onClose, commendation }) => {
    const { members, awardCommendation } = useMembers();
    const { addToast } = useNotification();
    const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(() => new Set());
    const [reason, setReason] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleToggleUser = (userId: number) => {
        setSelectedUserIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(userId)) {
                newSet.delete(userId);
            } else {
                newSet.add(userId);
            }
            return newSet;
        });
    };

    const handleSave = async () => {
        if (selectedUserIds.size === 0 || !reason.trim()) return;
        setIsLoading(true);
        try {
            const awardPromises = Array.from(selectedUserIds).map(userId =>
                awardCommendation(userId, commendation.id, reason.trim())
            );
            await Promise.all(awardPromises);
            onClose();
        } catch (err) {
            console.error("Failed to bulk award commendations:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while awarding commendations. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={`Award: ${commendation.name}`}
            subtitle="Commendation"
            icon="fa-solid fa-medal"
            color="amber"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                {/* Body */}
                <div className="p-4 flex-1 overflow-hidden flex flex-col space-y-4">
                    <div>
                        <label htmlFor="reason" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Reason for Award</label>
                        <textarea
                            id="reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            placeholder="e.g., For exceptional leadership during Operation Nightingale."
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-amber-500 focus:border-amber-500 outline-hidden transition-all resize-none"
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                        <p className="text-xs text-slate-400 mb-2">Select members to award this commendation to.</p>
                        {members.map(member => {
                            const isChecked = selectedUserIds.has(member.id);
                            return (
                                <label key={member.id} className={`flex items-center p-3 rounded-lg transition-colors cursor-pointer border ${isChecked ? 'bg-amber-500/10 border-amber-500/30' : 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'}`}>
                                    <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => handleToggleUser(member.id)}
                                        className="hidden"
                                    />
                                    <div className={`w-4 h-4 rounded-sm border flex items-center justify-center mr-3 ${isChecked ? 'bg-amber-500 border-amber-500' : 'border-slate-500'}`}>
                                        {isChecked && <i className="fa-solid fa-check text-[10px] text-black"></i>}
                                    </div>
                                    <div className="flex items-center space-x-3">
                                        <img src={member.avatarUrl} alt={member.name} className="h-8 w-8 rounded-full" />
                                        <div>
                                            <div className="font-bold text-sm text-white">{member.name}</div>
                                            <div className="text-[10px] text-slate-500 uppercase">{member.rank?.name || 'Member'}</div>
                                        </div>
                                    </div>
                                </label>
                            )
                        })}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-between items-center p-4 bg-slate-900/50 border-t border-white/5 rounded-b-xl shrink-0">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        {selectedUserIds.size} selected
                    </p>
                    <div className="flex gap-3">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                        <button
                            type="button"
                            onClick={handleSave}
                            className="px-6 py-2 bg-amber-600/10 text-amber-400 border border-amber-600/30 hover:bg-amber-600/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                            disabled={isLoading || selectedUserIds.size === 0 || !reason.trim()}
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : `Award Selected`}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

export default AwardCommendationModal;
