
import React, { useState, useCallback } from 'react';
import { Rank } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface RankModalProps {
    isOpen: boolean;
    onClose: () => void;
    rank?: Rank;
}

const RankModal: React.FC<RankModalProps> = ({ isOpen, onClose, rank }) => {
    const { addRank, updateRank } = useMembers();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [iconUrl, setIconUrl] = useState('');
    const [sortOrder, setSortOrder] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!rank;

    // Reset/seed the user-editable form fields when the dialog opens or the
    // selected rank changes while open. Done during render via the React
    // "adjust state during render" pattern (re-renders before paint), which is
    // behaviour-equivalent to the previous open/selection-change reset effect.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevRank, setPrevRank] = useState(rank);
    if (isOpen && (isOpen !== prevIsOpen || rank !== prevRank)) {
        setPrevIsOpen(isOpen);
        setPrevRank(rank);
        if (rank) {
            setName(rank.name);
            setIconUrl(rank.iconUrl);
            setSortOrder(rank.sortOrder || 0);
        } else {
            setName('');
            setIconUrl('');
            setSortOrder(0);
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || rank !== prevRank) {
        setPrevIsOpen(isOpen);
        setPrevRank(rank);
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const rankData = {
            name: name.trim(),
            iconUrl: iconUrl.trim(),
            sortOrder
        };

        try {
            if (isEditing && rank) {
                await updateRank({ ...rank, ...rankData });
            } else {
                await addRank(rankData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save rank:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the rank. Please try again." });
            setIsLoading(false);
        }
    }, [name, iconUrl, sortOrder, isEditing, rank, addRank, updateRank, onClose, addToast]);

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Rank' : 'Create Rank'}
            subtitle="Hierarchy Configuration"
            icon="fa-solid fa-chevron-up"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6">
                    <div>
                        <label htmlFor="rankName" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Rank Name</label>
                        <input
                            type="text"
                            id="rankName"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Senior Officer"
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label htmlFor="iconUrl" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Icon URL</label>
                        <div className="flex gap-4 items-center">
                            <input
                                type="text"
                                id="iconUrl"
                                value={iconUrl}
                                onChange={(e) => setIconUrl(e.target.value)}
                                placeholder="https://example.com/icon.png"
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                                disabled={isLoading}
                            />
                            {iconUrl && (
                                <div className="w-10 h-10 shrink-0 bg-slate-800 rounded-sm border border-slate-700 flex items-center justify-center">
                                    <img src={iconUrl} alt="Rank" className="w-6 h-6 object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} />
                                </div>
                            )}
                        </div>
                    </div>
                    <div>
                        <label htmlFor="sortOrder" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Precedence (Sort Order)</label>
                        <input
                            type="number"
                            id="sortOrder"
                            value={sortOrder}
                            onChange={(e) => setSortOrder(parseInt(e.target.value))}
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                            disabled={isLoading}
                            placeholder="0"
                        />
                        <p className="text-[10px] text-slate-500 mt-1">Lower numbers appear higher in the chain of command.</p>
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
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Rank')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default RankModal;
