
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';

import { ApiKey } from '../../../types';
import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

interface ProgressLine {
    // Stable client-only id minted when the line is appended. Used solely as the
    // React list key for this append-only log; it is never sent to the server.
    id: string;
    message: string;
    type: 'info' | 'success' | 'error' | 'warning';
}

const IntelligenceManagementTab: React.FC = () => {
    const { rpcAction } = useData();
    const { securityClearances } = useMembers();
    const { currentUser } = useAuth();
    const fmt = useFormatDate();
    const { confirm } = useNotification();

    // Operation modal state
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [modalTitle, setModalTitle] = useState('');
    const [modalIcon, setModalIcon] = useState('');
    const [progressLines, setProgressLines] = useState<ProgressLine[]>([]);
    const [isOperationRunning, setIsOperationRunning] = useState(false);
    const progressEndRef = useRef<HTMLDivElement>(null);

    // Loading states for individual buttons
    const [isSyncingWarrants, setIsSyncingWarrants] = useState(false);
    const [isSyncingFeeds, setIsSyncingFeeds] = useState(false);
    const [isCleaning, setIsCleaning] = useState(false);
    const [isCleaningIntel, setIsCleaningIntel] = useState(false);

    // API & Feed States
    const [keys, setKeys] = useState<ApiKey[]>([]);
    // Initialised true: the mount-time fetch below is always in flight on first
    // render, so the loading flag starts raised rather than being set synchronously
    // inside the effect. The async fetch lowers it in its finally.
    const [isLoadingKeys, setIsLoadingKeys] = useState(true);

    const [newKeyLabel, setNewKeyLabel] = useState('');
    const [justCreatedKey, setJustCreatedKey] = useState<{ label: string, key: string } | null>(null);

    // Intel Sharing Config
    const [maxShareableClearance, setMaxShareableClearance] = useState(0);
    const [isSavingShareConfig, setIsSavingShareConfig] = useState(false);

    // Loads the API keys list + intel-sharing config. Does NOT raise the loading
    // flag itself: on mount the flag is already initialised true, and the
    // event-handler callers below raise it explicitly before invoking a refresh.
    // Keeping the synchronous set out of here means the mount effect performs no
    // synchronous setState. Memoised on rpcAction (a stable useCallback from
    // context) so its identity is stable and the mount effect runs exactly once.
    const fetchData = useCallback(async () => {
        try {
            const [keysData, sharingConfig] = await Promise.all([
                rpcAction('api:list_keys', {}),
                rpcAction('admin:get_intel_sharing_config', {})
            ]);
            setKeys(keysData);
            if (sharingConfig?.maxShareableClearance !== undefined) {
                setMaxShareableClearance(sharingConfig.maxShareableClearance);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoadingKeys(false);
        }
    }, [rpcAction]);

    useEffect(() => {
        // Mount external-data fetch. isLoadingKeys is initialised true, so this
        // path performs no synchronous setState — the fetch and all of its result
        // sets run after the first await inside fetchData. fetchData's identity is
        // stable (memoised on the stable rpcAction), so this runs once on mount.
        void (async () => { await fetchData(); })();
    }, [fetchData]);

    useEffect(() => {
        progressEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [progressLines]);

    const addProgress = (message: string, type: ProgressLine['type'] = 'info') => {
        // Mint a stable client-only id for the React list key. Generated here (in
        // a handler/async context, never during render) so each appended log line
        // carries a unique, non-reordering key. The id never leaves the client.
        const id = crypto.randomUUID();
        setProgressLines(prev => [...prev, { id, message, type }]);
    };

    const openModal = (title: string, icon: string) => {
        setModalTitle(title);
        setModalIcon(icon);
        setProgressLines([]);
        setIsOperationRunning(true);
        setIsModalOpen(true);
    };

    // --- SYNC ACTIONS ---

    const handleSyncWarrants = async () => {
        if (!currentUser) return;
        const ok = await confirm({
            title: 'Sync Cautions to Intelligence',
            message: "This will scan all active caution notes and generate intelligence reports for any targets that don't already have one. Continue?",
            confirmText: 'Run Sync',
        });
        if (!ok) return;

        setIsSyncingWarrants(true);
        openModal('Caution Sync', 'fa-solid fa-sync');
        addProgress('Initiating organizational caution sync process...', 'info');

        try {
            addProgress('Scanning active and standing caution notes...', 'info');
            const count = await rpcAction('admin:sync_warrants_to_reports', { adminId: currentUser.id });
            addProgress(`Generated ${count} new intelligence reports from caution notes.`, 'success');
            addProgress('Caution sync complete.', 'success');
        } catch (error: any) {
            console.error(error);
            addProgress(`Caution sync failed: ${error.message || 'Unknown server error.'}`, 'error');
        } finally {
            setIsSyncingWarrants(false);
            setIsOperationRunning(false);
        }
    };

    const handleSyncFeeds = async () => {
        if (!currentUser) return;

        setIsSyncingFeeds(true);
        openModal('External Feed Ingest', 'fa-solid fa-satellite-dish');
        addProgress('Initiating secure feed ingest sequence...', 'info');

        addProgress('Querying receive-only feeds and active allied peers...', 'info');

        try {
            const result = await rpcAction('intel:sync_feeds', { force: true });

            if (result?.feedResults && Array.isArray(result.feedResults)) {
                for (const fr of result.feedResults) {
                    const prefix = fr.label ? `[${fr.label}]` : '';
                    addProgress(`${prefix} ${fr.message}`, fr.status);
                }
            }

            const newReports = result?.totalReports || 0;
            const newWarrants = result?.totalWarrants || 0;
            const newBulletins = result?.totalBulletins || 0;
            const totalNew = newReports + newWarrants + newBulletins;

            if (totalNew > 0) {
                const parts: string[] = [];
                if (newReports > 0) parts.push(`${newReports} report(s)`);
                if (newWarrants > 0) parts.push(`${newWarrants} caution note(s)`);
                if (newBulletins > 0) parts.push(`${newBulletins} bulletin(s)`);
                addProgress(`Total ingested: ${parts.join(', ')}`, 'success');
                setIsLoadingKeys(true);
                fetchData();
            } else {
                addProgress('No new records were ingested across all feeds.', 'warning');
            }

            addProgress('Feed ingest complete.', 'success');
        } catch (error: any) {
            console.error(error);
            addProgress(`Feed ingest failed: ${error.message || 'Secure link timed out.'}`, 'error');
        } finally {
            setIsSyncingFeeds(false);
            setIsOperationRunning(false);
        }
    };

    const handleCleanup = async () => {
        if (!currentUser) return;
        const ok = await confirm({
            title: 'Deduplicate Caution Notes',
            message: 'This will scan the database for duplicate Active/Standing caution notes for the same target and remove older or redundant entries. Continue?',
            confirmText: 'Run Cleanup',
            variant: 'danger',
        });
        if (!ok) return;

        setIsCleaning(true);
        openModal('Caution Deduplication', 'fa-solid fa-triangle-exclamation');
        addProgress('Scanning for redundant caution note signatures...', 'info');

        try {
            const removedCount = await rpcAction('admin:deduplicate_warrants', {});
            addProgress(`Identified and purged ${removedCount} duplicate caution note record(s).`, 'success');
            addProgress('Database normalized.', 'success');
        } catch (error: any) {
            console.error(error);
            addProgress(`Deduplication failed: ${error.message || 'Database integrity check failed.'}`, 'error');
        } finally {
            setIsCleaning(false);
            setIsOperationRunning(false);
        }
    };

    const handleCleanupIntel = async () => {
        if (!currentUser) return;
        const ok = await confirm({
            title: 'Deduplicate Intel Reports',
            message: 'This will scan ALL intelligence reports for duplicates based on content and target ID. Duplicate manual entries may be removed in favor of external feed data. Continue?',
            confirmText: 'Run Cleanup',
            variant: 'danger',
        });
        if (!ok) return;

        setIsCleaningIntel(true);
        openModal('Intel Report Deduplication', 'fa-solid fa-file-shield');
        addProgress('Analyzing report signatures across database...', 'info');

        try {
            const removedCount = await rpcAction('admin:deduplicate_intel', {});
            addProgress(`Purged ${removedCount} duplicate intelligence report(s).`, 'success');
            addProgress('Intel database normalized.', 'success');
        } catch (error: any) {
            console.error(error);
            addProgress(`Deduplication failed: ${error.message || 'Database integrity check failed.'}`, 'error');
        } finally {
            setIsCleaningIntel(false);
            setIsOperationRunning(false);
        }
    };

    // --- API KEY MANAGEMENT ---

    const handleCreateKey = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newKeyLabel.trim()) return;
        setIsLoadingKeys(true);
        try {
            const result = await rpcAction('api:create_key', { label: newKeyLabel.trim() });
            setJustCreatedKey({ label: result.label, key: result.rawKey || result.keyPrefix });
            setNewKeyLabel('');
            fetchData();
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoadingKeys(false);
        }
    };

    const handleDeleteKey = async (id: string) => {
        const ok = await confirm({
            title: 'Revoke API Key',
            message: 'Revoke this API Key? Any external systems using it will lose access immediately.',
            confirmText: 'Revoke',
            variant: 'danger',
        });
        if (!ok) return;
        setIsLoadingKeys(true);
        try {
            await rpcAction('api:delete_key', { keyId: id });
            fetchData();
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoadingKeys(false);
        }
    };

    const handleSaveShareConfig = async (level: number) => {
        setMaxShareableClearance(level);
        setIsSavingShareConfig(true);
        try {
            await rpcAction('admin:update_intel_sharing_config', { config: { maxShareableClearance: level } });
        } catch (error) {
            console.error(error);
        } finally {
            setIsSavingShareConfig(false);
        }
    };

    const anyOperationActive = isSyncingWarrants || isSyncingFeeds || isCleaning || isCleaningIntel;

    const actionButtons = [
        { label: 'Sync Cautions', icon: 'fa-solid fa-sync', onClick: handleSyncWarrants, loading: isSyncingWarrants, color: 'sky', description: 'Generate reports from caution notes' },
        { label: 'Feed Ingest', icon: 'fa-solid fa-cloud-arrow-down', onClick: handleSyncFeeds, loading: isSyncingFeeds, color: 'emerald', description: 'Pull from allied feeds' },
        { label: 'Dedup Cautions', icon: 'fa-solid fa-triangle-exclamation', onClick: handleCleanup, loading: isCleaning, color: 'amber', description: 'Remove duplicate caution notes' },
        { label: 'Dedup Intel', icon: 'fa-solid fa-file-shield', onClick: handleCleanupIntel, loading: isCleaningIntel, color: 'amber', description: 'Remove duplicate reports' },
    ];

    const colorMap: Record<string, string> = {
        sky: 'bg-sky-600/10 text-sky-400 border-sky-600/30 hover:bg-sky-600/20',
        emerald: 'bg-emerald-600/10 text-emerald-400 border-emerald-600/30 hover:bg-emerald-600/20',
        amber: 'bg-amber-600/10 text-amber-400 border-amber-600/30 hover:bg-amber-600/20',
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Intel & Network Management"
                icon="fa-solid fa-network-wired"
                accent="cyan"
                subtitle="Manage external intelligence feeds, API access, and database synchronization."
            />

            {/* ACTION BAR */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {actionButtons.map(btn => (
                    <button
                        key={btn.label}
                        onClick={btn.onClick}
                        disabled={anyOperationActive}
                        className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${colorMap[btn.color]}`}
                    >
                        <i className={`${btn.loading ? 'fa-solid fa-spinner animate-spin' : btn.icon} text-lg`}></i>
                        <span className="text-xs font-bold uppercase tracking-wider">{btn.label}</span>
                        <span className="text-[10px] opacity-60">{btn.description}</span>
                    </button>
                ))}
            </div>

            {/* FEED SHARING POLICY */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center">
                        <i className="fa-solid fa-shield-halved mr-3 text-amber-400"></i>
                        Outbound Feed Sharing Policy
                    </h3>
                </div>
                <div className="p-6">
                    <p className="text-sm text-slate-400 mb-4">
                        Control the maximum classification level of intelligence that may be shared via the API feed with external organizations and alliances.
                        Reports and bulletins above this level will be excluded from the feed. Items with sync-restricted limiting markers are always excluded.
                    </p>
                    <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Max Shareable Level</label>
                        <select
                            value={maxShareableClearance}
                            onChange={(e) => handleSaveShareConfig(Number(e.target.value))}
                            disabled={isSavingShareConfig}
                            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-amber-500 outline-hidden disabled:opacity-50"
                        >
                            {securityClearances.length > 0 ? (
                                securityClearances.map((c: any) => (
                                    <option key={c.level} value={c.level}>
                                        Level {c.level} — {c.name}
                                    </option>
                                ))
                            ) : (
                                <>
                                    <option value={0}>Level 0 — Unclassified Only</option>
                                    <option value={1}>Level 1 — Restricted & Below</option>
                                    <option value={2}>Level 2 — Confidential & Below</option>
                                    <option value={3}>Level 3 — Secret & Below</option>
                                    <option value={4}>Level 4 — Top Secret & Below</option>
                                </>
                            )}
                        </select>
                        {isSavingShareConfig && <i className="fa-solid fa-spinner animate-spin text-amber-400 text-sm"></i>}
                    </div>
                </div>
            </div>

            {/* API ACCESS MANAGEMENT */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex justify-between items-center">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center">
                        <i className="fa-solid fa-key mr-3 text-emerald-400"></i>
                        API Access Management
                    </h3>
                    <span className="text-[10px] font-bold text-slate-500 uppercase">{keys.length} Active Key{keys.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="p-6">
                    <p className="text-sm text-slate-400 mb-4">
                        Manage API keys to grant external organizations read-only access to your public intelligence feed.
                    </p>

                    {justCreatedKey && (
                        <div className="bg-emerald-900/30 border border-emerald-500/50 p-4 rounded-lg mb-6 animate-fade-in">
                            <h3 className="text-emerald-400 font-bold mb-2">Key Created: {justCreatedKey.label}</h3>
                            <p className="text-sm text-slate-300 mb-2">Copy this key now. You will not be able to see it again.</p>
                            <div className="bg-black/50 p-3 rounded-sm font-mono text-white break-all border border-emerald-500/30 select-all">
                                {justCreatedKey.key}
                            </div>
                            <button
                                onClick={() => setJustCreatedKey(null)}
                                className="mt-4 text-sm text-emerald-400 hover:text-emerald-300 underline"
                            >
                                I have copied the key
                            </button>
                        </div>
                    )}

                    <form onSubmit={handleCreateKey} className="flex gap-4 mb-6">
                        <input
                            type="text"
                            value={newKeyLabel}
                            onChange={(e) => setNewKeyLabel(e.target.value)}
                            placeholder="Label (e.g. Allied Org Name)"
                            className="flex-1 bg-slate-800 border border-slate-600 rounded-md p-2 text-white focus:ring-2 focus:ring-emerald-500 outline-hidden transition-colors"
                        />
                        <button
                            type="submit"
                            disabled={isLoadingKeys || !newKeyLabel.trim()}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-md font-semibold transition-colors disabled:opacity-50"
                        >
                            Generate Key
                        </button>
                    </form>

                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="border-b border-slate-700 text-slate-400 text-sm">
                                    <th className="p-3">Label</th>
                                    <th className="p-3">Key Prefix</th>
                                    <th className="p-3">Created</th>
                                    <th className="p-3">Last Used</th>
                                    <th className="p-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                                {keys.map(key => (
                                    <tr key={key.id} className="hover:bg-slate-800/30 transition-colors">
                                        <td className="p-3 font-medium text-white">{key.label}</td>
                                        <td className="p-3 font-mono text-xs text-slate-400">{key.keyPrefix}</td>
                                        <td className="p-3 text-sm text-slate-400">{fmt(key.createdAt)}</td>
                                        <td className="p-3 text-sm text-slate-400">
                                            {key.lastUsedAt ? fmt(key.lastUsedAt) : 'Never'}
                                        </td>
                                        <td className="p-3 text-right">
                                            <button
                                                onClick={() => handleDeleteKey(key.id)}
                                                className="text-red-400 hover:text-red-300 p-2 hover:bg-red-500/10 rounded-sm transition-colors"
                                                title="Revoke Key"
                                            >
                                                <i className="fa-solid fa-trash"></i>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {keys.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="p-4 text-center text-slate-500 italic">No active API keys.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-6 bg-black/20 p-4 rounded-lg border border-slate-700/50">
                        <h3 className="text-white font-bold mb-2 text-xs uppercase tracking-wider">Your Feed Endpoint</h3>
                        <code className="block bg-black/40 p-3 rounded-sm text-xs font-mono text-slate-200 break-all">
                            {window.location.origin}
                        </code>
                    </div>
                </div>
            </div>

            {/* PROGRESS MODAL — portaled to body to escape stacking context */}
            {isModalOpen && createPortal(
                <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-100 flex items-center justify-center p-4" onClick={() => !isOperationRunning && setIsModalOpen(false)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
                        <div className="px-5 py-4 border-b border-slate-700/50 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <i className={`${modalIcon} text-slate-300`}></i>
                                <h3 className="text-white font-bold">{modalTitle}</h3>
                            </div>
                            {isOperationRunning ? (
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 bg-slate-300 rounded-full animate-pulse"></div>
                                    <span className="text-xs text-slate-300 font-bold uppercase">Running</span>
                                </div>
                            ) : (
                                <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white transition-colors p-1">
                                    <i className="fa-solid fa-xmark"></i>
                                </button>
                            )}
                        </div>
                        <div className="p-5 max-h-96 overflow-y-auto custom-scrollbar font-mono text-xs space-y-1.5">
                            {progressLines.map((line) => (
                                <div key={line.id} className={`flex items-start gap-2 ${
                                    line.type === 'error' ? 'text-red-400' :
                                    line.type === 'success' ? 'text-green-400' :
                                    line.type === 'warning' ? 'text-amber-400' :
                                    'text-slate-300'
                                }`}>
                                    <i className={`mt-0.5 text-[10px] ${
                                        line.type === 'error' ? 'fa-solid fa-circle-xmark' :
                                        line.type === 'success' ? 'fa-solid fa-circle-check' :
                                        line.type === 'warning' ? 'fa-solid fa-triangle-exclamation' :
                                        'fa-solid fa-chevron-right'
                                    }`}></i>
                                    <span>{line.message}</span>
                                </div>
                            ))}
                            {isOperationRunning && (
                                <div className="flex items-center gap-2 text-slate-500">
                                    <i className="fa-solid fa-spinner animate-spin text-[10px]"></i>
                                    <span>Processing...</span>
                                </div>
                            )}
                            <div ref={progressEndRef} />
                        </div>
                        {!isOperationRunning && (
                            <div className="px-5 py-3 border-t border-slate-700/50 flex justify-end">
                                <button
                                    onClick={() => setIsModalOpen(false)}
                                    className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold uppercase tracking-wider rounded-lg border border-slate-600 transition-colors"
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

export default IntelligenceManagementTab;
