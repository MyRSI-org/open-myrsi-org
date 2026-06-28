
import React, { useState, useEffect } from 'react';
import { User, RatingHistoryEntry } from '../../types';
import { useData } from '../../contexts/DataContext';
import { useFormatDate } from '../../contexts/AuthContext';
import WindowFrame from '../layout/WindowFrame';

interface RatingHistoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    user: User;
}

const StarRatingDisplay: React.FC<{ rating: number }> = ({ rating }) => (
    <div className="flex items-center space-x-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
            <i
                key={star}
                className={`fa-solid fa-star ${rating >= star ? 'text-amber-400' : 'text-slate-600'}`}
            />
        ))}
    </div>
);

const RatingHistoryModal: React.FC<RatingHistoryModalProps> = ({ isOpen, onClose, user }) => {
    const { getRatingHistory } = useData();
    const fmt = useFormatDate();
    const [history, setHistory] = useState<RatingHistoryEntry[]>([]);
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
            getRatingHistory(user.id)
                .then(setHistory)
                .catch(err => console.error("Failed to fetch rating history:", err))
                .finally(() => setIsLoading(false));
        }
    }, [isOpen, user.id, getRatingHistory]);

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={`Client Rating History`}
            subtitle={user.name}
            icon="fa-solid fa-star-half-stroke"
            color="amber"
            width="max-w-3xl"
        >
            <div className="flex flex-col h-full bg-slate-900/50">
                <div className="p-10 text-center border-b border-white/5 bg-slate-900/50">
                    <div className="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto mb-3 border border-amber-500/20">
                        <i className="fa-solid fa-chart-line text-2xl text-amber-500"></i>
                    </div>
                    <div className="text-3xl font-black text-white">{history.length}</div>
                    <div className="text-xs text-slate-500 uppercase tracking-widest font-bold">Total Reviews</div>
                </div>

                <div className="p-0 overflow-y-auto custom-scrollbar flex-1 max-h-[60vh]">
                    {isLoading ? (
                        <div className="text-center text-slate-400 p-12 flex flex-col items-center gap-3">
                            <i className="fa-solid fa-spinner animate-spin text-2xl text-amber-500"></i>
                            <span className="text-xs uppercase tracking-widest">Retrieving Records...</span>
                        </div>
                    ) : history.length === 0 ? (
                        <div className="text-center text-slate-500 p-12 italic">No rated missions found for this member.</div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead className="sticky top-0 bg-slate-900 z-10 shadow-xs">
                                <tr className="border-b border-slate-800">
                                    <th className="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest bg-slate-900">Date</th>
                                    <th className="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest bg-slate-900">Service Request</th>
                                    <th className="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest bg-slate-900">Client</th>
                                    <th className="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest bg-slate-900 text-right">Rating</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                                {history.map(entry => (
                                    <tr key={entry.requestId} className="hover:bg-amber-500/5 transition-colors group">
                                        <td className="p-4 text-xs font-mono text-slate-400">{fmt(entry.date)}</td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-2">
                                                <span className="font-mono text-xs text-sky-500 bg-sky-900/20 px-1.5 rounded-sm border border-sky-500/20">{entry.requestId.split('-')[0].toUpperCase()}</span>
                                                <span className="text-xs font-bold text-slate-300">{entry.serviceType}</span>
                                            </div>
                                        </td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[10px]">
                                                    <i className="fa-solid fa-user"></i>
                                                </div>
                                                <span className="text-sm font-bold text-slate-300">{entry.clientRsiHandle}</span>
                                            </div>
                                        </td>
                                        <td className="p-4 text-right">
                                            <div className="flex justify-end">
                                                <StarRatingDisplay rating={entry.rating} />
                                            </div>
                                            {entry.feedback && (
                                                <div className="mt-2 text-xs text-slate-400 italic text-right max-w-xs ml-auto">
                                                    "{entry.feedback}"
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
                <div className="flex justify-end p-4 bg-slate-900/80 border-t border-white/5 rounded-b-xl backdrop-blur-sm">
                    <button type="button" onClick={onClose} className="px-6 py-2 text-xs font-bold uppercase text-slate-300 bg-slate-800 hover:bg-slate-700 hover:text-white rounded-lg transition-colors border border-slate-700">Close Record</button>
                </div>
            </div>
        </WindowFrame>
    );
};

export default RatingHistoryModal;
