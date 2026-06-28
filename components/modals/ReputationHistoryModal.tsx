
import React, { useState, useEffect } from 'react';
import { User, HydratedReputationHistoryEntry } from '../../types';
import { useData } from '../../contexts/DataContext';
import { useFormatDate } from '../../contexts/AuthContext';
import WindowFrame from '../layout/WindowFrame';

interface ReputationHistoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    user: User;
}

const ReputationHistoryModal: React.FC<ReputationHistoryModalProps> = ({ isOpen, onClose, user }) => {
    const { getReputationHistory } = useData();
    const fmt = useFormatDate();
    const [history, setHistory] = useState<HydratedReputationHistoryEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // Raise the loading flag synchronously during render whenever a fetch is
    // about to be (re)triggered, so the spinner shows before the async fetch
    // resolves. This mirrors the old in-effect setIsLoading(true) without a
    // synchronous set-state inside the effect. The async fetch below clears it.
    const fetchKey = isOpen ? `${user.id}` : null;
    const [prevFetchKey, setPrevFetchKey] = useState(fetchKey);
    if (fetchKey !== prevFetchKey) {
        setPrevFetchKey(fetchKey);
        if (fetchKey !== null) setIsLoading(true);
    }

    useEffect(() => {
        if (isOpen) {
            getReputationHistory(user.id)
                .then(setHistory)
                .catch(err => console.error("Failed to fetch reputation history:", err))
                .finally(() => setIsLoading(false));
        }
    }, [isOpen, user.id, getReputationHistory]);

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Reputation History"
            subtitle={user.name}
            icon="fa-solid fa-scale-balanced"
            color="indigo"
            width="max-w-2xl"
        >
            <div className="flex flex-col h-full bg-slate-900/50">
                <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar flex-1">
                    {isLoading ? (
                        <div className="text-center text-slate-400 py-10 flex flex-col items-center">
                            <i className="fa-solid fa-spinner animate-spin text-2xl text-indigo-500 mb-2"></i>
                            <span className="text-xs uppercase tracking-widest">Loading Record...</span>
                        </div>
                    ) : history.length === 0 ? (
                        <div className="text-center text-slate-500 py-10 italic">No reputation history found for this user.</div>
                    ) : (
                        <div className="space-y-4">
                            {history.map(entry => (
                                <div key={entry.id} className="bg-slate-900 p-4 rounded-lg border border-slate-800 hover:border-indigo-500/30 transition-all">
                                    <div className="flex justify-between items-start">
                                        <div className="flex items-center space-x-3">
                                            <div className="relative">
                                                <img src={entry.adminUser.avatarUrl} alt={entry.adminUser.name} className="h-8 w-8 rounded-full border border-slate-700" />
                                                <div className="absolute -bottom-1 -right-1 bg-slate-800 rounded-full p-0.5 border border-slate-700">
                                                    <i className="fa-solid fa-gavel text-[8px] text-indigo-400 block w-3 h-3 text-center leading-3"></i>
                                                </div>
                                            </div>
                                            <div>
                                                <p className="font-bold text-white text-sm">{entry.adminUser.name}</p>
                                                <p className="text-[10px] text-slate-500 uppercase tracking-widest">{fmt(entry.changeDate)}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1.5 rounded-sm border border-slate-800">
                                                <span className="text-slate-500 font-mono text-xs">{entry.oldReputation}</span>
                                                <i className="fa-solid fa-arrow-right-long text-slate-600 text-[10px]"></i>
                                                <span className={`font-mono font-bold text-sm ${entry.newReputation > entry.oldReputation ? 'text-green-400' : 'text-red-400'}`}>
                                                    {entry.newReputation}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    {entry.reason && (
                                        <div className="mt-3 pt-3 border-t border-slate-800/50">
                                            <p className="text-xs text-slate-300 italic">"{entry.reason}"</p>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex justify-end p-4 bg-slate-900/80 border-t border-white/5 rounded-b-xl backdrop-blur-sm">
                    <button type="button" onClick={onClose} className="px-6 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">Close Record</button>
                </div>
            </div>
        </WindowFrame>
    );
};

export default ReputationHistoryModal;
