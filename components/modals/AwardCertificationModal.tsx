import React, { useState, useMemo } from 'react';
import { Certification } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface AwardCertificationModalProps {
    isOpen: boolean;
    onClose: () => void;
    certification: Certification;
}

const AwardCertificationModal: React.FC<AwardCertificationModalProps> = ({ isOpen, onClose, certification }) => {
    const { members, awardCertification } = useMembers();
    const { addToast } = useNotification();
    const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(() => new Set());
    const [isLoading, setIsLoading] = useState(false);

    const membersWithoutCert = useMemo(() => {
        return members.filter(member => !member.certifications?.some(c => c.id === certification.id));
    }, [members, certification.id]);


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
        if (selectedUserIds.size === 0) return;
        setIsLoading(true);
        try {
            const awardPromises = Array.from(selectedUserIds).map(userId =>
                awardCertification(userId, certification.id)
            );
            await Promise.all(awardPromises);
            onClose();
        } catch (err) {
            console.error("Failed to bulk award certifications:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while awarding certifications. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={`Award: ${certification.name}`}
            subtitle="Certification"
            icon="fa-solid fa-certificate"
            color="green"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                {/* Body */}
                <div className="p-4 flex-1 overflow-hidden flex flex-col">
                    <p className="text-xs text-slate-400 mb-3 bg-slate-900/50 p-2 rounded-sm border border-slate-800">
                        Select members to award this certification to. Members who already have this certification are not listed.
                    </p>
                    <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                        {membersWithoutCert.map(member => {
                            const isChecked = selectedUserIds.has(member.id);
                            return (
                                <label key={member.id} className={`flex items-center p-3 rounded-lg transition-colors cursor-pointer border ${isChecked ? 'bg-green-500/10 border-green-500/30' : 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'}`}>
                                    <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => handleToggleUser(member.id)}
                                        className="hidden"
                                    />
                                    <div className={`w-4 h-4 rounded-sm border flex items-center justify-center mr-3 ${isChecked ? 'bg-green-500 border-green-500' : 'border-slate-500'}`}>
                                        {isChecked && <i className="fa-solid fa-check text-[10px] text-white"></i>}
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
                        {membersWithoutCert.length === 0 && (
                            <div className="text-center py-8 border-2 border-dashed border-slate-800 rounded-xl">
                                <i className="fa-solid fa-check-double text-3xl text-slate-700 mb-3"></i>
                                <p className="text-slate-500 text-xs italic">All members have currently been awarded this certification.</p>
                            </div>
                        )}
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
                            className="px-6 py-2 bg-green-600/10 text-green-400 border border-green-600/30 hover:bg-green-600/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                            disabled={isLoading || selectedUserIds.size === 0}
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : `Award Selected`}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

export default AwardCertificationModal;