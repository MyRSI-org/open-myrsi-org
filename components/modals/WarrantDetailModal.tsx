
import React, { useState, useEffect, useCallback } from 'react';
import { HydratedWarrant, WarrantNote } from '../../types';
import { useAuth, useFormatDate } from '../../contexts/AuthContext';
import { useData } from '../../contexts/DataContext';
import { useIntel } from '../../contexts/IntelContext';
import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';
import { useNavigation } from '../../contexts/NavigationContext';

interface WarrantDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    warrant: HydratedWarrant;
    onEdit?: () => void;
}

const getActionStyles = (action: string) => {
    switch (action) {
        case 'High Caution': return { icon: 'fa-solid fa-circle-exclamation', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' };
        case 'Extreme Caution': return { icon: 'fa-solid fa-triangle-exclamation', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' };
        case 'Caution': return { icon: 'fa-solid fa-eye', color: 'text-sky-400', bg: 'bg-sky-500/10', border: 'border-sky-500/20' };
        default: return { icon: 'fa-solid fa-question', color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' };
    }
};

const getStatusChipClass = (status: string) => {
    switch (status) {
        case 'Active': return 'bg-red-500/10 text-red-400 border-red-500/30';
        case 'Standing': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
        case 'Claimed': return 'bg-green-500/10 text-green-400 border-green-500/30';
        case 'Cancelled': return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
        default: return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
};

// Pretty relative timestamp for the notes thread; falls back to absolute
// when more than a week old.
const relativeTime = (iso: string, fmtFallback: (s: string) => string): string => {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const diffMs = Date.now() - t;
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return fmtFallback(iso);
};

const WarrantDetailModal: React.FC<WarrantDetailModalProps> = ({ isOpen, onClose, warrant, onEdit }) => {
    const { hasPermission, currentUser } = useAuth();
    const { rpcAction } = useData();
    const { intelTargetIndex } = useIntel();
    const { addToast } = useNotification();
    const { setActiveView } = useNavigation();
    const fmt = useFormatDate();
    const actionStyles = getActionStyles(warrant.action);
    const canManage = hasPermission('warrant:manage');
    const canPostNote = hasPermission('warrant:manage') || hasPermission('warrant:create');

    const formatDate = (dateStr: string) => fmt(dateStr);

    // Notes thread state. Loaded on open and when the realtime broadcast fires.
    // The legacy `warrant.notes` column is shown as the cached "latest note"
    // while the thread loads and as a fallback for pre-migration deployments
    // that don't have a warrant_notes table populated yet.
    const [notes, setNotes] = useState<WarrantNote[]>([]);
    // Lazy-init to true when the modal mounts already-open with a valid warrant: the
    // mount-time fetch effect below runs immediately, so the spinner must be showing
    // from the first paint (the prior code achieved this by raising the flag inside
    // the mount effect's loadNotes() call). Otherwise start false.
    const [loadingNotes, setLoadingNotes] = useState(() => isOpen && !!warrant?.id);
    const [draft, setDraft] = useState('');
    const [posting, setPosting] = useState(false);

    // Pure async fetch: awaits the RPC and writes the result, but does NOT flip the
    // loading flag on at the start. The loading flag is raised by the callers
    // (loadNotes for the event/manual paths; the render-time tracker below for the
    // open/refetch path) so the effect that runs this never has to call setState
    // synchronously.
    const fetchNotes = useCallback(async () => {
        if (!warrant?.id) return;
        try {
            const result: WarrantNote[] = await rpcAction('warrant:get_notes', { warrantId: warrant.id });
            setNotes(Array.isArray(result) ? result : []);
        } catch (err: any) {
            // Soft-fail: pre-migration tenants get an empty thread; the legacy
            // notes block below renders the cached column instead.
            console.warn('[Warrant Notes] Load failed:', err?.message || err);
            setNotes([]);
        } finally {
            setLoadingNotes(false);
        }
    }, [rpcAction, warrant.id]);

    // Event/manual entry point (realtime refresh + post-note). These run inside an
    // event handler / async callback, so raising the loading flag here is allowed.
    const loadNotes = useCallback(async () => {
        if (!warrant?.id) return;
        setLoadingNotes(true);
        await fetchNotes();
    }, [warrant.id, fetchNotes]);

    // Fetch the notes thread when the modal opens / the warrant changes. Equivalent
    // to the prior effect (deps [isOpen, loadNotes], guarded by isOpen && warrant.id),
    // but the synchronous loading-flag raise is moved out of the effect into this
    // render-time previous-value tracker (React-documented "adjust state during
    // render" pattern), keyed on the same inputs that drove the refetch. The effect
    // below then only performs the async fetch, so it no longer calls setState
    // synchronously.
    const [prevFetchKey, setPrevFetchKey] = useState({ isOpen, fetchNotes });
    if (prevFetchKey.isOpen !== isOpen || prevFetchKey.fetchNotes !== fetchNotes) {
        setPrevFetchKey({ isOpen, fetchNotes });
        if (isOpen && warrant?.id) {
            setLoadingNotes(true);
        }
    }

    useEffect(() => {
        if (!isOpen) return;
        // External-system synchronization: pull the notes thread from the server.
        // The loading flag is already raised before this runs (at mount via the lazy
        // initial state, and on warrant change via the render-time tracker above), so
        // the effect performs ONLY the async fetch. fetchNotes writes its results
        // exclusively behind an await (success/soft-fail/finally), never synchronously.
        // Defining the runner inline (canonical React data-fetch effect shape) keeps
        // those writes in an async continuation. void marks the promise as
        // intentionally unawaited.
        async function run() { await fetchNotes(); }
        void run();
    }, [isOpen, fetchNotes]);

    // Realtime: refresh thread when the warrant_update broadcast fires.
    // DataContext rebroadcasts on the org channel; we re-listen here to catch
    // remote-tab note posts without a full subset re-fetch.
    useEffect(() => {
        if (!isOpen) return;
        const handler = () => loadNotes();
        window.addEventListener('app:warrant-notes-refresh', handler);
        return () => window.removeEventListener('app:warrant-notes-refresh', handler);
    }, [isOpen, loadNotes]);

    const handlePostNote = async () => {
        const trimmed = draft.trim();
        if (!trimmed || posting) return;
        setPosting(true);
        try {
            await rpcAction('warrant:add_note', { warrantId: warrant.id, content: trimmed });
            setDraft('');
            await loadNotes();
        } catch (err: any) {
            addToast(
                'Note Failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not post the note. Please try again.' }
            );
        } finally {
            setPosting(false);
        }
    };

    // Intel dossier shortcut. Visible only when this warrant's target matches a
    // known intel target (via the IntelTargetIndex Map). Dispatches a custom
    // event so the Intel hub view can mount the dossier.
    const targetKey = (warrant.targetRsiHandle || '').trim().toLowerCase();
    const hasIntelDossier = !!targetKey && intelTargetIndex.has(targetKey);
    const handleOpenDossier = () => {
        // Reuses the existing app:intel-open-subject event that the Diplomacy
        // dossier already fires when navigating into an intel subject. Payload
        // shape (subjectId) and listener live in IntelligenceView.tsx.
        setActiveView('intel');
        // Dispatch on next tick so IntelligenceView is mounted and listening.
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('app:intel-open-subject', { detail: { subjectId: warrant.targetRsiHandle } }));
        }, 0);
        onClose();
    };

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Caution Note Detail"
            subtitle={`CN-${warrant.id.substring(0, 6)}`}
            icon="fa-solid fa-triangle-exclamation"
            color="red"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar">
                    {/* Target & Action */}
                    <div className="flex items-start gap-4">
                        <div className={`w-14 h-14 rounded-xl flex items-center justify-center shadow-inner border shrink-0 ${actionStyles.bg} ${actionStyles.border}`}>
                            <i className={`${actionStyles.icon} ${actionStyles.color} text-2xl`}></i>
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-white font-black text-2xl tracking-tighter uppercase truncate">
                                {warrant.targetRsiHandle}
                            </h3>
                            <p className={`text-xs font-black uppercase tracking-[0.2em] mt-1 ${actionStyles.color}`}>
                                {warrant.action} Order
                            </p>
                            {hasIntelDossier && (
                                <button
                                    onClick={handleOpenDossier}
                                    className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/10 text-sky-300 border border-sky-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-sky-500/20 transition-colors"
                                    title="Open this target's intel dossier"
                                >
                                    <i className="fa-solid fa-folder-open text-[9px]"></i>
                                    View Intel Dossier
                                </button>
                            )}
                        </div>
                        <span className={`px-2.5 py-1 rounded-sm text-[10px] font-black uppercase tracking-wider border shrink-0 ${getStatusChipClass(warrant.status)}`}>
                            {warrant.status}
                        </span>
                    </div>

                    {/* Bounty */}
                    <div className="bg-slate-950/30 p-4 rounded-lg border border-slate-800/50">
                        <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">Reward Value</p>
                        <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-black text-lime-400 font-mono tracking-tight">{warrant.uecReward.toLocaleString()}</span>
                            <span className="text-[10px] font-bold text-lime-400/70">aUEC</span>
                        </div>
                    </div>

                    {/* Reason */}
                    <div>
                        <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1.5">Authorization</p>
                        <p className="text-slate-300 text-sm leading-relaxed italic bg-slate-950/20 p-3 rounded-lg border border-slate-800/30">
                            "{warrant.reason}"
                        </p>
                    </div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-2 gap-3">
                        <div className="bg-slate-950/20 p-3 rounded-lg border border-slate-800/30">
                            <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">Issued By</p>
                            {warrant.issuedBy == null && warrant.sourceFeedLabel ? (
                                // Federated warrant — "via <ally>" provenance, no local issuer.
                                <div className="flex items-center gap-2">
                                    <i className="fa-solid fa-satellite-dish text-sky-400 text-xs" aria-hidden />
                                    <span className="text-sm text-sky-300 font-semibold">via {warrant.sourceFeedLabel}</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2">
                                    {warrant.issuedByUser?.avatarUrl && (
                                        <img src={warrant.issuedByUser.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
                                    )}
                                    <span className="text-sm text-white font-semibold">{warrant.issuedByUser?.name || 'Unknown'}</span>
                                </div>
                            )}
                        </div>
                        <div className="bg-slate-950/20 p-3 rounded-lg border border-slate-800/30">
                            <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">Issued At</p>
                            <span className="text-sm text-slate-300 font-mono">{formatDate(warrant.issuedAt)}</span>
                        </div>
                    </div>

                    {/* Claimed info */}
                    {warrant.claimedByUser && (
                        <div className="bg-green-900/10 p-3 rounded-lg border border-green-500/20">
                            <p className="text-[10px] uppercase font-black text-green-500/70 tracking-wider mb-1">Claimed By</p>
                            <div className="flex items-center gap-2">
                                {warrant.claimedByUser.avatarUrl && (
                                    <img src={warrant.claimedByUser.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
                                )}
                                <span className="text-sm text-green-300 font-semibold">{warrant.claimedByUser.name}</span>
                                {warrant.claimedAt && <span className="text-[10px] text-slate-500 font-mono ml-auto">{formatDate(warrant.claimedAt)}</span>}
                            </div>
                        </div>
                    )}

                    {/* Notes Thread */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider">
                                Notes
                                {notes.length > 0 && <span className="ml-2 text-slate-600 font-mono">({notes.length})</span>}
                            </p>
                            {loadingNotes && <i className="fa-solid fa-circle-notch animate-spin text-[10px] text-slate-500"></i>}
                        </div>

                        {canPostNote && (
                            <div className="bg-slate-950/30 rounded-lg border border-slate-800/50 p-2.5 mb-2">
                                <textarea
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    rows={2}
                                    placeholder="Post a note (visible to anyone who can view this warrant)..."
                                    disabled={posting}
                                    className="w-full bg-transparent text-sm text-white placeholder:text-slate-600 outline-hidden resize-none disabled:opacity-50"
                                />
                                <div className="flex items-center justify-between gap-2 mt-1.5">
                                    <span className="text-[9px] text-slate-600 italic">
                                        Posted as <span className="text-slate-400 font-bold">{currentUser?.name}</span>
                                    </span>
                                    <button
                                        onClick={handlePostNote}
                                        disabled={posting || !draft.trim()}
                                        className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-sky-500/10 text-sky-300 border border-sky-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-sky-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {posting
                                            ? <><i className="fa-solid fa-spinner animate-spin"></i> Posting</>
                                            : <><i className="fa-solid fa-paper-plane"></i> Post Note</>}
                                    </button>
                                </div>
                            </div>
                        )}

                        {notes.length > 0 ? (
                            <ul className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                                {notes.map((n) => (
                                    <li key={n.id} className="bg-slate-950/20 rounded-lg border border-slate-800/30 p-2.5">
                                        <div className="flex items-center gap-2 mb-1">
                                            {n.author?.avatarUrl ? (
                                                <img src={n.author.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                                            ) : (
                                                <div className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center">
                                                    <i className="fa-solid fa-user text-[7px] text-slate-500"></i>
                                                </div>
                                            )}
                                            <span className="text-[11px] font-bold text-slate-300 truncate">
                                                {n.author?.name || 'Unknown'}
                                            </span>
                                            <span className="text-[9px] text-slate-600 font-mono ml-auto">
                                                {relativeTime(n.createdAt, formatDate)}
                                            </span>
                                        </div>
                                        <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{n.content}</p>
                                    </li>
                                ))}
                            </ul>
                        ) : !loadingNotes && warrant.notes ? (
                            // Pre-migration fallback: show the cached legacy column when the
                            // warrant_notes table is missing or empty but a note exists.
                            <div className="bg-slate-950/20 rounded-lg border border-slate-800/30 p-2.5">
                                <p className="text-[9px] text-slate-600 italic mb-1">Legacy note (pre-attribution)</p>
                                <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{warrant.notes}</p>
                            </div>
                        ) : !loadingNotes && (
                            <p className="text-[11px] text-slate-600 italic">No notes yet.{canPostNote ? ' Post one to start the thread.' : ''}</p>
                        )}
                    </div>

                    {/* External source */}
                    {warrant.sourceFeedLabel && (
                        <div className="flex items-center gap-2 text-xs bg-sky-900/10 p-2.5 rounded-lg border border-sky-500/20">
                            <i className="fa-solid fa-satellite-dish text-sky-400 text-[10px]"></i>
                            <span className="text-sky-300 font-bold">External Source:</span>
                            <span className="text-slate-400">{warrant.sourceFeedLabel}</span>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors">Close</button>
                    {canManage && onEdit && (
                        <button
                            onClick={onEdit}
                            className="px-6 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-lg shadow-sky-900/30"
                        >
                            <i className="fa-solid fa-pen mr-2"></i>Edit Caution
                        </button>
                    )}
                </div>
            </div>
        </WindowFrame>
    );
};

export default WarrantDetailModal;
