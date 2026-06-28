import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import type { WarehouseCatalogItem, WarehouseCatalogCategory, WarehouseCatalogSearchResult } from '../../../types';
import WhCatalogImportExportModal from './modals/WhCatalogImportExportModal';

const CATEGORY_LABEL: Record<WarehouseCatalogCategory, string> = {
    ore: 'Ore',
    refined: 'Refined',
    fuel: 'Fuel',
    rmc: 'RMC',
    munition: 'Munition',
    consumable: 'Consumable',
    misc: 'Misc',
};

interface Props {
    catalog: WarehouseCatalogItem[];
    canAdmin: boolean;
    onEdit: (item: WarehouseCatalogItem) => void;
    onAdd: () => void;
    onCatalogChanged?: () => void;
}

export default function WhCatalogTab({ catalog, canAdmin, onEdit, onAdd, onCatalogChanged }: Props) {
    const { rpcAction } = useData();
    const [search, setSearch] = useState('');
    const [showArchived, setShowArchived] = useState(false);
    const [includePlatform, setIncludePlatform] = useState(false);
    const [importExportOpen, setImportExportOpen] = useState(false);

    // Platform results — only fetched when checkbox is on AND query is non-empty.
    const debouncedSearch = useDebouncedValue(search.trim(), 300);
    const [platformResultsRaw, setPlatformResultsRaw] = useState<WarehouseCatalogSearchResult[]>([]);
    const [platformLoadingRaw, setPlatformLoadingRaw] = useState(false);
    const [platformErrorRaw, setPlatformErrorRaw] = useState<string | null>(null);
    const requestSeqRef = useRef(0);

    // The platform section is only active while the checkbox is on AND a query
    // exists. Derive the displayed values from that condition during render so
    // we never need a synchronous "reset" setState in the effect below.
    const platformActive = includePlatform && !!debouncedSearch;
    const platformResults = platformActive ? platformResultsRaw : [];
    const platformLoading = platformActive ? platformLoadingRaw : false;
    const platformError = platformActive ? platformErrorRaw : null;

    // Flip the loading flag / clear the error at fetch start. This is the
    // synchronous "we're about to fetch" transition: deriving it during render
    // (React-documented adjust-state-during-render pattern) keyed on the active
    // query is equivalent to setting it at the top of the effect, but keeps the
    // effect free of synchronous setState. The async .then/.catch/.finally below
    // owns the results/error and clears the flag when the request settles.
    const fetchKey = platformActive ? debouncedSearch : null;
    const [prevFetchKey, setPrevFetchKey] = useState<string | null>(fetchKey);
    if (fetchKey !== prevFetchKey) {
        setPrevFetchKey(fetchKey);
        if (fetchKey !== null) {
            setPlatformLoadingRaw(true);
            setPlatformErrorRaw(null);
        }
    }

    useEffect(() => {
        if (!platformActive) return;
        const seq = ++requestSeqRef.current;
        rpcAction('warehouse:search_catalog', { query: debouncedSearch, source: 'platform', limit: 100 })
            .then((rows: any) => {
                if (seq !== requestSeqRef.current) return;
                setPlatformResultsRaw(Array.isArray(rows) ? rows : []);
            })
            .catch((err: any) => {
                if (seq !== requestSeqRef.current) return;
                setPlatformErrorRaw(err?.message || 'Search failed');
                setPlatformResultsRaw([]);
            })
            .finally(() => {
                if (seq === requestSeqRef.current) setPlatformLoadingRaw(false);
            });
    }, [platformActive, debouncedSearch, rpcAction]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return catalog.filter((c) => {
            if (!showArchived && c.archivedAt) return false;
            if (q) {
                if (!c.name.toLowerCase().includes(q) && !(c.qualityLabel || '').toLowerCase().includes(q)) return false;
            }
            return true;
        }).sort((a, b) => {
            const cat = a.category.localeCompare(b.category);
            if (cat !== 0) return cat;
            return a.name.localeCompare(b.name);
        });
    }, [catalog, search, showArchived]);

    const customCount = catalog.length;
    const visibleActiveCount = catalog.filter((c) => !c.archivedAt).length;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-widest">Catalog</h2>
                    <p className="text-[11px] text-slate-500 font-mono uppercase tracking-widest mt-0.5">
                        {visibleActiveCount} active · {customCount - visibleActiveCount} archived · platform: search to browse
                    </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => setImportExportOpen(true)}
                        className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest border border-white/10 transition">
                        <i className="fa-solid fa-arrows-rotate" /> Import / Export…
                    </button>
                    {canAdmin && (
                        <button onClick={onAdd}
                            className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg font-bold uppercase tracking-widest text-[11px] transition-all">
                            <i className="fa-solid fa-plus" /> Add Commodity
                        </button>
                    )}
                </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-900/30 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="relative flex-1">
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search commodities by name or quality…"
                        className="w-full bg-slate-900 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-hidden focus:border-cyan-500/40"
                    />
                    <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs" />
                </div>
                <label className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-400 cursor-pointer select-none whitespace-nowrap">
                    <input
                        type="checkbox"
                        checked={showArchived}
                        onChange={(e) => setShowArchived(e.target.checked)}
                        className="accent-cyan-500"
                    />
                    Show archived
                </label>
                <label className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-400 cursor-pointer select-none whitespace-nowrap">
                    <input
                        type="checkbox"
                        checked={includePlatform}
                        onChange={(e) => setIncludePlatform(e.target.checked)}
                        className="accent-cyan-500"
                    />
                    Include platform catalog
                </label>
            </div>

            {catalog.length === 0 && !debouncedSearch ? (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 p-10 text-center text-slate-500 text-sm">
                    No commodities defined yet. {canAdmin && 'Click "Add Commodity" to add one, or use the search above with "Include platform catalog" to browse the platform-wide catalog.'}
                </div>
            ) : (
                <div className="rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-black/30 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            <tr>
                                <th className="px-3 py-2">Name</th>
                                <th className="px-3 py-2">Quality</th>
                                <th className="px-3 py-2">Category</th>
                                <th className="px-3 py-2">Unit</th>
                                <th className="px-3 py-2">Source</th>
                                <th className="px-3 py-2 w-16 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {filtered.length === 0 && debouncedSearch && (
                                <tr><td colSpan={6} className="px-3 py-4 text-center text-xs text-slate-500 italic">
                                    No org-custom matches{includePlatform ? ' — see platform results below.' : '. Tick "Include platform catalog" to also search the platform-wide catalog.'}
                                </td></tr>
                            )}
                            {filtered.length === 0 && !debouncedSearch && catalog.length === 0 && (
                                <tr><td colSpan={6} className="px-3 py-4 text-center text-xs text-slate-500 italic">
                                    No org-custom commodities.
                                </td></tr>
                            )}
                            {filtered.map((c) => (
                                <tr key={`custom-${c.id}`} className={`hover:bg-white/5 ${c.archivedAt ? 'opacity-50' : ''}`}>
                                    <td className="px-3 py-2 text-white truncate max-w-xs">{c.name}</td>
                                    <td className="px-3 py-2 text-slate-400 text-xs font-mono">{c.qualityLabel || '—'}</td>
                                    <td className="px-3 py-2 text-cyan-300 text-xs uppercase tracking-widest">{CATEGORY_LABEL[c.category]}</td>
                                    <td className="px-3 py-2 text-slate-400 text-xs font-mono">{c.unit}</td>
                                    <td className="px-3 py-2">
                                        <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                                            custom
                                        </span>
                                        {c.archivedAt && (
                                            <span className="ml-2 text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-amber-500/10 text-amber-300 border-amber-500/30">
                                                archived
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {canAdmin && (
                                            <button onClick={() => onEdit(c)}
                                                className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 hover:text-cyan-200">
                                                Edit →
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {includePlatform && debouncedSearch && (
                        <>
                            <div className="px-3 py-2 bg-black/20 border-t border-white/5 text-[10px] font-mono uppercase tracking-widest text-slate-500 flex items-center gap-2">
                                <i className="fa-solid fa-globe text-slate-600" />
                                From platform catalog
                                {platformLoading && <i className="fa-solid fa-spinner animate-spin text-slate-500" />}
                            </div>
                            <table className="w-full text-left text-sm">
                                <tbody className="divide-y divide-white/5">
                                    {platformError && (
                                        <tr><td colSpan={6} className="px-3 py-4 text-center text-xs text-rose-400">{platformError}</td></tr>
                                    )}
                                    {!platformLoading && !platformError && platformResults.length === 0 && (
                                        <tr><td colSpan={6} className="px-3 py-4 text-center text-xs text-slate-500 italic">No platform matches.</td></tr>
                                    )}
                                    {platformResults.map((p) => (
                                        <tr key={`platform-${p.id}`} className="hover:bg-white/5">
                                            <td className="px-3 py-2 text-white truncate max-w-xs">{p.name}</td>
                                            <td className="px-3 py-2 text-slate-600 text-xs font-mono">—</td>
                                            <td className="px-3 py-2 text-slate-400 text-xs uppercase tracking-widest">{p.category || '—'}</td>
                                            <td className="px-3 py-2 text-slate-600 text-xs font-mono">—</td>
                                            <td className="px-3 py-2">
                                                <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-slate-700/40 text-slate-300 border-slate-500/30">
                                                    platform
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-right text-slate-700">
                                                {/* Platform (catalog reference) rows are read-only. */}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </>
                    )}
                </div>
            )}

            <WhCatalogImportExportModal
                isOpen={importExportOpen}
                onClose={() => setImportExportOpen(false)}
                onImported={() => onCatalogChanged?.()}
            />
        </div>
    );
}
