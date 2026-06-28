import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useConfig } from '../../contexts/ConfigContext';
import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

export type AchievementKind = 'specializations' | 'certifications' | 'commendations';

interface AchievementImportExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    kind: AchievementKind;
}

interface PreviewResult {
    newCount: number;
    updateCount: number;
    skipCount: number;
    conflicts: Array<{ name: string; changes: Record<string, { from: any; to: any }> }>;
    invalid: Array<{ index: number; name?: string; reason: string }>;
    total: number;
}

interface ImportProgress {
    processed: number;
    total: number;
    inserted: number;
    updated: number;
    errors: Array<{ index: number; name?: string; reason: string }>;
}

const KIND_META: Record<AchievementKind, { title: string; icon: string; previewAction: string; importAction: string; pluralLabel: string }> = {
    specializations: {
        title: 'Specializations',
        icon: 'fa-solid fa-tags',
        previewAction: 'admin:preview_specializations_import',
        importAction: 'admin:bulk_import_specializations',
        pluralLabel: 'specializations',
    },
    certifications: {
        title: 'Certifications',
        icon: 'fa-solid fa-certificate',
        previewAction: 'admin:preview_certifications_import',
        importAction: 'admin:bulk_import_certifications',
        pluralLabel: 'certifications',
    },
    commendations: {
        title: 'Commendations',
        icon: 'fa-solid fa-medal',
        previewAction: 'admin:preview_commendations_import',
        importAction: 'admin:bulk_import_commendations',
        pluralLabel: 'commendations',
    },
};

// Client-side batch size. Server clamps to 100 regardless. 50 keeps progress
// updates frequent without flooding the RPC dispatcher.
const CLIENT_BATCH_SIZE = 50;

