import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useData } from '../../../../contexts/DataContext';
import { useNotification } from '../../../../contexts/NotificationContext';
import { useDebouncedValue } from '../../../../hooks/useDebouncedValue';
import { QmPlatformItemWithUsage, QmPlatformCategory, ToastVariant } from '../../../../types';
import { CategoryEditor } from './AdminCommodityCatalogTab';

const PAGE_SIZE = 50;

const FIELD_TO_DB: Record<string, string> = {
    name: 'name', subcategory: 'subcategory',
    thumbnailUrl: 'thumbnail_url', wikiUrl: 'wiki_url',
    isVehicleItem: 'is_vehicle_item', isCommodity: 'is_commodity', isHarvestable: 'is_harvestable',
    screenshotUrl: 'screenshot_url', storeUrl: 'store_url',
    companyName: 'company_name', vehicleName: 'vehicle_name',
    quality: 'quality', sizeLabel: 'size_label', color: 'color', color2: 'color2',
    gameVersion: 'game_version', platformCategoryId: 'platform_category_id',
};

// Dashboard toast shim — maps the old portal addPortalToast(msg, type) signature
// onto the dashboard's addToast(message, icon, className, options) surface.
type ToastFn = (message: string, type?: 'error' | 'success' | 'warning' | 'info') => void;

