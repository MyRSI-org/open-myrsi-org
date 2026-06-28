
import React, { useState, useMemo } from 'react';
import { HydratedOperation } from '../../types';
import { useOperations } from '../../contexts/OperationsContext';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface AddParticipantModalProps {
    isOpen: boolean;
    onClose: () => void;
    operation: HydratedOperation;
}

const AddParticipantModal: React.FC<AddParticipantModalProps> = ({ isOpen, onClose, operation }) => {
    const { refreshOperations } = useData();
    const { members } = useMembers();
    const { addOperationParticipant } = useOperations();
    const { addToast } = useNotification();
    const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(() => new Set());
    const [isLoading, setIsLoading] = useState(false);

    const availableMembers = useMemo(() => {
        const excludedIds = new Set(operation.participants.filter(p => p.timeLeft === null).map(p => p.userId));
        if (operation.ownerId) excludedIds.add(operation.ownerId);
        return members.filter(member => !excludedIds.has(member.id));
    }, [members, operation.participants, operation.ownerId]);

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
            // Add participants sequentially to avoid race conditions
            for (const userId of selectedUserIds) {
                await addOperationParticipant(operation.id, userId);
            }
            // Ensure a clean final refresh with all participants included
            await refreshOperations();
            onClose();
        } catch (err) {
            console.error("Failed to add participants:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while adding participants. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Add Personnel"
            subtitle={operation.name}
            icon="fa-solid fa-user-plus"
            color="purple"
            width="max-w-md"
        >
            <div className="flex flex-col h-full">
                <div className="p-4">
                    <p className="text-xs text-slate-400 mb-3 bg-slate-900/50 p-2 rounded-sm border border-slate-800">
                        Select members to add to this operation. Only members not already active are listed.
                    </p>
                    <div className="max-h-[50vh] overflow-y-auto custom-scrollbar space-y-2 pr-1">
                        {availableMembers.map(member => {
                            const isChecked = selectedUserIds.has(member.id);
                            return (
                                <label key={member.id} className={`flex items-center p-3 rounded-lg transition-colors cursor-pointer border ${isChecked ? 'bg-purple-500/10 border-purple-500/30' : 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'}`}>
                                    <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => handleToggleUser(member.id)}
                                        className="hidden"
                                    />
                                    <div className={`w-4 h-4 rounded-sm border flex items-center justify-center mr-3 ${isChecked ? 'bg-purple-500 border-purple-500' : 'border-slate-500'}`}>
                                        {isChecked && <i className="fa-solid fa-check text-[10px] text-white"></i>}
                                    </div>
                                    <img src={member.avatarUrl} alt={member.name} className="h-8 w-8 rounded-full mr-3" />
                                    <div className="flex-1">
                                        <p className="font-bold text-sm text-white">{member.name}</p>
                                        <p className="text-[10px] text-slate-400 uppercase">{member.rank?.name}</p>
                                    </div>
                                </label>
                            )
                        })}
                        {availableMembers.length === 0 && (
                            <p className="text-center text-slate-500 text-xs italic py-8">No available members found.</p>
                        )}
                    </div>
                </div>
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-between items-center rounded-b-xl">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        {selectedUserIds.size} Selected
                    </p>
                    <div className="flex gap-3">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                        <button
                            type="button"
                            onClick={handleSave}
                            className="flex items-center gap-2 px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white border border-purple-500/40 shadow-lg shadow-purple-900/30 rounded-lg text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50"
                            disabled={isLoading || selectedUserIds.size === 0}
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Add Selected'}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

export default AddParticipantModal;
