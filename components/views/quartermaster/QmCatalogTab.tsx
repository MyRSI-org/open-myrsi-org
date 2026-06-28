import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import type { QmCatalogItem, QmCatalogCategory } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';

const CATEGORY_OPTIONS: QmCatalogCategory[] = ['weapon', 'armor', 'component', 'consumable', 'misc'];

interface Props {
    /** Org-custom rows only (per the lazy-load redesign — listCatalog no longer
     *  returns platform rows). Platform rows are reached via search. */
    catalog: QmCatalogItem[];
    canAdmin: boolean;
    onRefresh: () => void;
}

export default function QmCatalogTab({ catalog, canAdmin, onRefresh }: Props) {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();

    const [showAddForm, setShowAddForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [newCategory, setNewCategory] = useState<QmCatalogCategory>('weapon');
    const [newSubcategory, setNewSubcategory] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const [search, setSearch] = useState('');
    const [includePlatform, setIncludePlatform] = useState(false);
    const debouncedSearch = useDebouncedValue(search.trim(), 300);

    // Server-side platform results (only fetched when checkbox is on AND query is non-empty).
    const [platformResults, setPlatformResults] = useState<QmCatalogItem[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const requestSeqRef = useRef(0);

    // Drive the synchronous parts of the platform search during render with a
    // previous-key tracker (the React-documented "adjust state during render"
    // pattern; React re-renders before paint, so it is equivalent to the old
    // synchronous effect sets without firing the set-state-in-effect rule):
    //   - search switched off / query cleared -> clear stale results, loading, error
    //   - new query -> begin loading, clear prior error
    // The effect below keeps only the async fetch and its async result sets.
    const platformSearchActive = includePlatform && debouncedSearch ? debouncedSearch : null;
    const [prevPlatformSearchActive, setPrevPlatformSearchActive] = useState<string | null>(platformSearchActive);
    if (platformSearchActive !== prevPlatformSearchActive) {
        setPrevPlatformSearchActive(platformSearchActive);
        if (platformSearchActive === null) {
            setPlatformResults([]);
            setSearchLoading(false);
            setSearchError(null);
        } else {
            setSearchLoading(true);
            setSearchError(null);
        }
    }

    useEffect(() => {
        if (!includePlatform || !debouncedSearch) return;
        const seq = ++requestSeqRef.current;
        rpcAction('qm:search_catalog', { query: debouncedSearch, source: 'platform', limit: 100 })
            .then((rows: any) => {
                if (seq !== requestSeqRef.current) return;
                setPlatformResults(Array.isArray(rows) ? rows : []);
            })
            .catch((err: any) => {
                if (seq !== requestSeqRef.current) return;
                setSearchError(err?.message || 'Search failed');
                setPlatformResults([]);
            })
            .finally(() => {
                if (seq === requestSeqRef.current) setSearchLoading(false);
            });
    }, [debouncedSearch, includePlatform, rpcAction]);

    const customFiltered = useMemo(() => {
        const q = debouncedSearch.toLowerCase();
        const rows = q
            ? catalog.filter((c) => c.name.toLowerCase().includes(q) || (c.subcategory || '').toLowerCase().includes(q))
            : catalog;
        return [...rows].sort((a, b) => {
            const cat = a.category.localeCompare(b.category);
            if (cat !== 0) return cat;
            return a.name.localeCompare(b.name);
        });
    }, [catalog, debouncedSearch]);

    const createItem = async () => {
        if (!newName.trim() || submitting) return;
        setSubmitting(true);
        try {
            await rpcAction('qm:create_catalog_item', {
                name: newName.trim(),
                category: newCategory,
                subcategory: newSubcategory.trim() || undefined,
            });
            setNewName('');
            setNewSubcategory('');
            setShowAddForm(false);
            addToast('Catalog item added', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onRefresh();
        } catch (err: any) {
            addToast('Create failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        } finally {
            setSubmitting(false);
        }
    };

    const removeItem = async (item: QmCatalogItem) => {
        const ok = await confirm({
            title: `Delete "${item.name}"?`,
            message: 'Existing inventory rows referencing this item will have their catalog link cleared but will keep their custom name and history.',
            confirmText: 'Delete',
            variant: 'warning',
        });
        if (!ok) return;
        try {
            await rpcAction('qm:delete_catalog_item', { catalogId: item.id });
            addToast('Catalog item deleted', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onRefresh();
        } catch (err: any) {
            addToast('Delete failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        }
    };

    const customCount = catalog.length;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-widest">Catalog</h2>
                    <p className="text-[11px] text-slate-500 font-mono uppercase tracking-widest mt-0.5">
                        {customCount} custom · platform: search to browse
                    </p>
                </div>
                {canAdmin && (
                    <button
                        onClick={() => setShowAddForm((v) => !v)}
                        className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white px-4 py-2 rounded-lg font-bold uppercase tracking-widest text-[11px] transition-all"
                    >
                        <i className={`fa-solid ${showAddForm ? 'fa-xmark' : 'fa-plus'}`} /> {showAddForm ? 'Cancel' : 'New Item'}
                    </button>
                )}
            </div>

            {showAddForm && canAdmin && (
                <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <input
                            type="text"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder="Item name (e.g. P4-AR Rifle)"
                            maxLength={100}
                            className="bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white sm:col-span-2"
                        />
                        <select
                            value={newCategory}
                            onChange={(e) => setNewCategory(e.target.value as QmCatalogCategory)}
                            className="bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                        >
                            {CATEGORY_OPTIONS.map((c) => (
                                <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
                            ))}
                        </select>
                    </div>
                    <input
                        type="text"
                        value={newSubcategory}
                        onChange={(e) => setNewSubcategory(e.target.value)}
                        placeholder="Subcategory (optional, e.g. Rifle, Heavy Armor)"
                        maxLength={80}
                        className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                    />
                    <div className="flex justify-end">
                        <button
                            onClick={createItem}
                            disabled={!newName.trim() || submitting}
                            className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {submitting ? 'Adding…' : 'Add to Catalog'}
                        </button>
                    </div>
                </div>
            )}

            <div className="rounded-xl border border-white/10 bg-slate-900/30 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="relative flex-1">
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search catalog by name or subcategory…"
                        className="w-full bg-slate-900 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-hidden focus:border-orange-500/40"
                    />
                    <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs" />
                </div>
                <label className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-400 cursor-pointer select-none whitespace-nowrap">
                    <input
                        type="checkbox"
                        checked={includePlatform}
                        onChange={(e) => setIncludePlatform(e.target.checked)}
                        className="accent-orange-500"
                    />
                    Include platform catalog
                </label>
            </div>

            {catalog.length === 0 && !debouncedSearch ? (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 p-10 text-center text-slate-500 text-sm">
                    No org-custom catalog items yet. {canAdmin && 'Click "New Item" to add one, or use the search above with "Include platform catalog" to browse the platform-wide catalog.'}
                </div>
            ) : (
                <div className="rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-black/30 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            <tr>
                                <th className="px-3 py-2">Name</th>
                                <th className="px-3 py-2">Category</th>
                                <th className="px-3 py-2">Subcategory</th>
                                <th className="px-3 py-2">Source</th>
                                <th className="px-3 py-2 w-16 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {customFiltered.length === 0 && debouncedSearch && (
                                <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-slate-500 italic">
                                    No org-custom matches{includePlatform ? ' — see platform results below.' : '. Tick "Include platform catalog" to also search the platform-wide catalog.'}
                                </td></tr>
                            )}
                            {customFiltered.length === 0 && !debouncedSearch && catalog.length === 0 && (
                                <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-slate-500 italic">
                                    No org-custom items.
                                </td></tr>
                            )}
                            {customFiltered.map((item) => (
                                <tr key={`custom-${item.id}`} className="hover:bg-white/5">
                                    <td className="px-3 py-2 text-white truncate max-w-xs">{item.name}</td>
                                    <td className="px-3 py-2 text-slate-400 text-xs uppercase">{item.category}</td>
                                    <td className="px-3 py-2 text-slate-500 text-xs truncate max-w-xs">{item.subcategory || '—'}</td>
                                    <td className="px-3 py-2">
                                        <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-orange-500/10 text-orange-300 border-orange-500/30">
                                            custom
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {canAdmin && (
                                            <button
                                                onClick={() => removeItem(item)}
                                                className="text-slate-500 hover:text-rose-400 text-xs"
                                                aria-label="Delete"
                                            >
                                                <i className="fa-solid fa-trash" />
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
                                {searchLoading && <i className="fa-solid fa-spinner animate-spin text-slate-500" />}
                            </div>
                            <table className="w-full text-left text-sm">
                                <tbody className="divide-y divide-white/5">
                                    {searchError && (
                                        <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-rose-400">{searchError}</td></tr>
                                    )}
                                    {!searchLoading && !searchError && platformResults.length === 0 && (
                                        <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-slate-500 italic">No platform matches.</td></tr>
                                    )}
                                    {platformResults.map((item) => (
                                        <tr key={`platform-${item.id}`} className="hover:bg-white/5">
                                            <td className="px-3 py-2 text-white truncate max-w-xs">{item.name}</td>
                                            <td className="px-3 py-2 text-slate-400 text-xs uppercase">{item.category}</td>
                                            <td className="px-3 py-2 text-slate-500 text-xs truncate max-w-xs">{item.subcategory || '—'}</td>
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
        </div>
    );
}
