
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { User } from '../../types';
import WindowFrame from '../layout/WindowFrame';

interface SyncUsersModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const SyncUsersModal: React.FC<SyncUsersModalProps> = ({ isOpen, onClose }) => {
    const { rpcAction } = useData();
    const { allUsers } = useMembers();
    const [isRunning, setIsRunning] = useState(false);
    // Append-only log lines. Each carries a monotonically-increasing `id`
    // (minted at append time) so React has a stable, unique key without falling
    // back to the array index.
    const [logs, setLogs] = useState<{ id: number; text: string }[]>([]);
    const logIdRef = useRef(0);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [completedCount, setCompletedCount] = useState(0);

    // Snapshot of the users to sync, so realtime updates can't re-order/shift
    // the array mid-run and cause users to be skipped.
    const [snapshot, setSnapshot] = useState<User[]>([]);

    // Ref tracking whether a sync step is currently executing, to block rapid-fire effect triggers.
    const isProcessingRef = useRef(false);
    const logContainerRef = useRef<HTMLDivElement>(null);

    // If running, iterate over the stable snapshot. Otherwise, show live data count.
    const usersToSync = isRunning ? snapshot : allUsers;

    // Reset the sync run state each time the modal transitions to open, using
    // the React "adjust state during render" pattern (a previous-value tracker)
    // instead of an effect. This runs during render — React re-renders before
    // paint, so it is behaviour-equivalent to the old on-open reset effect, with
    // no synchronous setState in an effect body.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (isOpen) {
            setLogs([]);
            setCurrentIndex(0);
            setCompletedCount(0);
            setIsRunning(false);
            setSnapshot([]); // Clear snapshot on open
        }
    }

    // The processing flag is a ref (not render state), so its on-open reset stays
    // in an effect — refs may only be mutated outside render. Mirrors the
    // render-time state reset above and fires on the same open transition.
    useEffect(() => {
        if (isOpen) {
            isProcessingRef.current = false;
        }
    }, [isOpen]);

    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [logs]);

    const addLog = useCallback((message: string) => {
        const timestamp = new Date().toLocaleTimeString();
        const id = logIdRef.current++;
        setLogs(prev => [...prev, { id, text: `[${timestamp}] ${message}` }]);
    }, []);

    const processNextUser = useCallback(async () => {
        if (currentIndex >= usersToSync.length) {
            setIsRunning(false);
            addLog("--- SYNC COMPLETE ---");
            return;
        }

        const user = usersToSync[currentIndex];
        isProcessingRef.current = true;

        try {
            const result = await rpcAction('admin:sync_user_roles', { targetUserId: user.id });
            addLog(`[${currentIndex + 1}/${usersToSync.length}] ${user.name}: ${result}`);

        } catch (error: any) {
            addLog(`[${currentIndex + 1}/${usersToSync.length}] ${user.name}: FAILED - ${error.message || 'Unknown error'}`);
        }

        setCompletedCount(prev => prev + 1);

        // Wait 1.5 seconds before next request to respect rate limits
        setTimeout(() => {
            setCurrentIndex(prev => prev + 1);
            isProcessingRef.current = false;
        }, 1500);
    }, [currentIndex, usersToSync, rpcAction, addLog]);

    useEffect(() => {
        if (isRunning && !isProcessingRef.current) {
            processNextUser();
        }
    }, [isRunning, processNextUser]);

    const handleStart = () => {
        // Freeze the user list so live updates don't shift indices
        setSnapshot([...allUsers]);
        setIsRunning(true);
        addLog(`Starting sync for ${allUsers.length} users...`);
    };

    const progress = usersToSync.length > 0 ? (completedCount / usersToSync.length) * 100 : 0;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Sync User Database"
            subtitle="Identity & Role Propagation"
            icon="fa-solid fa-rotate"
            color="sky"
            width="max-w-2xl"
        >
            <div className="flex flex-col h-full bg-slate-900/50">
                <div className="p-6 space-y-4 flex-1 overflow-hidden flex flex-col">
                    <p className="text-slate-300 text-sm">
                        This process will iterate through all {usersToSync.length} users in the database, updating their <strong className="text-white">Display Name</strong>, <strong className="text-white">Avatar</strong>, and syncing their <strong className="text-white">Rank</strong> based on current Discord status.
                    </p>

                    <div className="w-full bg-slate-950 rounded-full h-4 overflow-hidden border border-slate-700">
                        <div
                            className="bg-sky-500 h-full transition-all duration-300 ease-out shadow-[0_0_10px_rgba(14,165,233,0.5)]"
                            style={{ width: `${progress}%` }}
                        ></div>
                    </div>
                    <p className="text-xs text-right text-slate-400 font-mono">
                        {completedCount} / {usersToSync.length} Users Processed
                    </p>

                    <div
                        ref={logContainerRef}
                        className="h-80 bg-slate-950/80 border border-slate-800 rounded-lg p-4 overflow-y-auto font-mono text-xs space-y-1 shadow-inner custom-scrollbar"
                    >
                        {logs.length === 0 ? (
                            <span className="text-slate-600 italic">Ready to start. Click 'Start Sync' to begin.</span>
                        ) : (
                            logs.map((log) => (
                                <div key={log.id} className="text-emerald-400 border-b border-white/5 pb-0.5 mb-0.5 last:border-0 wrap-break-word">
                                    {log.text}
                                </div>
                            ))
                        )}
                        {isRunning && (
                            <div className="text-sky-400 animate-pulse">_ Updating identity & roles...</div>
                        )}
                    </div>
                </div>

                <div className="flex justify-end p-4 bg-slate-900/80 border-t border-white/5 rounded-b-xl backdrop-blur-sm">
                    {!isRunning ? (
                        <>
                            <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors mr-3">
                                {completedCount > 0 ? 'Close' : 'Cancel'}
                            </button>
                            <button
                                type="button"
                                onClick={handleStart}
                                disabled={usersToSync.length === 0}
                                className="px-6 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Start Sync
                            </button>
                        </>
                    ) : (
                        <button className="px-6 py-2 bg-slate-800 text-slate-400 rounded-lg text-xs font-bold uppercase tracking-wider cursor-wait flex items-center gap-2" disabled>
                            <i className="fa-solid fa-spinner animate-spin"></i>
                            Syncing...
                        </button>
                    )}
                </div>
            </div>
        </WindowFrame>
    );
};

export default SyncUsersModal;
