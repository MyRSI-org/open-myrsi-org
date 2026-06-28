
import React, { useState, useCallback } from 'react';
import { PersonnelPosition } from '../../../types';
import { useData } from '../../../contexts/DataContext';

import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

interface CreatePositionModalProps {
    isOpen: boolean;
    onClose: () => void;
    position?: PersonnelPosition;
}

const CreatePositionModal: React.FC<CreatePositionModalProps> = ({ isOpen, onClose, position }) => {
    const { rpcAction, refreshHR } = useData();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!position;

    // Seed/reset the editable form when the modal opens or the edited position
    // changes. React-documented "adjust state during render" pattern
    // (previous-value tracker): behaviour-equivalent to the prior effect, which had
    // deps [isOpen, position] and ran the same if/else seed whenever isOpen was true
    // and either input changed.
    const [prevSeedKey, setPrevSeedKey] = useState({ isOpen: false, position });
    if (prevSeedKey.isOpen !== isOpen || prevSeedKey.position !== position) {
        setPrevSeedKey({ isOpen, position });
        if (isOpen) {
            if (position) {
                setName(position.name);
                setDescription(position.description || '');
                setIcon(position.icon || '');
            } else {
                setName('');
                setDescription('');
                setIcon('');
            }
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const data = {
            name: name.trim(),
            description: description.trim(),
            icon: icon.trim()
        };

        try {
            if (isEditing && position) {
                await rpcAction('hr:update_position', { ...data, id: position.id });
            } else {
                await rpcAction('hr:create_position', data);
            }
            await refreshHR();
            onClose();
        } catch (err) {
            console.error("Failed to save position:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred. Please try again." });
        } finally {
            setIsLoading(false);
        }
    }, [name, description, icon, isEditing, position, rpcAction, refreshHR, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Job Role' : 'Create Job Role'}
            subtitle="Position Management"
            icon="fa-solid fa-id-badge"
            color="emerald"
            width="max-w-md"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-6">
                    <div className="bg-emerald-500/5 border border-emerald-500/30 p-4 rounded-xl text-xs text-emerald-200 mb-2">
                        <i className="fa-solid fa-circle-info mr-2"></i>
                        Job Roles (Positions) define specific titles and functions (e.g. "Medical Officer", "Fighter Pilot") that can be assigned to members regardless of their Unit or Rank.
                    </div>

                    <div>
                        <label className={labelClass}>Role Title</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={inputClass}
                            required
                            disabled={isLoading}
                            placeholder="e.g. Senior Pilot"
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Icon (Optional)</label>
                        <div className="flex gap-4 items-center">
                            <input
                                type="text"
                                value={icon}
                                onChange={(e) => setIcon(e.target.value)}
                                className={`${inputClass} font-mono`}
                                disabled={isLoading}
                                placeholder="e.g. fa-solid fa-user-astronaut"
                            />
                            <div className="w-10 h-10 shrink-0 bg-slate-900/60 rounded-lg border border-slate-700 flex items-center justify-center text-emerald-300">
                                <i className={`${icon || 'fa-solid fa-user-tag'} text-lg`}></i>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            className={`${inputClass} resize-none`}
                            disabled={isLoading}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className={`fa-solid ${isEditing ? 'fa-check' : 'fa-plus'}`}></i> {isEditing ? 'Save Changes' : 'Create Role'}</>}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CreatePositionModal;