export default function AdminItemCatalogTab() {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const toast = useCallback<ToastFn>((message, type = 'info') => {
        addToast(message, null, '', { variant: type as ToastVariant });
    }, [addToast]);

    // Filters
    const [search, setSearch] = useState('');
    const [filterCategoryId, setFilterCategoryId] = useState<string>('');
    const [hideVehicles, setHideVehicles] = useState(true);
    const [page, setPage] = useState(0);
    const debouncedSearch = useDebouncedValue(search.trim(), 300);

    // Data
    const [items, setItems] = useState<QmPlatformItemWithUsage[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [loading, setLoading] = useState(false);

    // Edit + sync state
    const [editing, setEditing] = useState<QmPlatformItemWithUsage | null>(null);
    const [editForm, setEditForm] = useState<Record<string, any>>({});
    const [isSaving, setIsSaving] = useState(false);

    const [categories, setCategories] = useState<QmPlatformCategory[]>([]);
    const [showCategories, setShowCategories] = useState(false);
    const [syncLoading, setSyncLoading] = useState(false);
    const [syncErrors, setSyncErrors] = useState<Array<{ categoryId: number; categoryName: string; message: string }>>([]);

    const requestSeqRef = useRef(0);

    const loadCategories = useCallback(async () => {
        try {
            const cats = await rpcAction('catalog:list_item_categories', {});
            if (cats) setCategories(cats);
        } catch (e: any) {
            toast(`Failed to load categories: ${e?.message || 'unknown'}`, 'error');
        }
    }, [rpcAction, toast]);

    const loadCount = useCallback(async () => {
        try {
            const c = await rpcAction('catalog:count_items', {
                search: debouncedSearch || undefined,
                platformCategoryId: filterCategoryId ? Number(filterCategoryId) : undefined,
                hideVehicleItems: hideVehicles,
            });
            if (typeof c === 'number') setTotalCount(c);
        } catch {
            // non-fatal — count is decorative
        }
    }, [rpcAction, debouncedSearch, filterCategoryId, hideVehicles]);

    const load = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        setLoading(true);
        try {
            const r = await rpcAction('catalog:list_items', {
                search: debouncedSearch || undefined,
                platformCategoryId: filterCategoryId ? Number(filterCategoryId) : undefined,
                hideVehicleItems: hideVehicles,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (seq !== requestSeqRef.current) return;
            setItems(Array.isArray(r) ? r : []);
        } catch (e: any) {
            if (seq !== requestSeqRef.current) return;
            toast(`Failed to load items: ${e?.message || 'unknown'}`, 'error');
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [rpcAction, debouncedSearch, filterCategoryId, hideVehicles, page, toast]);

    // Reset page when a non-page filter changes (skipping first mount).
    const isFirstFilterChangeRef = useRef(true);
    useEffect(() => {
        if (isFirstFilterChangeRef.current) { isFirstFilterChangeRef.current = false; return; }
        setPage(0);
    }, [debouncedSearch, filterCategoryId, hideVehicles]);

    // These effects synchronize React state with the server (an external system), which is
    // exactly what effects are for. The fetch is invoked inside an async IIFE so its setStates
    // resolve on the await continuation; load()'s synchronous setLoading(true) still runs in the
    // same tick (the IIFE body executes synchronously up to its first await), so behavior and
    // timing are unchanged — the helpers' own requestSeqRef guards still drop stale responses.
    useEffect(() => { void (async () => { await loadCategories(); })(); }, [loadCategories]);
    useEffect(() => { void (async () => { await load(); })(); }, [load]);
    useEffect(() => { void (async () => { await loadCount(); })(); }, [loadCount]);

    const categoryById = useMemo(() => {
        const m = new Map<number, QmPlatformCategory>();
        for (const c of categories) m.set(c.id, c);
        return m;
    }, [categories]);

    const handleSync = useCallback(async () => {
        setSyncLoading(true);
        setSyncErrors([]);
        try {
            const res = await rpcAction('catalog:sync_items', {});
            const errCount = (res.itemErrors || 0) + (res.fetchErrors?.length || 0);
            toast(
                `Sync complete: ${res.itemsSynced} items synced, ${res.itemsSkipped} skipped, ${res.categoriesInserted} new + ${res.categoriesUpdated} updated categories, ${errCount} errors`,
                errCount > 0 ? 'warning' : 'success'
            );
            if (res.fetchErrors?.length) setSyncErrors(res.fetchErrors);
            await Promise.all([loadCategories(), loadCount(), load()]);
        } catch (e: any) {
            toast(`Sync failed: ${e?.message || 'unknown'}`, 'error');
        } finally {
            setSyncLoading(false);
        }
    }, [rpcAction, toast, loadCategories, loadCount, load]);

    const openEdit = (item: QmPlatformItemWithUsage) => {
        setEditing(item);
        setEditForm({ ...item });
    };

    const handleSave = async () => {
        if (!editing) return;
        setIsSaving(true);
        try {
            const updates: Record<string, any> = {};
            for (const [key, dbKey] of Object.entries(FIELD_TO_DB)) {
                if (editForm[key] !== (editing as any)[key]) updates[dbKey] = editForm[key];
            }
            if (Object.keys(updates).length === 0) { setEditing(null); return; }
            await rpcAction('catalog:update_item', { itemId: editing.id, updates });
            setEditing(null);
            load();
            toast('Item updated', 'success');
        } catch (e: any) {
            toast(e?.message || 'Update failed', 'error');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (item: QmPlatformItemWithUsage) => {
        const msg = item.usageCount > 0
            ? `"${item.name}" is referenced by ${item.usageCount} inventory row(s). You must merge it first to reassign those references.`
            : `Delete "${item.name}"? This cannot be undone.`;
        const ok = await confirm({ title: 'Delete Item', message: msg, confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        try {
            await rpcAction('catalog:delete_item', { itemId: item.id });
            await Promise.all([loadCount(), load()]);
            toast(`Deleted "${item.name}"`, 'success');
        } catch (e: any) {
            toast(e?.message || 'Delete failed', 'error');
        }
    };

    const inputClass = 'w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white focus:outline-hidden focus:border-purple-500';
    const selectClass = 'bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-hidden focus:border-purple-500';
    const labelClass = 'block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1';

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    return (
        <div className="animate-fade-in-up p-4 md:p-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                <div>
                    <h2 className="text-2xl font-black text-white flex items-center gap-3">
                        <i className="fa-solid fa-box-open text-purple-400"></i>
                        Item Catalog
                        <span className="text-sm font-bold text-slate-500 bg-slate-800 px-2 py-0.5 rounded-sm">{totalCount}</span>
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">Platform-wide item database synced from uexcorp.space.</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowCategories(v => !v)}
                        className="flex items-center gap-2 bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all"
                    >
                        <i className="fa-solid fa-tags"></i> Categories ({categories.length})
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

            {/* Sync errors */}
            {syncErrors.length > 0 && (
                <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 mb-6">
                    <p className="text-xs font-bold text-red-400 uppercase tracking-wider mb-2">
                        Per-Category Fetch Errors ({syncErrors.length})
                    </p>
                    <div className="max-h-32 overflow-y-auto custom-scrollbar text-[11px] text-red-300/80 font-mono space-y-0.5">
                        {syncErrors.map(e => (
                            <div key={e.categoryId}>cat#{e.categoryId} ({e.categoryName}): {e.message}</div>
                        ))}
                    </div>
                </div>
            )}

            {showCategories && (
                <CategoryEditor
                    categories={categories}
                    rpcUpdate="catalog:update_item_category"
                    rpcDelete="catalog:delete_item_category"
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
                            placeholder="Search by name, subcategory, company…"
                            className="w-full bg-black/30 border border-white/10 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-hidden focus:border-purple-500"
                        />
                    </div>
                    <select value={filterCategoryId} onChange={(e) => setFilterCategoryId(e.target.value)} className={selectClass}>
                        <option value="">All Categories</option>
                        {categories.map(c => <option key={c.id} value={c.id}>{c.displayName}{c.isHidden ? ' (hidden)' : ''}</option>)}
                    </select>
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer whitespace-nowrap">
                        <input type="checkbox" checked={hideVehicles} onChange={(e) => setHideVehicles(e.target.checked)} className="accent-purple-500" />
                        Hide vehicle items
                    </label>
                </div>
                <p className="text-[10px] text-slate-600 mt-2">{totalCount} items match · showing {items.length} on this page</p>
            </div>

            {/* Table */}
            <div className="bg-slate-900 border border-white/10 rounded-xl overflow-hidden mb-6">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-black/30 text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-white/5">
                            <tr>
                                <th className="p-3">Name</th>
                                <th className="p-3">Category</th>
                                <th className="p-3">Subcategory</th>
                                <th className="p-3">Company</th>
                                <th className="p-3">Size</th>
                                <th className="p-3 text-center">Flags</th>
                                <th className="p-3 text-center">Usage</th>
                                <th className="p-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading && (
                                <tr><td colSpan={8} className="px-3 py-6 text-center text-xs text-slate-500"><i className="fa-solid fa-spinner animate-spin mr-2" />Loading…</td></tr>
                            )}
                            {!loading && items.length === 0 && (
                                <tr><td colSpan={8} className="px-3 py-12 text-center text-sm text-slate-600">
                                    <i className="fa-solid fa-box-open text-3xl mb-3 opacity-30 block"></i>
                                    {totalCount === 0 ? 'The catalog is empty. Click "Sync from UEX" to populate.' : 'No items match the current filters.'}
                                </td></tr>
                            )}
                            {!loading && items.map(item => {
                                const cat = item.platformCategoryId != null ? categoryById.get(item.platformCategoryId) : null;
                                return (
                                    <tr key={item.id} className="hover:bg-white/5 transition-colors">
                                        <td className="p-3 font-bold text-white">{item.name}</td>
                                        <td className="p-3 text-slate-400 text-xs">{cat?.displayName || '-'}</td>
                                        <td className="p-3 text-slate-500 text-xs">{item.subcategory || '-'}</td>
                                        <td className="p-3 text-slate-500 text-xs">{item.companyName || '-'}</td>
                                        <td className="p-3 text-slate-500 text-xs">{item.sizeLabel || '-'}</td>
                                        <td className="p-3">
                                            <div className="flex justify-center gap-1 flex-wrap">
                                                {item.isVehicleItem && <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm" title="Vehicle item">veh</span>}
                                                {item.isCommodity && <span className="bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm">cmd</span>}
                                                {item.isHarvestable && <span className="bg-green-500/10 text-green-400 border border-green-500/20 text-[10px] font-bold px-1.5 py-0.5 rounded-sm">hrv</span>}
                                            </div>
                                        </td>
                                        <td className="p-3 text-center">
                                            {item.usageCount > 0 ? (
                                                <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold px-2 py-0.5 rounded-full">{item.usageCount}</span>
                                            ) : (
                                                <span className="text-slate-700 text-xs">0</span>
                                            )}
                                        </td>
                                        <td className="p-3 text-right">
                                            <div className="flex justify-end gap-1">
                                                <button onClick={() => openEdit(item)} className="p-1.5 text-purple-400 hover:bg-purple-500/10 rounded-sm" title="Edit">
                                                    <i className="fa-solid fa-pen-to-square"></i>
                                                </button>
                                                <button onClick={() => handleDelete(item)} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-sm" title="Delete">
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
                                <h3 className="text-lg font-bold text-white">Edit Item</h3>
                                <p className="text-xs text-slate-500 mt-0.5">ID: {editing.id} | UUID: {editing.externalUuid || '—'} | UEX#: {editing.externalId ?? '—'}</p>
                            </div>
                            <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-white">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            {editForm.thumbnailUrl && (
                                <div className="flex justify-center">
                                    <img src={editForm.thumbnailUrl} alt="" className="max-h-40 rounded-lg border border-white/10" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                </div>
                            )}

                            <div>
                                <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider mb-3">Basic Info</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <div>
                                        <label className={labelClass}>Name</label>
                                        <input value={editForm.name || ''} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Subcategory (UEX label)</label>
                                        <input value={editForm.subcategory || ''} onChange={(e) => setEditForm({ ...editForm, subcategory: e.target.value })} className={inputClass} />
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
                                    <div>
                                        <label className={labelClass}>Company</label>
                                        <input value={editForm.companyName || ''} onChange={(e) => setEditForm({ ...editForm, companyName: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Vehicle Name (if attached)</label>
                                        <input value={editForm.vehicleName || ''} onChange={(e) => setEditForm({ ...editForm, vehicleName: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Size</label>
                                        <input value={editForm.sizeLabel || ''} onChange={(e) => setEditForm({ ...editForm, sizeLabel: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Quality</label>
                                        <input type="number" value={editForm.quality ?? ''} onChange={(e) => setEditForm({ ...editForm, quality: e.target.value === '' ? null : Number(e.target.value) })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Game Version</label>
                                        <input value={editForm.gameVersion || ''} onChange={(e) => setEditForm({ ...editForm, gameVersion: e.target.value })} className={inputClass} />
                                    </div>
                                </div>
                            </div>

                            <div>
                                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-3">Flags</h4>
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                        <input type="checkbox" checked={!!editForm.isVehicleItem} onChange={(e) => setEditForm({ ...editForm, isVehicleItem: e.target.checked })} className="accent-purple-500" />
                                        Vehicle Item
                                    </label>
                                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                        <input type="checkbox" checked={!!editForm.isCommodity} onChange={(e) => setEditForm({ ...editForm, isCommodity: e.target.checked })} className="accent-purple-500" />
                                        Commodity
                                    </label>
                                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                        <input type="checkbox" checked={!!editForm.isHarvestable} onChange={(e) => setEditForm({ ...editForm, isHarvestable: e.target.checked })} className="accent-purple-500" />
                                        Harvestable
                                    </label>
                                </div>
                            </div>

                            <div>
                                <h4 className="text-xs font-bold text-green-400 uppercase tracking-wider mb-3">Media & Links</h4>
                                <div className="space-y-3">
                                    <div>
                                        <label className={labelClass}>Thumbnail URL</label>
                                        <input value={editForm.thumbnailUrl || ''} onChange={(e) => setEditForm({ ...editForm, thumbnailUrl: e.target.value })} className={inputClass} />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Screenshot URL</label>
                                        <input value={editForm.screenshotUrl || ''} onChange={(e) => setEditForm({ ...editForm, screenshotUrl: e.target.value })} className={inputClass} />
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                        <div>
                                            <label className={labelClass}>Wiki URL</label>
                                            <input value={editForm.wikiUrl || ''} onChange={(e) => setEditForm({ ...editForm, wikiUrl: e.target.value })} className={inputClass} />
                                        </div>
                                        <div>
                                            <label className={labelClass}>Pledge Store URL</label>
                                            <input value={editForm.storeUrl || ''} onChange={(e) => setEditForm({ ...editForm, storeUrl: e.target.value })} className={inputClass} />
                                        </div>
                                    </div>
                                </div>
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
