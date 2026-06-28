import React, { useState, useRef, useEffect } from 'react';
import { HydratedOperation, OperationStatus } from '../../../../types';
import { useAuth, useFormatDate } from '../../../../contexts/AuthContext';
import { useOperations } from '../../../../contexts/OperationsContext';

interface OpCommsTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    isParticipant: boolean;
    onRefresh: () => void;
}

const OpCommsTab: React.FC<OpCommsTabProps> = ({ operation, canManage, isParticipant, onRefresh }) => {
    const { currentUser } = useAuth();
    const { addOperationTimelineEntry } = useOperations();
    const fmt = useFormatDate();
    const [timelineInput, setTimelineInput] = useState('');
    const [loadingAction, setLoadingAction] = useState(false);
    const timelineRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (timelineRef.current) {
            timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
        }
    }, [operation.log]);

    const handleTimelineSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!timelineInput.trim()) return;
        setLoadingAction(true);
        try {
            await addOperationTimelineEntry(operation.id, timelineInput.trim());
            setTimelineInput('');
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingAction(false);
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div ref={timelineRef} className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-6 space-y-4">
                {operation.log?.length > 0 ? operation.log.map((entry) => {
                    const isNote = entry.entryType === 'NOTE';
                    const isMine = entry.author?.id === currentUser?.id;

                    if (!isNote) {
                        // System event — centered, muted
                        return (
                            <div key={entry.id} className="flex justify-center">
                                <div className="bg-black/30 border border-slate-800 text-slate-500 text-[11px] italic px-4 py-1.5 rounded-full flex items-center gap-2">
                                    <i className={`fa-solid ${
                                        entry.entryType === 'JOIN' ? 'fa-right-to-bracket' :
                                        entry.entryType === 'LEAVE' ? 'fa-person-walking-arrow-right' :
                                        entry.entryType === 'STATUS_CHANGE' ? 'fa-shuffle' :
                                        entry.entryType === 'ADD_MEMBER' ? 'fa-user-plus' :
                                        entry.entryType === 'UEC_DEPOSIT' ? 'fa-coins' :
                                        'fa-circle-info'
                                    } text-[9px]`}></i>
                                    <span>{entry.logEntry}</span>
                                    <span className="text-slate-600 text-[9px] font-mono ml-2">
                                        {fmt.time(entry.createdAt)}
                                    </span>
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div key={entry.id} className={`flex gap-3 ${isMine ? 'justify-end' : ''}`}>
                            {!isMine && (
                                entry.author?.avatarUrl ?
                                    <img src={entry.author.avatarUrl} className="w-8 h-8 rounded-full shrink-0 border border-slate-600 self-end object-cover" /> :
                                    <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-600 shrink-0 self-end flex items-center justify-center"><i className="fa-solid fa-user text-slate-500 text-xs"></i></div>
                            )}
                            <div className={`max-w-[75%] rounded-2xl p-3 text-sm shadow-md ${
                                isMine ? 'bg-purple-600 text-white rounded-br-none' : 'bg-slate-700 text-slate-200 rounded-bl-none'
                            }`}>
                                <div className={`text-[10px] font-bold mb-1 opacity-70 flex justify-between gap-4 ${isMine ? 'text-purple-100' : 'text-slate-400'}`}>
                                    <span>{entry.author?.name || 'Unknown'}</span>
                                    <span>{fmt.time(entry.createdAt)}</span>
                                </div>
                                <p className="whitespace-pre-wrap leading-relaxed">{entry.logEntry}</p>
                            </div>
                        </div>
                    );
                }) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-50">
                        <i className="fa-solid fa-comment-slash text-4xl mb-4"></i>
                        <p className="text-sm font-medium italic">Secure channel established. Silence on comms.</p>
                    </div>
                )}
            </div>

            {(isParticipant || canManage) && operation.status !== OperationStatus.Concluded && (
                <form onSubmit={handleTimelineSubmit} className="p-4 bg-slate-900/80 border-t border-slate-700/50 flex gap-3 backdrop-blur-md shrink-0">
                    <input type="text" value={timelineInput} onChange={(e) => setTimelineInput(e.target.value)} placeholder="Add entry to mission log..."
                        className="flex-1 bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 focus:bg-slate-900/80 outline-hidden transition-all placeholder:text-slate-500" disabled={loadingAction} />
                    <button type="submit" disabled={!timelineInput.trim() || loadingAction}
                        className="bg-purple-600 hover:bg-purple-500 text-white w-12 rounded-xl flex items-center justify-center shadow-lg shadow-purple-900/30 transition-all active:scale-95 disabled:opacity-50 disabled:active:scale-100">
                        <i className="fa-solid fa-paper-plane text-sm"></i>
                    </button>
                </form>
            )}
        </div>
    );
};

export default OpCommsTab;
