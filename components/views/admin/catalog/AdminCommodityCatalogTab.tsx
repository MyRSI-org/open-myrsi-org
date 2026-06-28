import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useData } from '../../../../contexts/DataContext';
import { useNotification } from '../../../../contexts/NotificationContext';
import { useDebouncedValue } from '../../../../hooks/useDebouncedValue';
import { WarehousePlatformCommodityWithUsage, WarehousePlatformCategory, ToastVariant } from '../../../../types';

const PAGE_SIZE = 50;

const FLAG_FIELDS: Array<{ key: keyof WarehousePlatformCommodityWithUsage; label: string }> = [
    { key: 'isAvailable', label: 'Available' },
    { key: 'isAvailableLive', label: 'Live' },
    { key: 'isVisible', label: 'Visible' },
    { key: 'isExtractable', label: 'Extractable' },
    { key: 'isMineral', label: 'Mineral' },
    { key: 'isRaw', label: 'Raw' },
    { key: 'isPure', label: 'Pure' },
    { key: 'isRefined', label: 'Refined' },
    { key: 'isRefinable', label: 'Refinable' },
    { key: 'isHarvestable', label: 'Harvestable' },
    { key: 'isBuyable', label: 'Buyable' },
    { key: 'isSellable', label: 'Sellable' },
    { key: 'isTemporary', label: 'Temporary' },
    { key: 'isIllegal', label: 'Illegal' },
    { key: 'isVolatileQt', label: 'Volatile (QT)' },
    { key: 'isVolatileTime', label: 'Volatile (Time)' },
    { key: 'isInert', label: 'Inert' },
    { key: 'isExplosive', label: 'Explosive' },
    { key: 'isBuggy', label: 'Buggy' },
    { key: 'isFuel', label: 'Fuel' },
];

// camelCase -> snake_case for the RPC payload (the server's pickAllowedFields uses snake_case keys)
const FIELD_TO_DB: Record<string, string> = {
    name: 'name', code: 'code', kind: 'kind',
    weightScu: 'weight_scu', priceBuy: 'price_buy', priceSell: 'price_sell',
    isAvailable: 'is_available', isAvailableLive: 'is_available_live', isVisible: 'is_visible',
    isExtractable: 'is_extractable', isMineral: 'is_mineral', isRaw: 'is_raw', isPure: 'is_pure',
    isRefined: 'is_refined', isRefinable: 'is_refinable', isHarvestable: 'is_harvestable',
    isBuyable: 'is_buyable', isSellable: 'is_sellable', isTemporary: 'is_temporary',
    isIllegal: 'is_illegal', isVolatileQt: 'is_volatile_qt', isVolatileTime: 'is_volatile_time',
    isInert: 'is_inert', isExplosive: 'is_explosive', isBuggy: 'is_buggy', isFuel: 'is_fuel',
    wikiUrl: 'wiki_url', platformCategoryId: 'platform_category_id',
};

// Dashboard toast shim — maps the old portal addPortalToast(msg, type) signature
// onto the dashboard's addToast(message, icon, className, options) surface.
type ToastFn = (message: string, type?: 'error' | 'success' | 'warning' | 'info') => void;

