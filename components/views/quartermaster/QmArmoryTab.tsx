import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import type { QmInventoryItem, QmLocation, QmCatalogCategory } from '../../../types';
import { ACCENTS, AccentKey } from '../../shared/ui/accents';
import { SkeletonCardGrid } from '../../shared/ui/Skeleton';
import AdjustStockDialog from './AdjustStockDialog';
import { useNotification } from '../../../contexts/NotificationContext';

const CATEGORY_ACCENT: Record<QmCatalogCategory, AccentKey> = {
    weapon: 'rose',
    armor: 'sky',
    component: 'cyan',
    consumable: 'emerald',
    misc: 'slate',
};

const PAGE_SIZE = 60;

interface Props {
    locations: QmLocation[];
    canManage: boolean;
    canRequest: boolean;
    onIssue?: (item: QmInventoryItem) => void;
    onCreate?: () => void;
    /** Bumped by parent to force a re-fetch (e.g. after a sibling action edited inventory). */
    refreshKey?: number;
}

export default function QmArmoryTab({ locations, canManage, canRequest, onIssue, onCreate, refreshKey }: Props) {
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const [categoryFilter, setCategoryFilter] = useState<'all' | QmCatalogCategory>('all');
    const [locationFilter, setLocationFilter] = useState<'all' | number>('all');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const debouncedSearch = useDebouncedValue(search.trim(), 300);

    const [items, setItems] = useState<QmInventoryItem[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

    const [adjustTarget, setAdjustTarget] = useState<QmInventoryItem | null>(null);

    const requestSeqRef = useRef(0);

    // Server-side: location only (catalog category isn't a column on inventory;
    // we still client-filter by category over the visible page).
    const filterPayload = useMemo(() => ({
        locationId: locationFilter === 'all' ? null : locationFilter,
        search: debouncedSearch || undefined,
        includeArchived: false,
    }), [locationFilter, debouncedSearch]);

    const loadCount = useCallback(async () => {
        try {
            const c = await rpcAction('qm:count_inventory', filterPayload);
            if (typeof c === 'number') setTotalCount(c);
        } catch { /* non-fatal */ }
    }, [rpcAction, filterPayload]);

    const load = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        setLoading(true);
        try {
            const r = await rpcAction('qm:list_inventory', {
                ...filterPayload,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (seq !== requestSeqRef.current) return;
            setItems(Array.isArray(r) ? r : []);
            setHasLoadedOnce(true);
        } catch (err: any) {
            if (seq !== requestSeqRef.current) return;
            addToast('Failed to load inventory', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [rpcAction, filterPayload, page, addToast]);

    // Reset page when filter changes (skip first mount).
    const isFirstFilterChangeRef = useRef(true);
    useEffect(() => {
        if (isFirstFilterChangeRef.current) { isFirstFilterChangeRef.current = false; return; }
        setPage(0);
    }, [filterPayload]);

    // Data-fetch effects. The async work runs in an inner async function (the
    // React idiom for awaiting inside an effect, since the effect callback can't
    // itself be async). load()'s synchronous setLoading(true) still fires during
    // commit exactly as before, and the result sets stay on the awaited path —
    // behaviour is identical to a bare load()/loadCount() call.
    useEffect(() => {
        void (async () => { await load(); })();
    }, [load, refreshKey]);
    useEffect(() => {
        void (async () => { await loadCount(); })();
    }, [loadCount, refreshKey]);

    const requestItem = async (item: QmInventoryItem) => {
        const qtyStr = window.prompt(`Request how many of "${item.catalog?.name || item.customName}"?`, '1');
        if (qtyStr === null) return;
        const qty = parseInt(qtyStr, 10);
        if (!Number.isFinite(qty) || qty <= 0) {
            addToast('Invalid quantity', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50');
            return;
        }
        const notes = window.prompt('Notes / reason for this request (optional):', '') || undefined;
        try {
            await rpcAction('qm:request_issuance', { inventoryId: item.id, quantity: qty, notes });
            addToast('Request submitted', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50', {
                description: 'An officer will fulfil the request.',
            });
            load();
        } catch (err: any) {
            addToast('Request failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        }
    };

    const exportCsv = async () => {
        try {
            const res = await rpcAction('qm:export_csv', {});
            const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = res.filename || 'inventory.csv';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            addToast('Export failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        }
    };

    // Client-side filter by category (catalog.category isn't on the inventory
    // row; the join is in the response).
    const visible = useMemo(() => {
        if (categoryFilter === 'all') return items;
        return items.filter((it) => (it.catalog?.category || 'misc') === categoryFilter);
    }, [items, categoryFilter]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 bg-slate-900 rounded-lg border border-white/10 p-1 overflow-x-auto custom-scrollbar max-w-full">
                    {(['all', 'weapon', 'armor', 'component', 'consumable', 'misc'] as const).map((cat) => (
                        <button
                            key={cat}
                            onClick={() => setCategoryFilter(cat)}
                            className={`shrink-0 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest transition whitespace-nowrap ${
                                categoryFilter === cat ? 'bg-orange-500/20 text-orange-200' : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            {cat}
                        </button>
                    ))}
                </div>

                <select
                    value={locationFilter}
                    onChange={(e) => setLocationFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                    className="bg-slate-900 border border-white/10 rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-300"
                >
                    <option value="all">All locations</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>

                <input
                    type="text"
                    placeholder="Search…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="bg-slate-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500"
                />

                <div className="flex-1" />
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{totalCount} total · page {page + 1}/{totalPages}</span>
                <button
                    onClick={exportCsv}
                    className="inline-flex items-center gap-2 bg-slate-900 border border-white/10 hover:border-orange-500/40 text-slate-300 hover:text-orange-200 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition"
                >
                    <i className="fa-solid fa-file-csv" /> Export CSV
                </button>
                {onCreate && (
                    <button
                        onClick={onCreate}
                        className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition"
                    >
                        <i className="fa-solid fa-plus" /> Add Stock
                    </button>
                )}
            </div>

            {loading && !hasLoadedOnce ? (
                <SkeletonCardGrid count={9} accent="orange" />
            ) : visible.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 p-10 text-center text-slate-500 text-sm">
                    {totalCount === 0 ? 'No inventory yet. Use "Add Stock" to record some.' : 'No items match the current filters.'}
                </div>
            ) : (
                <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 ${loading ? 'opacity-60 transition-opacity' : ''}`}>
                    {visible.map((it) => {
                        const cat: QmCatalogCategory = (it.catalog?.category as QmCatalogCategory) || 'misc';
                        const a = ACCENTS[CATEGORY_ACCENT[cat]];
                        const name = it.catalog?.name || it.customName || 'Unnamed';
                        const lowStock = it.quantityOnHand === 0;
                        return (
                            <div
                                key={it.id}
                                className={`relative rounded-lg border ${a.border} bg-slate-900/40 overflow-hidden flex`}
                            >
                                <div className={`w-1 shrink-0 ${a.dot}`} aria-hidden />
                                <div className="flex-1 p-4 flex flex-col min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`text-[10px] font-bold uppercase tracking-widest ${a.text}`}>
                                            {cat}
                                        </span>
                                        {it.catalog?.subcategory && (
                                            <span className="text-[10px] font-mono text-slate-500">· {it.catalog.subcategory}</span>
                                        )}
                                    </div>
                                    <div className="text-sm font-bold text-white truncate mb-1">{name}</div>
                                    {it.location && (
                                        <div className="text-[11px] text-slate-500 truncate mb-2 flex items-center gap-1">
                                            <i className="fa-solid fa-location-dot text-[10px]" /> {it.location.name}
                                        </div>
                                    )}
                                    <div className="flex items-baseline gap-3 mt-1">
                                        <div>
                                            <div className={`text-2xl font-black font-mono ${lowStock ? 'text-rose-300' : 'text-white'}`}>
                                                {it.quantityOnHand}
                                            </div>
                                            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">On hand</div>
                                        </div>
                                        {it.quantityOnIssue > 0 && (
                                            <div>
                                                <div className="text-lg font-bold font-mono text-sky-300">{it.quantityOnIssue}</div>
                                                <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">On issue</div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1" />
                                    <div className="flex items-center gap-2 pt-3 mt-3 border-t border-white/5">
                                        {it.condition !== 'pristine' && (
                                            <span className="text-[10px] font-mono uppercase tracking-widest text-amber-400">
                                                {it.condition}
                                            </span>
                                        )}
                                        <div className="flex-1" />
                                        {canManage && (
                                            <button
                                                onClick={() => setAdjustTarget(it)}
                                                className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-orange-200"
                                                title="Adjust stock"
                                            >
                                                <i className="fa-solid fa-sliders mr-1" />Adjust
                                            </button>
                                        )}
                                        {canManage && onIssue && it.quantityOnHand > 0 && (
                                            <button
                                                onClick={() => onIssue(it)}
                                                className="text-[10px] font-bold uppercase tracking-widest text-orange-300 hover:text-orange-200"
                                            >
                                                Issue →
                                            </button>
                                        )}
                                        {!canManage && canRequest && it.quantityOnHand > 0 && (
                                            <button
                                                onClick={() => requestItem(it)}
                                                className="text-[10px] font-bold uppercase tracking-widest text-orange-300 hover:text-orange-200"
                                            >
                                                Request →
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {totalCount > PAGE_SIZE && (
                <div className="flex justify-end items-center gap-2 text-xs text-slate-400">
                    <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                        className="px-3 py-1.5 bg-slate-800 border border-white/10 rounded-sm text-xs font-bold disabled:opacity-30 hover:bg-slate-700">
                        <i className="fa-solid fa-chevron-left mr-1" /> Prev
                    </button>
                    <span>Page {page + 1} / {totalPages}</span>
                    <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1}
                        className="px-3 py-1.5 bg-slate-800 border border-white/10 rounded-sm text-xs font-bold disabled:opacity-30 hover:bg-slate-700">
                        Next <i className="fa-solid fa-chevron-right ml-1" />
                    </button>
                </div>
            )}

            <AdjustStockDialog
                isOpen={adjustTarget !== null}
                inventory={adjustTarget}
                onClose={() => setAdjustTarget(null)}
                onSubmitted={() => { setAdjustTarget(null); load(); loadCount(); }}
            />
        </div>
    );
}