const AchievementImportExportModal: React.FC<AchievementImportExportModalProps> = ({ isOpen, onClose, kind }) => {
    const meta = KIND_META[kind];
    const { rpcAction, refreshMainState } = useData();
    const { specializationTags, certifications, commendations } = useMembers();
    const { brandingConfig } = useConfig();
    const { addToast } = useNotification();

    const [tab, setTab] = useState<'export' | 'import'>('export');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ---- Export ---------------------------------------------------------------
    // Serializes items already in client state — no RPC required. The export
    // shape strips server-managed fields so the file is portable across orgs.
    const exportableItems = useMemo(() => {
        const source = kind === 'specializations' ? specializationTags
            : kind === 'certifications' ? certifications
            : commendations;
        return (source || []).map(it => ({
            name: it.name,
            description: it.description || null,
            icon: (it as any).icon || null,
            imageUrl: (it as any).imageUrl || null,
        }));
    }, [kind, specializationTags, certifications, commendations]);

    const handleExport = () => {
        const envelope = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            exportedFromOrg: brandingConfig?.name || 'Organization',
            type: kind,
            items: exportableItems,
        };
        const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeOrg = (brandingConfig?.name || 'org').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
        a.download = `${safeOrg}-${kind}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ---- Import ---------------------------------------------------------------
    const [items, setItems] = useState<any[] | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [importing, setImporting] = useState(false);
    const cancelRef = useRef(false);

    // Reset transient state every time the modal opens or the kind changes,
    // using React's "adjust state during render" pattern with previous-value
    // trackers. This runs during render (before paint), so it is behaviourally
    // equivalent to the old reset-in-effect: when isOpen flips true, or kind
    // switches while open, the transient fields are re-seeded; a close (isOpen
    // → false) only advances the trackers and resets nothing — matching the old
    // effect's `if (!isOpen) return` guard.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    const [prevKind, setPrevKind] = useState(kind);
    if (isOpen !== prevIsOpen || kind !== prevKind) {
        setPrevIsOpen(isOpen);
        setPrevKind(kind);
        if (isOpen) {
            setTab('export');
            setItems(null);
            setPreview(null);
            setProgress(null);
            setImporting(false);
            setLoadingPreview(false);
            setFileName(null);
        }
    }

    const loadPreview = useCallback(async (parsedItems: any[]) => {
        setLoadingPreview(true);
        try {
            const result = await rpcAction(meta.previewAction, { items: parsedItems });
            setPreview(result as PreviewResult);
        } catch (err: any) {
            addToast('Preview Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'Could not preview the import.' });
            setPreview(null);
        } finally {
            setLoadingPreview(false);
        }
    }, [rpcAction, meta.previewAction, addToast, setLoadingPreview, setPreview]);

    const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setFileName(file.name);
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const parsed = JSON.parse(text);
                if (!parsed || typeof parsed !== 'object') throw new Error('File is not a JSON object.');
                if (parsed.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion: ${parsed.schemaVersion}. Expected 1.`);
                if (parsed.type && parsed.type !== kind) throw new Error(`File is for "${parsed.type}", but this dialog is importing "${kind}".`);
                if (!Array.isArray(parsed.items)) throw new Error('File is missing an "items" array.');
                setItems(parsed.items);
                setProgress(null);
                loadPreview(parsed.items);
            } catch (err: any) {
                addToast('Invalid File', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'Could not read JSON.' });
                setItems(null);
                setPreview(null);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleStartImport = async () => {
        if (!items || items.length === 0) return;
        setImporting(true);
        cancelRef.current = false;
        let offset = 0;
        let totalInserted = 0;
        let totalUpdated = 0;
        const totalErrors: ImportProgress['errors'] = [];
        try {
            // Loop until the server reports no nextOffset or the user cancels.
            while (true) {
                if (cancelRef.current) break;
                const r: any = await rpcAction(meta.importAction, {
                    items,
                    offset,
                    limit: CLIENT_BATCH_SIZE,
                });
                totalInserted += r?.inserted || 0;
                totalUpdated += r?.updated || 0;
                if (Array.isArray(r?.errors)) totalErrors.push(...r.errors);
                const next = r?.nextOffset;
                const processedSoFar = next ?? items.length;
                setProgress({
                    processed: processedSoFar,
                    total: items.length,
                    inserted: totalInserted,
                    updated: totalUpdated,
                    errors: totalErrors,
                });
                if (next == null) break;
                offset = next;
            }
            await refreshMainState();
            addToast(
                cancelRef.current ? 'Import Cancelled' : 'Import Complete',
                <i className={`fa-solid ${cancelRef.current ? 'fa-ban' : 'fa-check'}`}></i>,
                cancelRef.current
                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/50'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                { description: `${totalInserted} added, ${totalUpdated} updated${totalErrors.length ? `, ${totalErrors.length} errors` : ''}.` },
            );
        } catch (err: any) {
            addToast('Import Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'Import aborted.' });
        } finally {
            setImporting(false);
        }
    };

    const handleCancelImport = () => { cancelRef.current = true; };

    const headerLabel = `${meta.title} — Import / Export`;
    const subtitle = 'Catalog only — per-user awards are not included.';

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={headerLabel}
            subtitle={subtitle}
            icon={meta.icon}
            color="purple"
            width="max-w-2xl"
        >
            <div className="flex flex-col h-full">
                {/* Tabs */}
                <div className="flex border-b border-slate-700/50">
                    <button
                        onClick={() => setTab('export')}
                        className={`px-5 py-3 text-xs font-black uppercase tracking-widest transition-colors ${tab === 'export' ? 'text-slate-100 border-b-2 border-purple-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        <i className="fa-solid fa-file-arrow-down mr-2"></i> Export
                    </button>
                    <button
                        onClick={() => setTab('import')}
                        className={`px-5 py-3 text-xs font-black uppercase tracking-widest transition-colors ${tab === 'import' ? 'text-slate-100 border-b-2 border-purple-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        <i className="fa-solid fa-file-arrow-up mr-2"></i> Import
                    </button>
                </div>

                {/* Export tab */}
                {tab === 'export' && (
                    <div className="p-5 space-y-4">
                        <p className="text-sm text-slate-300">
                            Downloads a JSON file containing every {meta.pluralLabel.slice(0, -1)} definition in this organisation
                            ({exportableItems.length} item{exportableItems.length === 1 ? '' : 's'}).
                            Server-managed fields like IDs and timestamps are stripped so the file imports cleanly into another org.
                        </p>
                        <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-2">File contents</p>
                            <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                                <li>name, description, icon, imageUrl</li>
                                <li>schemaVersion, exportedAt, exportedFromOrg</li>
                            </ul>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={handleExport}
                                disabled={exportableItems.length === 0}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <i className="fa-solid fa-download"></i> Download JSON
                            </button>
                        </div>
                    </div>
                )}

                {/* Import tab */}
                {tab === 'import' && (
                    <div className="p-5 space-y-4">
                        <p className="text-sm text-slate-300">
                            Upload a {meta.pluralLabel} JSON file (exported from this or another myRSI org). Existing entries are matched by <strong>name</strong> — descriptions, icons, and images update; missing names are added. Nothing is deleted.
                        </p>

                        <div className="flex items-center gap-3">
                            <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFilePick} className="hidden" />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={importing}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800/60 text-slate-300 border border-slate-700 hover:text-white hover:border-purple-500/30 text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
                            >
                                <i className="fa-solid fa-folder-open"></i> Pick JSON File
                            </button>
                            {fileName && <span className="text-xs text-slate-400 truncate">{fileName}</span>}
                        </div>

                        {loadingPreview && (
                            <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30 flex items-center gap-2 text-xs text-slate-400">
                                <i className="fa-solid fa-circle-notch animate-spin"></i> Computing diff…
                            </div>
                        )}

                        {preview && !loadingPreview && (
                            <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30 space-y-3">
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                    <Stat label="Total" value={preview.total} color="text-slate-200" />
                                    <Stat label="New" value={preview.newCount} color="text-emerald-400" />
                                    <Stat label="Update" value={preview.updateCount} color="text-amber-400" />
                                    <Stat label="Skip" value={preview.skipCount} color="text-slate-500" />
                                </div>
                                {preview.invalid.length > 0 && (
                                    <details className="text-xs">
                                        <summary className="text-amber-400 cursor-pointer">{preview.invalid.length} invalid row{preview.invalid.length === 1 ? '' : 's'} (will be skipped)</summary>
                                        <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto custom-scrollbar text-slate-400">
                                            {preview.invalid.map((bad) => (
                                                <li key={bad.index}>Row {bad.index + 1}{bad.name ? ` — ${bad.name}` : ''}: {bad.reason}</li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                                {preview.conflicts.length > 0 && (
                                    <details className="text-xs">
                                        <summary className="text-amber-400 cursor-pointer">{preview.conflicts.length} change{preview.conflicts.length === 1 ? '' : 's'} to existing entries</summary>
                                        <ul className="mt-2 space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
                                            {preview.conflicts.map((c) => (
                                                <li key={c.name} className="bg-slate-900/60 rounded-md p-2 border border-slate-700/30">
                                                    <p className="font-bold text-slate-200 mb-1">{c.name}</p>
                                                    {Object.entries(c.changes).map(([field, change]) => (
                                                        <div key={field} className="text-[11px] text-slate-400">
                                                            <span className="font-mono text-slate-500">{field}:</span>{' '}
                                                            <span className="text-red-300/80 line-through">{String(change.from ?? '∅').slice(0, 80)}</span>{' '}
                                                            → <span className="text-emerald-300">{String(change.to ?? '∅').slice(0, 80)}</span>
                                                        </div>
                                                    ))}
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                            </div>
                        )}

                        {progress && (
                            <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30 space-y-2">
                                <div className="flex justify-between text-[10px] text-slate-400 uppercase tracking-widest font-black">
                                    <span>Progress</span>
                                    <span>{progress.processed} / {progress.total}</span>
                                </div>
                                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-purple-400 transition-all"
                                        style={{ width: `${Math.min(100, Math.round((progress.processed / Math.max(1, progress.total)) * 100))}%` }}
                                    />
                                </div>
                                <p className="text-[11px] text-slate-400">
                                    {progress.inserted} added, {progress.updated} updated{progress.errors.length ? `, ${progress.errors.length} error${progress.errors.length === 1 ? '' : 's'}` : ''}.
                                </p>
                                {progress.errors.length > 0 && (
                                    <details className="text-xs">
                                        <summary className="text-amber-400 cursor-pointer">View errors</summary>
                                        <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto custom-scrollbar text-slate-400">
                                            {progress.errors.map((bad) => (
                                                <li key={bad.index}>Row {bad.index + 1}{bad.name ? ` — ${bad.name}` : ''}: {bad.reason}</li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                            </div>
                        )}

                        <div className="flex justify-end gap-3">
                            {importing ? (
                                <button
                                    onClick={handleCancelImport}
                                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 text-[10px] font-bold uppercase tracking-wider transition-colors"
                                >
                                    <i className="fa-solid fa-ban"></i> Cancel
                                </button>
                            ) : (
                                <button
                                    onClick={handleStartImport}
                                    disabled={!items || !preview || importing || (preview.newCount + preview.updateCount === 0)}
                                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <i className="fa-solid fa-play"></i> Start Import
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </WindowFrame>
    );
};

const Stat: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
    <div className="bg-slate-800/40 rounded-md p-2 border border-slate-700/30">
        <p className="text-[9px] text-slate-500 uppercase tracking-widest font-black">{label}</p>
        <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
);

export default AchievementImportExportModal;
