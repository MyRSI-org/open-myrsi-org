
import React, { useState, useCallback } from 'react';
import { Commendation } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import AwardIconInput from '../common/AwardIconInput';
import { useNotification } from '../../contexts/NotificationContext';

interface CommendationModalProps {
    isOpen: boolean;
    onClose: () => void;
    commendation?: Commendation;
}

const CommendationModal: React.FC<CommendationModalProps> = ({ isOpen, onClose, commendation }) => {
    const { addCommendation, updateCommendation } = useMembers();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [iconMode, setIconMode] = useState<'fa' | 'url'>('fa');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!commendation;

    // Seed/reset the editable form fields when the modal opens or the
    // commendation being edited changes. Done during render via the React
    // "adjust state during render" pattern (re-renders before paint), which is
    // behaviour-equivalent to the previous open/selection-change reset effect.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevCommendation, setPrevCommendation] = useState(commendation);
    if (isOpen && (isOpen !== prevIsOpen || commendation !== prevCommendation)) {
        setPrevIsOpen(isOpen);
        setPrevCommendation(commendation);
        if (commendation) {
            setName(commendation.name);
            setDescription(commendation.description || '');
            setIcon(commendation.icon || '');
            setImageUrl(commendation.imageUrl || '');
            setIconMode(commendation.imageUrl ? 'url' : 'fa');
        } else {
            setName('');
            setDescription('');
            setIcon('');
            setImageUrl('');
            setIconMode('fa');
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || commendation !== prevCommendation) {
        setPrevIsOpen(isOpen);
        setPrevCommendation(commendation);
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const commendData = {
            name: name.trim(),
            description: description.trim() || null,
            icon: iconMode === 'fa' ? (icon.trim() || null) : null,
            imageUrl: iconMode === 'url' ? (imageUrl.trim() || null) : null,
        };

        try {
            if (isEditing && commendation) {
                await updateCommendation({ ...commendation, ...commendData });
            } else {
                await addCommendation(commendData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save commendation:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the commendation. Please try again." });
            setIsLoading(false);
        }
    }, [name, description, icon, imageUrl, iconMode, isEditing, commendation, addCommendation, updateCommendation, onClose, addToast]);

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Commendation' : 'Create Commendation'}
            subtitle="Awards & Ribbons"
            icon="fa-solid fa-medal"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label htmlFor="commendName" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Commendation Name</label>
                        <input
                            type="text"
                            id="commendName"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Medal of Valor"
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Icon (Optional)</label>
                        <AwardIconInput
                            icon={icon}
                            onIconChange={setIcon}
                            imageUrl={imageUrl}
                            onImageUrlChange={setImageUrl}
                            mode={iconMode}
                            onModeChange={setIconMode}
                            fallbackIcon="fa-solid fa-medal"
                            accentClass="text-amber-500"
                            disabled={isLoading}
                            iconPlaceholder="e.g., fa-solid fa-medal"
                        />
                    </div>
                    <div>
                        <label htmlFor="commendDescription" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description (Optional)</label>
                        <textarea
                            id="commendDescription"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            placeholder="e.g., Awarded for exceptional bravery in the face of overwhelming odds."
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all resize-none"
                            disabled={isLoading}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-end items-center p-6 bg-slate-900/50 border-t border-white/5 rounded-b-2xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Commendation')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CommendationModal;
