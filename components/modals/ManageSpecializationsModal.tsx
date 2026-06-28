
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import AwardIcon from '../common/AwardIcon';
import { useNotification } from '../../contexts/NotificationContext';

interface ManageSpecializationsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const ManageSpecializationsModal: React.FC<ManageSpecializationsModalProps> = ({ isOpen, onClose }) => {
    const { currentUser, updateUserSpecializations } = useAuth();
    const { specializationTags } = useMembers();
    const { addToast } = useNotification();
    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
    const [isLoading, setIsLoading] = useState(false);

    // Seed the editable selection from the user's saved specializations each
    // time the modal opens (or the saved set changes while open). Adjusting
    // state during render with previous-value trackers is the React-documented
    // equivalent of the old open-reset effect: it fires on the same
    // (isOpen, specializations) transitions and re-renders before paint.
    // prevIsOpen seeds to false so a mount with isOpen=true registers as an
    // open transition, matching the old effect which ran (and seeded) on mount.
    const savedSpecializations = currentUser?.specializations;
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevSavedSpecializations, setPrevSavedSpecializations] = useState(savedSpecializations);
    if (isOpen !== prevIsOpen || savedSpecializations !== prevSavedSpecializations) {
        setPrevIsOpen(isOpen);
        setPrevSavedSpecializations(savedSpecializations);
        if (isOpen && savedSpecializations) {
            setSelectedIds(new Set(savedSpecializations.map(s => s.id)));
        }
    }

    const handleToggle = (tagId: number) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(tagId)) {
                newSet.delete(tagId);
            } else {
                if (newSet.size < 4) {
                    newSet.add(tagId);
                }
            }
            return newSet;
        });
    };

    const handleSave = async () => {
        setIsLoading(true);
        try {
            await updateUserSpecializations(Array.from(selectedIds));
            onClose();
        } catch (err) {
            console.error("Failed to update specializations:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while updating specializations. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    const limitReached = selectedIds.size >= 4;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Manage My Specializations"
            subtitle="Skills & Competencies"
            icon="fa-solid fa-tags"
            color="sky"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-4 overflow-y-auto custom-scrollbar flex-1">
                    <div className="p-3 bg-slate-900/50 border border-slate-700/50 rounded-lg text-xs text-slate-400">
                        Select up to <strong>four</strong> specializations that best represent your primary skills.
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                        {specializationTags.length > 0 ? (
                            specializationTags.map(tag => {
                                const isChecked = selectedIds.has(tag.id);
                                const isDisabled = limitReached && !isChecked;

                                return (
                                    <label key={tag.id} className={`flex items-start p-3 rounded-lg border transition-all ${isDisabled ? 'cursor-not-allowed opacity-50 border-slate-800' : 'cursor-pointer hover:border-slate-600'} ${isChecked ? 'bg-sky-500/10 border-sky-500/30' : 'bg-slate-900/30 border-slate-800'}`}>
                                        <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={() => handleToggle(tag.id)}
                                            disabled={isDisabled}
                                            className="h-4 w-4 rounded-sm bg-slate-800 border-slate-600 text-sky-500 focus:ring-sky-500 mt-1"
                                        />
                                        <div className="ml-3">
                                            <div className="flex items-center gap-2">
                                                {(tag.icon || tag.imageUrl) && (
                                                    <AwardIcon imageUrl={tag.imageUrl} icon={tag.icon} fallbackIcon="fa-solid fa-tag" className="text-sky-400 text-xs w-3 h-3 inline-block" alt={tag.name} />
                                                )}
                                                <span className={`text-sm font-bold ${isChecked ? 'text-white' : 'text-slate-300'}`}>{tag.name}</span>
                                            </div>
                                            {tag.description && <p className="text-xs text-slate-500 mt-0.5">{tag.description}</p>}
                                        </div>
                                    </label>
                                );
                            })
                        ) : (
                            <p className="text-slate-500 text-center py-4 text-xs">No specializations configured.</p>
                        )}
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-between items-center rounded-b-xl">
                    <p className={`text-[10px] font-black uppercase tracking-widest ${limitReached ? 'text-amber-500' : 'text-slate-500'}`}>
                        {selectedIds.size} / 4 Selected
                    </p>
                    <div className="flex gap-3">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                        <button
                            type="button"
                            onClick={handleSave}
                            className="px-6 py-2 bg-sky-500/10 text-sky-400 border border-sky-500/50 hover:bg-sky-500/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                            disabled={isLoading}
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

export default ManageSpecializationsModal;