export default function AdminCommodityCatalogTab() {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const toast = useCallback<ToastFn>((message, type = 'info') => {
        addToast(message, null, '', { variant: type as ToastVariant });
    }, [addToast]);

    // Filters
    const [search, setSearch] = useState('');
    const [filterCategoryId, setFilterCategoryId] = useState<string>('');
    const [filterIllegal, setFilterIllegal] = useState<'all' | 'legal' | 'illegal'>('all');
    const [page, setPage] = useState(0);
    const debouncedSearch = useDebouncedValue(search.trim(), 300);

    // Data — server-paginated
    const [commodities, setCommodities] = useState<WarehousePlatformCommodityWithUsage[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [loading, setLoading] = useState(false);

    const [editing, setEditing] = useState<WarehousePlatformCommodityWithUsage | null>(null);
    const [editForm, setEditForm] = useState<Record<string, any>>({});
    const [isSaving, setIsSaving] = useState(false);

    const [categories, setCategories] = useState<WarehousePlatformCategory[]>([]);
    const [showCategories, setShowCategories] = useState(false);
    const [syncLoading, setSyncLoading] = useState(false);

    const requestSeqRef = useRef(0);

    const loadCategories = useCallback(async () => {
        try {
            const cats = await rpcAction('catalog:list_commodity_categories', {});
            if (cats) setCategories(cats);
        } catch (e: any) {
            toast(`Failed to load categories: ${e?.message || 'unknown'}`, 'error');
        }
    }, [rpcAction, toast]);

    const filterPayload = useMemo(() => ({
        search: debouncedSearch || undefined,
        platformCategoryId: filterCategoryId ? Number(filterCategoryId) : undefined,
        illegalOnly: filterIllegal === 'illegal',
        legalOnly: filterIllegal === 'legal',
    }), [debouncedSearch, filterCategoryId, filterIllegal]);

    const loadCount = useCallback(async () => {
        try {
            const c = await rpcAction('catalog:count_commodities', filterPayload);
            if (typeof c === 'number') setTotalCount(c);
        } catch {
            // non-fatal
        }
    }, [rpcAction, filterPayload]);

    const load = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        setLoading(true);
        try {
            const r = await rpcAction('catalog:list_commodities', {
                ...filterPayload,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (seq !== requestSeqRef.current) return;
            setCommodities(Array.isArray(r) ? r : []);
        } catch (e: any) {
            if (seq !== requestSeqRef.current) return;
            toast(`Failed to load commodities: ${e?.message || 'unknown'}`, 'error');
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [rpcAction, filterPayload, page, toast]);

    // Reset page when filters change (skipping first mount)
    const isFirstFilterChangeRef = useRef(true);
    useEffect(() => {
        if (isFirstFilterChangeRef.current) { isFirstFilterChangeRef.current = false; return; }
        setPage(0);
    }, [filterPayload]);

    // These effects synchronize React state with the server (an external system), which is
    // exactly what effects are for. The fetch is invoked inside an async IIFE so its setStates
    // resolve on the await continuation; load()'s synchronous setLoading(true) still runs in the
    // same tick (the IIFE body executes synchronously up to its first await), so behavior and
    // timing are unchanged — the helpers' own requestSeqRef guards still drop stale responses.
    useEffect(() => { void (async () => { await loadCategories(); })(); }, [loadCategories]);
    useEffect(() => { void (async () => { await load(); })(); }, [load]);
    useEffect(() => { void (async () => { await loadCount(); })(); }, [loadCount]);

    const categoryById = useMemo(() => {
        const m = new Map<number, WarehousePlatformCategory>();
        for (const c of categories) m.set(c.id, c);
        return m;
    }, [categories]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const pageRows = commodities;

    const handleSync = useCallback(async () => {
        setSyncLoading(true);
        try {
            const res = await rpcAction('catalog:sync_commodities', {});
            toast(`Sync complete: ${res.commoditiesSynced} commodities, ${res.categoriesInserted} new + ${res.categoriesUpdated} updated categories, ${res.commodityErrors} errors`, res.commodityErrors > 0 ? 'warning' : 'success');
            await Promise.all([loadCategories(), loadCount(), load()]);
        } catch (e: any) {
            toast(`Sync failed: ${e?.message || 'unknown'}`, 'error');
        } finally {
            setSyncLoading(false);
        }
    }, [rpcAction, toast, loadCategories, loadCount, load]);

    const openEdit = (c: WarehousePlatformCommodityWithUsage) => {
        setEditing(c);
        setEditForm({ ...c });
    };

    const handleSave = async () => {
        if (!editing) return;
        setIsSaving(true);
        try {
            const updates: Record<string, any> = {};
            for (const [key, dbKey] of Object.entries(FIELD_TO_DB)) {
                if (editForm[key] !== (editing as any)[key]) updates[dbKey] = editForm[key];
            }
            if (Object.keys(updates).length === 0) {
                setEditing(null);
                return;
            }
            await rpcAction('catalog:update_commodity', { commodityId: editing.id, updates });
            setEditing(null);
            load();
            toast('Commodity updated', 'success');
        } catch (e: any) {
            toast(e?.message || 'Update failed', 'error');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (c: WarehousePlatformCommodityWithUsage) => {
        const ok = await confirm({ title: 'Delete Commodity', message: `Delete "${c.name}"? This cannot be undone.`, confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        try {
            await rpcAction('catalog:delete_commodity', { commodityId: c.id });
            await Promise.all([loadCount(), load()]);
            toast(`Deleted "${c.name}"`, 'success');
        } catch (e: any) {
            toast(e?.message || 'Delete failed', 'error');
        }
    };

    const inputClass = 'w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white focus:outline-hidden focus:border-purple-500';
    const selectClass = 'bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-hidden focus:border-purple-500';
    const labelClass = 'block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1';

    return (
        <div className="animate-fade-in-up p-4 md:p-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                <div>
                    <h2 className="text-2xl font-black text-white flex items-center gap-3">
                        <i className="fa-solid fa-flask text-purple-400"></i>
                        Commodity Catalog
                        <span className="text-sm font-bold text-slate-500 bg-slate-800 px-2 py-0.5 rounded-sm">{totalCount}</span>
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">Platform-wide commodity database synced from uexcorp.space.</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowCategories(v => !v)}
                        className="flex items-center gap-2 bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all"
                    >
                        <i className={`fa-solid fa-tags`}></i> Categories ({categories.length})
                    </button>
                    <button
                        onClick={handleSync}
                        disabled={syncLoading}
                        className="flex items-center gap-2 bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                    >
                        {syncLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-arrows-rotate"></i>}
                        {syncLoading ? 'Syncing...' : 'Sync from UEX'}
                    </button>
                </div>
            </div>

            {/* Stats — total comes from server count; category count from local list */}
            <div className="grid grid-cols-2 md:grid-cols-2 gap-3 mb-6">
                <div className="bg-slate-900 border border-white/10 rounded-xl p-4 text-center">
                    <i className="fa-solid fa-database text-purple-400 text-lg mb-1"></i>
                    <p className="text-xl font-black text-white">{totalCount}</p>
                    <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Matching Commodities</p>
                </div>
                <div className="bg-slate-900 border border-white/10 rounded-xl p-4 text-center">
                    <i className="fa-solid fa-tags text-sky-400 text-lg mb-1"></i>
                    <p className="text-xl font-black text-white">{categories.length}</p>
                    <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Categories</p>
                </div>
            </div>

            {/* Categories sub-section */}
            {showCategories && (
                <CategoryEditor
                    categories={categories}
                    rpcUpdate="catalog:update_commodity_category"
                    rpcDelete="catalog:delete_commodity_category"
                    onChanged={loadCategories}
                    rpcAction={rpcAction}
                    toast={toast}
                    confirm={confirm}
                />
            )}

            {/* Filters */}
            <div className="bg-slate-900 border border-white/10 rounded-xl p-4 mb-6">
                <div className="flex flex-col lg:flex-row gap-3 items-end">
                    <div className="flex-1 w-full relative">
                        <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-600"></i>
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by name, kind, code…"
                            className="w-full bg-black/30 border border-white/10 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-hidden focus:border-purple-500"
                        />
                    </div>
                    <select value={filterCategoryId} onChange={(e) => setFilterCategoryId(e.target.value)} className={selectClass}>
                        <option value="">All Categories</option>
                        {categories.map(c => <option key={c.id} value={c.id}>{c.displayName}{c.isHidden ? ' (hidden)' : ''}</option>)}
                    </select>
                    <select value={filterIllegal} onChange={(e) => setFilterIllegal(e.target.value as any)} className={selectClass}>
                        <option value="all">Legal & Illegal</option>
                        <option value="legal">Legal Only</option>
                        <option value="illegal">Illegal Only</option>
                    </select>
                </div>
                <p className="text-[10px] text-slate-600 mt-2">{totalCount} commodities match · showing {pageRows.length} on this page</p>
            </div>

            {/* Table */}
            <div className="bg-slate-900 border border-white/10 rounded-xl overflow-hidden mb-6">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-black/30 text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-white/5">
                            <tr>
                                <th className="p-3">Name</th>
                                <th className="p-3">Kind</th>
                                <th className="p-3">Category</th>
                                <th className="p-3 text-right">SCU</th>
                                <th className="p-3 text-right">Buy</th>
                                <th className="p-3 text-right">Sell</th>
                                <th className="p-3">Flags</th>
                                <th className="p-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading && (
                                <tr><td colSpan={8} className="px-3 py-6 text-center text-xs text-slate-500"><i className="fa-solid fa-spinner animate-spin mr-2" />Loading…</td></tr>
                            )}
                            {!loading && pageRows.length === 0 && (
                                <tr><td colSpan={8} className="px-3 py-12 text-center text-sm text-slate-600">
                                    <i className="fa-solid fa-flask text-3xl mb-3 opacity-30 block"></i>
                                    {totalCount === 0 ? 'The catalog is empty. Click "Sync from UEX" to populate.' : 'No commodities match the current filters.'}
                                </td></tr>
                            )}
                            {!loading && pageRows.map(c => {
                                const cat = c.platformCategoryId != null ? categoryById.get(c.platformCategoryId) : null;
                                return (
                                    <tr key={c.id} className="hover:bg-white/5 transition-colors">
                                        <td className="p-3 font-bold text-white">{c.name}{c.code ? <span className="text-[10px] text-slate-600 ml-2 font-mono">[{c.code}]</span> : null}</td>
                                        <td className="p-3 text-slate-400 text-xs">{c.kind || '-'}</td>
                                        <td className="p-3 text-slate-400 text-xs">{cat?.displayName || '-'}</td>
                                        <td className="p-3 text-right text-slate-400 font-mono text-xs">{c.weightScu ?? '-'}</td>
                                        <td className="p-3 text-right text-slate-400 font-mono text-xs">{c.priceBuy != null ? c.priceBuy.toLocaleString() : '-'}</td>
                                        <td className="p-3 text-right text-slate-400 font-mono text-xs">{c.priceSell != null ? c.priceSell.toLocaleString() : '-'}</td>
                                        <td className="p-3">
                                            <div className="flex gap-1 flex-wrap">
                                                {c.isIllegal && <span className="bg-red-500/10 text-red-400 border border-red-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm">illegal</span>}
                                                {c.isFuel && <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm">fuel</span>}
                                                {c.isExtractable && <span className="bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm">mining</span>}
                                                {!c.isAvailableLive && <span className="bg-slate-500/10 text-slate-400 border border-slate-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm">not live</span>}
                                            </div>
                                        </td>
                                        <td className="p-3 text-right">
                                            <div className="flex justify-end gap-1">
                                                <button onClick={() => openEdit(c)} className="p-1.5 text-purple-400 hover:bg-purple-500/10 rounded-sm transition-colors" title="Edit">
                                                    <i className="fa-solid fa-pen-to-square"></i>
                                                </button>
                                                <button onClick={() => handleDelete(c)} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-sm transition-colors" title="Delete">
                                                    <i className="fa-solid fa-trash-can"></i>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination */}
            <div className="flex justify-between items-center text-sm text-slate-400 mb-8">
                <p className="text-xs">Page {page + 1} of {totalPages} · {totalCount} total</p>
                <div className="flex gap-2">
                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1.5 bg-slate-800 border border-white/10 rounded-sm text-xs font-bold disabled:opacity-30 hover:bg-slate-700">
                        <i className="fa-solid fa-chevron-left mr-1"></i> Prev
                    </button>
                    <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1} className="px-3 py-1.5 bg-slate-800 border border-white/10 rounded-sm text-xs font-bold disabled:opacity-30 hover:bg-slate-700">
                        Next <i className="fa-solid fa-chevron-right ml-1"></i>
                    </button>
                </div>
            </div>

            {/* Edit Modal */}
            {editing && (
                <div className="fixed inset-0 z-150 bg-black/90 backdrop-blur-sm flex items-start justify-center animate-fade-in overflow-y-auto p-4">
                    <div className="bg-slate-900 border border-purple-500/30 shadow-2xl shadow-purple-900/20 rounded-2xl max-w-3xl w-full my-8 relative">
                        <div className="absolute top-0 left-0 w-full h-1 bg-linear-to-r from-purple-500 to-pink-500 rounded-t-2xl"></div>

                        <div className="p-6 border-b border-white/10 flex justify-between items-center">
                            <div>
                                <h3 className="text-lg font-bold text-white">Edit Commodity</h3>
                                <p className="text-xs text-slate-500 mt-0.5">ID: {editing.id} | UEX: {editing.externalId} | Slug: {editing.slug}</p>
                            </div>
                            <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-white">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            {/* Basic Info */}
                            <div>
                                <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider mb-3">Basic Info</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <div>
                                        <label className={labelClass}>Name</label>
                                        <input value={editForm.name || ''} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>UEX Code</label>
                                        <input value={editForm.code || ''} onChange={(e) => setEditForm({ ...editForm, code: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Kind</label>
                                        <input value={editForm.kind || ''} onChange={(e) => setEditForm({ ...editForm, kind: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Platform Category</label>
                                        <select
                                            value={editForm.platformCategoryId ?? ''}
                                            onChange={(e) => setEditForm({ ...editForm, platformCategoryId: e.target.value ? Number(e.target.value) : null })}
                                            className={inputClass}
                                        >
                                            <option value="">- None -</option>
                                            {categories.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                                        </select>
                                    </div>
                                </div>
                            </div>

                            {/* Numerics */}
                            <div>
                                <h4 className="text-xs font-bold text-sky-400 uppercase tracking-wider mb-3">Pricing & Weight</h4>
                                <div className="grid grid-cols-3 gap-3">
                                    <div>
                                        <label className={labelClass}>Weight (SCU)</label>
                                        <input type="number" value={editForm.weightScu ?? ''} onChange={(e) => setEditForm({ ...editForm, weightScu: e.target.value === '' ? null : Number(e.target.value) })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Buy (avg/SCU)</label>
                                        <input type="number" value={editForm.priceBuy ?? ''} onChange={(e) => setEditForm({ ...editForm, priceBuy: e.target.value === '' ? null : Number(e.target.value) })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Sell (avg/SCU)</label>
                                        <input type="number" value={editForm.priceSell ?? ''} onChange={(e) => setEditForm({ ...editForm, priceSell: e.target.value === '' ? null : Number(e.target.value) })} className={inputClass} />
                                    </div>
                                </div>
                            </div>

                            {/* Flags */}
                            <div>
                                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-3">Classification Flags</h4>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                    {FLAG_FIELDS.map(f => (
                                        <label key={String(f.key)} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!editForm[f.key as string]}
                                                onChange={(e) => setEditForm({ ...editForm, [f.key as string]: e.target.checked })}
                                                className="accent-purple-500"
                                            />
                                            {f.label}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {/* Wiki */}
                            <div>
                                <label className={labelClass}>Wiki URL</label>
                                <input value={editForm.wikiUrl || ''} onChange={(e) => setEditForm({ ...editForm, wikiUrl: e.target.value })} className={inputClass} />
                            </div>
                        </div>

                        <div className="p-4 border-t border-white/10 flex justify-end gap-3">
                            <button onClick={() => setEditing(null)} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white">Cancel</button>
                            <button onClick={handleSave} disabled={isSaving} className="px-6 py-2 bg-purple-500/10 text-purple-400 border border-purple-500/50 hover:bg-purple-500/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50">
                                {isSaving ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Changes'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Shared category editor — used by both the commodities tab and the items tab.
// Takes rpcAction + toast/confirm as props so each tab can pass bound copies.

interface CategoryEditorProps<T extends { id: number; displayName: string; sortOrder: number; isHidden: boolean }> {
    categories: T[];
    rpcUpdate: string;
    rpcDelete: string;
    onChanged: () => void;
    rpcAction: (action: string, payload: any) => Promise<any>;
    toast: (message: string, type?: 'error' | 'success' | 'warning' | 'info') => void;
    confirm: (opts: { title: string; message: string; confirmText?: string; cancelText?: string; variant?: 'danger' | 'info' | 'warning' }) => Promise<boolean>;
}

function CategoryEditor<T extends { id: number; displayName: string; sortOrder: number; isHidden: boolean; uexKind?: string; uexCategoryName?: string }>({
    categories, rpcUpdate, rpcDelete, onChanged, rpcAction, toast, confirm
}: CategoryEditorProps<T>) {
    const [drafts, setDrafts] = useState<Record<number, { displayName?: string; sortOrder?: number; isHidden?: boolean }>>({});

    const handleSave = async (cat: T) => {
        const d = drafts[cat.id];
        if (!d) return;
        const updates: Record<string, any> = {};
        if (d.displayName !== undefined && d.displayName !== cat.displayName) updates.display_name = d.displayName;
        if (d.sortOrder !== undefined && d.sortOrder !== cat.sortOrder) updates.sort_order = d.sortOrder;
        if (d.isHidden !== undefined && d.isHidden !== cat.isHidden) updates.is_hidden = d.isHidden;
        if (!Object.keys(updates).length) return;
        try {
            await rpcAction(rpcUpdate, { id: cat.id, updates });
            toast(`Updated category "${updates.display_name || cat.displayName}"`, 'success');
            setDrafts(prev => { const next = { ...prev }; delete next[cat.id]; return next; });
            onChanged();
        } catch (e: any) {
            toast(e?.message || 'Update failed', 'error');
        }
    };

    const handleDelete = async (cat: T) => {
        const ok = await confirm({ title: 'Delete Category', message: `Delete category "${cat.displayName}"? This cannot be undone.`, confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        try {
            await rpcAction(rpcDelete, { id: cat.id });
            toast(`Deleted "${cat.displayName}"`, 'success');
            onChanged();
        } catch (e: any) {
            toast(e?.message || 'Delete failed', 'error');
        }
    };

    return (
        <div className="bg-slate-900 border border-purple-500/20 rounded-xl p-4 mb-6">
            <h3 className="text-xs font-black text-purple-300 uppercase tracking-widest mb-3">Platform Categories ({categories.length})</h3>
            <p className="text-[11px] text-slate-500 mb-3">Rename, reorder, or hide categories sourced from UEX. Original UEX names are preserved for reference; admin edits to display name are kept across re-syncs.</p>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-white/5">
                        <tr>
                            <th className="text-left py-2 px-2">UEX Source</th>
                            <th className="text-left py-2 px-2">Display Name</th>
                            <th className="text-left py-2 px-2 w-24">Sort</th>
                            <th className="text-left py-2 px-2 w-24">Hidden</th>
                            <th className="text-right py-2 px-2 w-28">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {categories.map(cat => {
                            const draft = drafts[cat.id] || {};
                            const dirty = (draft.displayName !== undefined && draft.displayName !== cat.displayName)
                                || (draft.sortOrder !== undefined && draft.sortOrder !== cat.sortOrder)
                                || (draft.isHidden !== undefined && draft.isHidden !== cat.isHidden);
                            return (
                                <tr key={cat.id}>
                                    <td className="py-2 px-2 text-xs text-slate-500 font-mono">{cat.uexCategoryName || cat.uexKind || '-'}</td>
                                    <td className="py-2 px-2">
                                        <input
                                            value={draft.displayName ?? cat.displayName}
                                            onChange={(e) => setDrafts(prev => ({ ...prev, [cat.id]: { ...prev[cat.id], displayName: e.target.value } }))}
                                            className="bg-black/30 border border-white/10 rounded-sm px-2 py-1 text-sm text-white w-full focus:outline-hidden focus:border-purple-500"
                                        />
                                    </td>
                                    <td className="py-2 px-2">
                                        <input
                                            type="number"
                                            value={draft.sortOrder ?? cat.sortOrder}
                                            onChange={(e) => setDrafts(prev => ({ ...prev, [cat.id]: { ...prev[cat.id], sortOrder: Number(e.target.value) } }))}
                                            className="bg-black/30 border border-white/10 rounded-sm px-2 py-1 text-sm text-white w-20 focus:outline-hidden focus:border-purple-500"
                                        />
                                    </td>
                                    <td className="py-2 px-2">
                                        <input
                                            type="checkbox"
                                            checked={draft.isHidden ?? cat.isHidden}
                                            onChange={(e) => setDrafts(prev => ({ ...prev, [cat.id]: { ...prev[cat.id], isHidden: e.target.checked } }))}
                                            className="accent-purple-500"
                                        />
                                    </td>
                                    <td className="py-2 px-2 text-right">
                                        <button
                                            onClick={() => handleSave(cat)}
                                            disabled={!dirty}
                                            className="text-[10px] font-bold uppercase text-purple-400 hover:text-purple-300 disabled:text-slate-700 disabled:cursor-not-allowed mr-2"
                                        >
                                            Save
                                        </button>
                                        <button onClick={() => handleDelete(cat)} className="text-[10px] font-bold uppercase text-red-400 hover:text-red-300">
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                        {categories.length === 0 && (
                            <tr><td colSpan={5} className="py-6 text-center text-slate-600 text-xs">No categories yet. Run sync first.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export { CategoryEditor };
