
import React, { useState, useCallback } from 'react';
import { SpecializationTag } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import AwardIconInput from '../common/AwardIconInput';
import { useNotification } from '../../contexts/NotificationContext';

interface SpecializationModalProps {
    isOpen: boolean;
    onClose: () => void;
    tag?: SpecializationTag;
}

const SpecializationModal: React.FC<SpecializationModalProps> = ({ isOpen, onClose, tag }) => {
    const { addSpecializationTag, updateSpecializationTag } = useMembers();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [iconMode, setIconMode] = useState<'fa' | 'url'>('fa');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!tag;

    // Seed/reset the editable form when the modal opens or the edited tag
    // changes while open. Adjusts state during render (React's documented
    // pattern) instead of in an effect; the controlled fields must stay
    // user-editable so they cannot be derived during render.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevTag, setPrevTag] = useState(tag);
    if (isOpen !== prevIsOpen || tag !== prevTag) {
        setPrevIsOpen(isOpen);
        setPrevTag(tag);
        if (isOpen) {
            if (tag) {
                setName(tag.name);
                setDescription(tag.description || '');
                setIcon(tag.icon || '');
                setImageUrl(tag.imageUrl || '');
                setIconMode(tag.imageUrl ? 'url' : 'fa');
            } else {
                setName('');
                setDescription('');
                setIcon('');
                setImageUrl('');
                setIconMode('fa');
            }
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const tagData = {
            name: name.trim(),
            description: description.trim() || null,
            icon: iconMode === 'fa' ? (icon.trim() || null) : null,
            imageUrl: iconMode === 'url' ? (imageUrl.trim() || null) : null,
        };

        try {
            if (isEditing && tag) {
                await updateSpecializationTag({ ...tag, ...tagData });
            } else {
                await addSpecializationTag(tagData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save specialization tag:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the tag. Please try again." });
            setIsLoading(false);
        }
    }, [name, description, icon, imageUrl, iconMode, isEditing, tag, addSpecializationTag, updateSpecializationTag, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Tag' : 'Create Tag'}
            subtitle="Specialization"
            icon="fa-solid fa-tags"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label className={labelClass}>Tag Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Combat Pilot"
                            className={inputClass}
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Icon (Optional)</label>
                        <AwardIconInput
                            icon={icon}
                            onIconChange={setIcon}
                            imageUrl={imageUrl}
                            onImageUrlChange={setImageUrl}
                            mode={iconMode}
                            onModeChange={setIconMode}
                            fallbackIcon="fa-solid fa-tag"
                            accentClass="text-sky-400"
                            disabled={isLoading}
                            iconPlaceholder="e.g., fa-solid fa-crosshairs"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Description (Optional)</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            placeholder="e.g., Certified for advanced combat flight maneuvers."
                            className={`${inputClass} resize-none`}
                            disabled={isLoading}
                        />
                    </div>
                </div>

                <div className="flex justify-end items-center p-6 bg-slate-900/50 border-t border-white/5 rounded-b-2xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Tag')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default SpecializationModal;
