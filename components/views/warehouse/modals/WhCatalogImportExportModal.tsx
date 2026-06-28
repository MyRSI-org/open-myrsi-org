import React, { useCallback, useRef, useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import { useConfig } from '../../../../contexts/ConfigContext';
import { useWarehouse } from '../../../../contexts/WarehouseContext';
import { useAuth } from '../../../../contexts/AuthContext';
import WindowFrame from '../../../layout/WindowFrame';
import { useNotification } from '../../../../contexts/NotificationContext';

interface WhCatalogImportExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Optional callback fired after a successful import (e.g. parent re-fetch). */
    onImported?: () => void;
}

interface ExportItem {
    name: string;
    category: string;
    qualityLabel: string | null;
    unit: string;
    description: string | null;
    archived: boolean;
}

interface ExportPage {
    items: ExportItem[];
    total: number;
    nextOffset: number | null;
    filename?: string;
    version?: 1;
    exportedAt?: string;
    organizationId?: string;
}

interface PreviewResult {
    newCount: number;
    updateCount: number;
    skipCount: number;
    conflicts: Array<{
        name: string;
        qualityLabel: string | null;
        changes: Record<string, { from: any; to: any }>;
    }>;
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

interface ExportProgress {
    fetched: number;
    total: number;
}

const EXPORT_PAGE_SIZE = 200;
// Client-side import batch. Server clamps to MAX_WAREHOUSE_IMPORT_BATCH_SIZE (100).
const IMPORT_BATCH_SIZE = 50;

const WhCatalogImportExportModal: React.FC<WhCatalogImportExportModalProps> = ({ isOpen, onClose, onImported }) => {
    const { rpcAction } = useData();
    const { brandingConfig } = useConfig();
    const { refreshWarehouse } = useWarehouse();
    const { hasPermission } = useAuth();
    const { addToast } = useNotification();

    const canImport = hasPermission('warehouse:admin');

    const [tab, setTab] = useState<'export' | 'import'>('export');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Export state
    const [exporting, setExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
    const exportCancelRef = useRef(false);

    // Import state
    const [items, setItems] = useState<any[] | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
    const [importing, setImporting] = useState(false);
    const importCancelRef = useRef(false);

    // Reset all modal form/progress state each time the modal opens (or the
    // user's import permission changes while open). Adjusting state during
    // render (React-documented pattern) is equivalent to the old reset effect
    // keyed on [isOpen, canImport] but runs before paint without a synchronous
    // effect setState. The reset only fires while open, matching the original
    // effect's `if (!isOpen) return` guard.
    const resetKey = `${isOpen}:${canImport}`;
    const [prevResetKey, setPrevResetKey] = useState(resetKey);
    if (resetKey !== prevResetKey) {
        setPrevResetKey(resetKey);
        if (isOpen) {
            // If the user can't import, default to the only tab they can use.
            setTab(canImport ? 'export' : 'export');
            setItems(null);
            setPreview(null);
            setImportProgress(null);
            setExportProgress(null);
            setImporting(false);
            setExporting(false);
            setLoadingPreview(false);
            setFileName(null);
            // NOTE: the cancel refs are deterministically reset to false at the
            // start of handleStartExport / handleStartImport (before any read),
            // so they need no reset here — and refs must not be mutated during
            // render. Resetting them on open would be a redundant no-op.
        }
    }

    // ---- Export ---------------------------------------------------------------
    const handleStartExport = async () => {
        setExporting(true);
        exportCancelRef.current = false;
        const collected: ExportItem[] = [];
        let envelopeMeta: { version: 1; exportedAt: string; organizationId?: string; filename: string } | null = null;
        let offset = 0;
        try {
            while (true) {
                if (exportCancelRef.current) break;
                const page: ExportPage = await rpcAction('warehouse:export_catalog', { offset, limit: EXPORT_PAGE_SIZE });
                if (!page || !Array.isArray(page.items)) {
                    throw new Error('Server returned an unexpected response.');
                }
                if (offset === 0) {
                    envelopeMeta = {
                        version: page.version ?? 1,
                        exportedAt: page.exportedAt ?? new Date().toISOString(),
                        organizationId: page.organizationId,
                        filename: page.filename ?? `warehouse-catalog-${new Date().toISOString().slice(0, 10)}.json`,
                    };
                }
                collected.push(...page.items);
                setExportProgress({ fetched: collected.length, total: page.total });
                if (page.nextOffset == null) break;
                offset = page.nextOffset;
            }

            if (exportCancelRef.current) {
                addToast('Export cancelled', <i className="fa-solid fa-ban" />,
                    'bg-amber-500/10 text-amber-400 border-amber-500/50',
                    { description: `${collected.length} commodit${collected.length === 1 ? 'y' : 'ies'} fetched before cancel.` });
                return;
            }

            if (!envelopeMeta) {
                throw new Error('Export envelope missing.');
            }

            const envelope = {
                version: envelopeMeta.version,
                exportedAt: envelopeMeta.exportedAt,
                organizationId: envelopeMeta.organizationId,
                items: collected,
            };
            const safeOrg = (brandingConfig?.name || 'org').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
            const defaultName = envelopeMeta.filename || `${safeOrg}-warehouse-catalog-${new Date().toISOString().slice(0, 10)}.json`;
            const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            addToast('Catalog exported', <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                { description: `${collected.length} commodit${collected.length === 1 ? 'y' : 'ies'} written to ${defaultName}.` });
        } catch (err: any) {
            addToast('Export failed', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not export the catalog.' });
        } finally {
            setExporting(false);
        }
    };

    const handleCancelExport = () => { exportCancelRef.current = true; };

    // ---- Import ---------------------------------------------------------------
    const loadPreview = useCallback(async (parsedItems: any[]) => {
        setLoadingPreview(true);
        try {
            const result: PreviewResult = await rpcAction('warehouse:preview_import_catalog', { items: parsedItems });
            setPreview(result);
        } catch (err: any) {
            addToast('Preview failed', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not preview the import.' });
            setPreview(null);
        } finally {
            setLoadingPreview(false);
        }
    }, [rpcAction, addToast]);

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
                if (parsed.version !== undefined && parsed.version !== 1) {
                    throw new Error(`Unsupported file version: ${parsed.version}. Expected 1.`);
                }
                if (!Array.isArray(parsed.items)) throw new Error('File is missing an "items" array.');
                setItems(parsed.items);
                setImportProgress(null);
                loadPreview(parsed.items);
            } catch (err: any) {
                addToast('Invalid file', <i className="fa-solid fa-xmark" />,
                    'bg-red-500/10 text-red-400 border-red-500/50',
                    { description: err?.message || 'Could not read JSON.' });
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
        importCancelRef.current = false;
        let offset = 0;
        let totalInserted = 0;
        let totalUpdated = 0;
        const totalErrors: ImportProgress['errors'] = [];
        try {
            while (true) {
                if (importCancelRef.current) break;
                const r: any = await rpcAction('warehouse:import_catalog', {
                    items,
                    offset,
                    limit: IMPORT_BATCH_SIZE,
                });
                totalInserted += r?.inserted || 0;
                totalUpdated += r?.updated || 0;
                if (Array.isArray(r?.errors)) totalErrors.push(...r.errors);
                const next = r?.nextOffset;
                const processedSoFar = next ?? items.length;
                setImportProgress({
                    processed: processedSoFar,
                    total: items.length,
                    inserted: totalInserted,
                    updated: totalUpdated,
                    errors: totalErrors,
                });
                if (next == null) break;
                offset = next;
            }
            await refreshWarehouse();
            onImported?.();
            addToast(
                importCancelRef.current ? 'Import cancelled' : 'Import complete',
                <i className={`fa-solid ${importCancelRef.current ? 'fa-ban' : 'fa-check'}`} />,
                importCancelRef.current
                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/50'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                { description: `${totalInserted} added, ${totalUpdated} updated${totalErrors.length ? `, ${totalErrors.length} error${totalErrors.length === 1 ? '' : 's'}` : ''}.` },
            );
        } catch (err: any) {
            addToast('Import failed', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Import aborted.' });
        } finally {
            setImporting(false);
        }
    };

    const handleCancelImport = () => { importCancelRef.current = true; };

    const exportPercent = exportProgress
        ? Math.min(100, Math.round((exportProgress.fetched / Math.max(1, exportProgress.total)) * 100))
        : 0;
    const importPercent = importProgress
        ? Math.min(100, Math.round((importProgress.processed / Math.max(1, importProgress.total)) * 100))
        : 0;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Warehouse Catalog — Import / Export"
            subtitle="Commodities only — stock and movements are not included."
            icon="fa-solid fa-arrows-rotate"
            color="sky"
            width="max-w-2xl"
        >
            <div className="flex flex-col h-full">
                <div className="flex border-b border-slate-700/50">
                    <button
                        onClick={() => setTab('export')}
                        className={`px-5 py-3 text-xs font-black uppercase tracking-widest transition-colors ${tab === 'export' ? 'text-slate-100 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        <i className="fa-solid fa-file-arrow-down mr-2" /> Export
                    </button>
                    {canImport && (
                        <button
                            onClick={() => setTab('import')}
                            className={`px-5 py-3 text-xs font-black uppercase tracking-widest transition-colors ${tab === 'import' ? 'text-slate-100 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            <i className="fa-solid fa-file-arrow-up mr-2" /> Import
                        </button>
                    )}
                </div>

                {tab === 'export' && (
                    <div className="p-5 space-y-4">
                        <p className="text-sm text-slate-300">
                            Downloads a JSON file containing every commodity definition in this organisation's catalog.
                            Server-managed fields (IDs, timestamps) are stripped so the file imports cleanly into another org.
                        </p>
                        <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-2">File contents</p>
                            <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                                <li>name, category, qualityLabel, unit, description, archived</li>
                                <li>version, exportedAt, organizationId</li>
                            </ul>
                        </div>

                        {exportProgress && (
                            <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30 space-y-2">
                                <div className="flex justify-between text-[10px] text-slate-400 uppercase tracking-widest font-black">
                                    <span>Fetching</span>
                                    <span>{exportProgress.fetched} / {exportProgress.total}</span>
                                </div>
                                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                    <div className="h-full bg-cyan-400 transition-all" style={{ width: `${exportPercent}%` }} />
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end gap-3">
                            {exporting ? (
                                <button
                                    onClick={handleCancelExport}
                                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 text-[10px] font-bold uppercase tracking-wider transition-colors"
                                >
                                    <i className="fa-solid fa-ban" /> Cancel
                                </button>
                            ) : (
                                <button
                                    onClick={handleStartExport}
                                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-cyan-500/20 transition-colors"
                                >
                                    <i className="fa-solid fa-download" /> Download JSON
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {tab === 'import' && canImport && (
                    <div className="p-5 space-y-4">
                        <p className="text-sm text-slate-300">
                            Upload a warehouse-catalog JSON file (exported from this or another org). Existing entries are matched by <strong>name + quality label</strong> — category, unit, description, and archived state update; missing entries are added. Nothing is deleted.
                        </p>

                        <div className="flex items-center gap-3">
                            <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFilePick} className="hidden" />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={importing}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800/60 text-slate-300 border border-slate-700 hover:text-white hover:border-cyan-500/30 text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
                            >
                                <i className="fa-solid fa-folder-open" /> Pick JSON File
                            </button>
                            {fileName && <span className="text-xs text-slate-400 truncate">{fileName}</span>}
                        </div>

                        {loadingPreview && (
                            <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30 flex items-center gap-2 text-xs text-slate-400">
                                <i className="fa-solid fa-circle-notch animate-spin" /> Computing diff…
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
                                                <li key={`${c.name}::${c.qualityLabel ?? ''}`} className="bg-slate-900/60 rounded-md p-2 border border-slate-700/30">
                                                    <p className="font-bold text-slate-200 mb-1">
                                                        {c.name}
                                                        {c.qualityLabel && <span className="ml-2 text-[10px] font-mono text-slate-500">· {c.qualityLabel}</span>}
                                                    </p>
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

                        {importProgress && (
                            <div className="bg-slate-900/40 rounded-lg p-4 border border-slate-700/30 space-y-2">
                                <div className="flex justify-between text-[10px] text-slate-400 uppercase tracking-widest font-black">
                                    <span>Progress</span>
                                    <span>{importProgress.processed} / {importProgress.total}</span>
                                </div>
                                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                    <div className="h-full bg-cyan-400 transition-all" style={{ width: `${importPercent}%` }} />
                                </div>
                                <p className="text-[11px] text-slate-400">
                                    {importProgress.inserted} added, {importProgress.updated} updated{importProgress.errors.length ? `, ${importProgress.errors.length} error${importProgress.errors.length === 1 ? '' : 's'}` : ''}.
                                </p>
                                {importProgress.errors.length > 0 && (
                                    <details className="text-xs">
                                        <summary className="text-amber-400 cursor-pointer">View errors</summary>
                                        <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto custom-scrollbar text-slate-400">
                                            {importProgress.errors.map((bad) => (
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
                                    <i className="fa-solid fa-ban" /> Cancel
                                </button>
                            ) : (
                                <button
                                    onClick={handleStartImport}
                                    disabled={!items || !preview || importing || (preview.newCount + preview.updateCount === 0)}
                                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-cyan-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <i className="fa-solid fa-play" /> Start Import
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

export default WhCatalogImportExportModal;
