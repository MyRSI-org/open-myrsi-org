import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useData } from '../../../../contexts/DataContext';
import { useNotification } from '../../../../contexts/NotificationContext';
import { useDebouncedValue } from '../../../../hooks/useDebouncedValue';
import { PlatformLocation, PlatformLocationKind, ToastVariant } from '../../../../types';

const PAGE_SIZE = 100;

const KIND_OPTIONS: Array<{ value: PlatformLocationKind | ''; label: string }> = [
    { value: '', label: 'All kinds' },
    { value: 'star_system', label: 'Star Systems' },
    { value: 'planet', label: 'Planets' },
    { value: 'moon', label: 'Moons' },
    { value: 'space_station', label: 'Space Stations' },
    { value: 'city', label: 'Cities' },
    { value: 'outpost', label: 'Outposts' },
    { value: 'poi', label: 'POIs' },
    { value: 'orbit', label: 'Orbits (internal)' },
];

const KIND_BADGE: Record<PlatformLocationKind, string> = {
    star_system: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
    orbit: 'bg-slate-700/40 text-slate-400 border-slate-500/30',
    planet: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
    moon: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
    space_station: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    city: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    outpost: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
    poi: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
};

// Dashboard toast shim — maps the old portal addPortalToast(msg, type) signature
// onto the dashboard's addToast(message, icon, className, options) surface.
type ToastFn = (message: string, type?: 'error' | 'success' | 'warning' | 'info') => void;

export default function AdminLocationCatalogTab() {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const toast = useCallback<ToastFn>((message, type = 'info') => {
        addToast(message, null, '', { variant: type as ToastVariant });
    }, [addToast]);

    // Filters
    const [search, setSearch] = useState('');
    const [filterKind, setFilterKind] = useState<PlatformLocationKind | ''>('');
    const [filterStarSystemId, setFilterStarSystemId] = useState<string>('');
    const [includeInternal, setIncludeInternal] = useState(false);
    const [includeHidden, setIncludeHidden] = useState(false);
    const [includeDecommissioned, setIncludeDecommissioned] = useState(false);
    const [page, setPage] = useState(0);

    // Data
    const [rows, setRows] = useState<PlatformLocation[]>([]);
    // Initialised to true: the mount-time fetch is already in flight on first render, so
    // the table shows its loading row from the start (no flash of an empty/"no results"
    // state before the first load). The effect's fetch flips it false when data arrives.
    const [loading, setLoading] = useState(true);
    const [counts, setCounts] = useState<{ total: number; perKind: Record<string, number> }>({ total: 0, perKind: {} });

    // Star systems list for the cascading filter
    const [starSystems, setStarSystems] = useState<PlatformLocation[]>([]);

    // Edit + sync state
    const [editing, setEditing] = useState<PlatformLocation | null>(null);
    const [editForm, setEditForm] = useState<Record<string, any>>({});
    const [isSaving, setIsSaving] = useState(false);
    const [syncLoading, setSyncLoading] = useState(false);

    const loadCounts = useCallback(async () => {
        try {
            const c = await rpcAction('catalog:count_locations', {});
            if (c) setCounts(c);
        } catch {
            // non-fatal — counts are decorative
        }
    }, [rpcAction]);

    const loadStarSystems = useCallback(async () => {
        try {
            const r = await rpcAction('catalog:list_locations', {
                kind: 'star_system', limit: 200, includeInternal: true, includeHidden: true, includeDecommissioned: true,
            });
            if (Array.isArray(r)) setStarSystems(r);
        } catch {
            // non-fatal
        }
    }, [rpcAction]);

    // Debounce the search input so a 6-char query fires 1 RPC, not 6.
    const debouncedSearch = useDebouncedValue(search.trim(), 300);

    // Reset page whenever a filter (other than page itself) changes. The next
    // useEffect below sees the page change and fires exactly one load(), so we
    // never double-fetch on filter change.
    const isFirstFilterChangeRef = useRef(true);
    useEffect(() => {
        if (isFirstFilterChangeRef.current) {
            isFirstFilterChangeRef.current = false;
            return;
        }
        setPage(0);
    }, [filterKind, filterStarSystemId, includeInternal, includeHidden, includeDecommissioned, debouncedSearch]);

    // Cancel stale in-flight responses if the user changes filters mid-fetch.
    const requestSeqRef = useRef(0);
    // runLoad performs the seq-guarded fetch and the async result/loading-off sets, but does
    // NOT set loading=true itself. The effect path raises the loading flag at render time (see
    // the prev-key tracker below), so the synchronous set lives in render — not in the effect.
    const runLoad = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        try {
            const r = await rpcAction('catalog:list_locations', {
                kind: filterKind || undefined,
                starSystemId: filterStarSystemId ? Number(filterStarSystemId) : undefined,
                includeInternal,
                includeHidden,
                includeDecommissioned,
                search: debouncedSearch || undefined,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (seq !== requestSeqRef.current) return;
            setRows(Array.isArray(r) ? r : []);
        } catch (e: any) {
            if (seq !== requestSeqRef.current) return;
            toast(`Failed to load locations: ${e?.message || 'unknown'}`, 'error');
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [rpcAction, filterKind, filterStarSystemId, includeInternal, includeHidden, includeDecommissioned, debouncedSearch, page, toast]);

    // Imperative wrapper for the event-handler call sites (sync / save / delete refreshes):
    // they run outside an effect, so the synchronous setLoading(true) is fine here and the
    // loading spinner behaviour at those sites is preserved exactly.
    const load = useCallback(() => {
        setLoading(true);
        return runLoad();
    }, [runLoad]);

    // Counts + star-system dropdown only need to load once per session. Sync
    // refresh re-runs them explicitly. Wrapped in an async IIFE so the deferred
    // (post-await) setState is explicit — the documented React async-effect pattern.
    // Both still fire concurrently (not awaited sequentially), matching the old body.
    // (loadCounts/loadStarSystems set state only after their awaited RPC, so there is no
    // synchronous set to relocate here.)
    useEffect(() => { void (async () => { await Promise.all([loadCounts(), loadStarSystems()]); })(); }, [loadCounts, loadStarSystems]);

    // Raise the loading flag at render time whenever the filter/page/search key changes —
    // the React "adjust state during render" prev-key tracker pattern. This replaces the
    // synchronous setLoading(true) the old effect performed via load(), removing the
    // set-state-in-effect while keeping identical timing (loading true for every refetch
    // the user triggers). The key is built from the same serializable inputs that drive the
    // fetch; the mount-time fetch needs no entry here because `loading` is initialised to true.
    const loadKey = JSON.stringify([
        filterKind, filterStarSystemId, includeInternal, includeHidden, includeDecommissioned,
        debouncedSearch, page,
    ]);
    const [prevLoadKey, setPrevLoadKey] = useState(loadKey);
    if (loadKey !== prevLoadKey) {
        setPrevLoadKey(loadKey);
        setLoading(true);
    }
    // The effect only performs the async fetch; setLoading(false) happens inside runLoad
    // after the awaited RPC, so nothing synchronous is set in the effect body.
    useEffect(() => { void (async () => { await runLoad(); })(); }, [runLoad]);

    const handleSync = useCallback(async () => {
        setSyncLoading(true);
        try {
            const res = await rpcAction('catalog:sync_locations', {});
            const totals = res.perKind
                ? Object.entries(res.perKind).map(([k, v]: [string, any]) => `${k}: ${v.inserted}/${v.fetched}`).join(' · ')
                : '';
            const errCount = res.totalErrors || 0;
            toast(
                `Sync complete in ${res.durationMs}ms (${totals}). Paths updated: ${res.pathsUpdated}. Errors: ${errCount}.`,
                errCount > 0 ? 'warning' : 'success'
            );
            await Promise.all([loadCounts(), loadStarSystems(), load()]);
        } catch (e: any) {
            toast(`Sync failed: ${e?.message || 'unknown'}`, 'error');
        } finally {
            setSyncLoading(false);
        }
    }, [rpcAction, toast, loadCounts, loadStarSystems, load]);

    const openEdit = (loc: PlatformLocation) => {
        setEditing(loc);
        setEditForm({
            nickname: loc.nickname || '',
            wiki_url: loc.wikiUrl || '',
            is_hidden: loc.isHidden,
            is_internal: loc.isInternal,
        });
    };

    const handleSave = async () => {
        if (!editing) return;
        setIsSaving(true);
        try {
            const updates: Record<string, any> = {};
            if ((editForm.nickname || null) !== (editing.nickname || null)) updates.nickname = editForm.nickname || null;
            if ((editForm.wiki_url || null) !== (editing.wikiUrl || null)) updates.wiki_url = editForm.wiki_url || null;
            if (!!editForm.is_hidden !== editing.isHidden) updates.is_hidden = !!editForm.is_hidden;
            if (!!editForm.is_internal !== editing.isInternal) updates.is_internal = !!editForm.is_internal;
            if (Object.keys(updates).length === 0) {
                setEditing(null);
                return;
            }
            await rpcAction('catalog:update_location', { locationId: editing.id, updates });
            setEditing(null);
            load();
            toast('Location updated', 'success');
        } catch (e: any) {
            toast(e?.message || 'Update failed', 'error');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (loc: PlatformLocation) => {
        const ok = await confirm({
            title: 'Delete Location',
            message: `Delete "${loc.path || loc.name}"? Children of this location will lose their parent. This cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await rpcAction('catalog:delete_location', { locationId: loc.id });
            load();
            toast(`Deleted "${loc.name}"`, 'success');
        } catch (e: any) {
            toast(e?.message || 'Delete failed', 'error');
        }
    };

    const inputClass = 'w-full bg-black/30 border border-white/10 rounded-lg p-2.5 text-sm text-white focus:outline-hidden focus:border-purple-500';
    const selectClass = 'bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-hidden focus:border-purple-500';
    const labelClass = 'block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1';

    const stats = useMemo(() => {
        const k = counts.perKind || {};
        return [
            { label: 'Star Systems', value: k.star_system || 0, icon: 'fa-sun', color: 'text-purple-400' },
            { label: 'Planets', value: k.planet || 0, icon: 'fa-globe', color: 'text-sky-400' },
            { label: 'Moons', value: k.moon || 0, icon: 'fa-moon', color: 'text-cyan-400' },
            { label: 'Stations', value: k.space_station || 0, icon: 'fa-satellite', color: 'text-amber-400' },
            { label: 'Cities', value: k.city || 0, icon: 'fa-city', color: 'text-emerald-400' },
            { label: 'Outposts', value: k.outpost || 0, icon: 'fa-tent', color: 'text-orange-400' },
            { label: 'POIs', value: k.poi || 0, icon: 'fa-location-dot', color: 'text-rose-400' },
            { label: 'Orbits', value: k.orbit || 0, icon: 'fa-arrows-rotate', color: 'text-slate-400' },
        ];
    }, [counts]);

    return (
        <div className="animate-fade-in-up p-4 md:p-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                <div>
                    <h2 className="text-2xl font-black text-white flex items-center gap-3">
                        <i className="fa-solid fa-globe text-purple-400"></i>
                        Location Catalog
                        <span className="text-sm font-bold text-slate-500 bg-slate-800 px-2 py-0.5 rounded-sm">{counts.total}</span>
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">Star Citizen universe — synced from uexcorp.space.</p>
                </div>
                <div className="flex gap-2">
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

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
                {stats.map(s => (
                    <div key={s.label} className="bg-slate-900 border border-white/10 rounded-xl p-3 text-center">
                        <i className={`fa-solid ${s.icon} ${s.color} text-base mb-1`}></i>
                        <p className="text-lg font-black text-white">{s.value}</p>
                        <p className="text-[9px] text-slate-500 uppercase font-bold tracking-wider">{s.label}</p>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div className="bg-slate-900 border border-white/10 rounded-xl p-4 mb-6 space-y-3">
                <div className="flex flex-col lg:flex-row gap-3 items-end">
                    <div className="flex-1 w-full relative">
                        <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-600"></i>
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by name, path, or nickname…"
                            className="w-full bg-black/30 border border-white/10 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-hidden focus:border-purple-500"
                        />
                    </div>
                    <select value={filterKind} onChange={(e) => setFilterKind(e.target.value as PlatformLocationKind | '')} className={selectClass}>
                        {KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select value={filterStarSystemId} onChange={(e) => setFilterStarSystemId(e.target.value)} className={selectClass}>
                        <option value="">All systems</option>
                        {starSystems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
                <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-400 cursor-pointer">
                        <input type="checkbox" checked={includeInternal} onChange={(e) => setIncludeInternal(e.target.checked)} className="accent-purple-500" />
                        Include internal (orbits)
                    </label>
                    <label className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-400 cursor-pointer">
                        <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} className="accent-purple-500" />
                        Include hidden
                    </label>
                    <label className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-400 cursor-pointer">
                        <input type="checkbox" checked={includeDecommissioned} onChange={(e) => setIncludeDecommissioned(e.target.checked)} className="accent-purple-500" />
                        Include decommissioned
                    </label>
                </div>
            </div>

            {/* Table */}
            <div className="bg-slate-900 border border-white/10 rounded-xl overflow-hidden mb-6">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-black/30 text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-white/5">
                            <tr>
                                <th className="p-3">Name</th>
                                <th className="p-3">Path</th>
                                <th className="p-3">Kind</th>
                                <th className="p-3">Faction</th>
                                <th className="p-3">Status</th>
                                <th className="p-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading && (
                                <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-500"><i className="fa-solid fa-spinner animate-spin mr-2" />Loading…</td></tr>
                            )}
                            {!loading && rows.length === 0 && (
                                <tr><td colSpan={6} className="px-3 py-12 text-center text-sm text-slate-600">
                                    <i className="fa-solid fa-globe text-3xl mb-3 opacity-30 block"></i>
                                    {counts.total === 0 ? 'The catalog is empty. Click "Sync from UEX" to populate.' : 'No locations match the current filters.'}
                                </td></tr>
                            )}
                            {!loading && rows.map(loc => (
                                <tr key={loc.id} className="hover:bg-white/5 transition-colors">
                                    <td className="p-3">
                                        <div className="text-white font-medium">{loc.name}</div>
                                        {loc.nickname && <div className="text-[10px] text-slate-500 italic">"{loc.nickname}"</div>}
                                    </td>
                                    <td className="p-3 text-slate-400 text-xs truncate max-w-md">{loc.path || '—'}</td>
                                    <td className="p-3">
                                        <span className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border ${KIND_BADGE[loc.kind]}`}>
                                            {loc.kind.replace('_', ' ')}
                                        </span>
                                    </td>
                                    <td className="p-3 text-slate-500 text-xs">{loc.factionName || '—'}</td>
                                    <td className="p-3">
                                        <div className="flex flex-wrap gap-1">
                                            {loc.isAvailableLive && <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-green-500/10 text-green-400 border-green-500/20">live</span>}
                                            {loc.isLandable && <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-sky-500/10 text-sky-400 border-sky-500/20">landable</span>}
                                            {loc.isDecommissioned && <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-red-500/10 text-red-400 border-red-500/20">decom</span>}
                                            {loc.isHidden && <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-amber-500/10 text-amber-400 border-amber-500/20">hidden</span>}
                                            {loc.isInternal && <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-slate-500/10 text-slate-400 border-slate-500/20">internal</span>}
                                        </div>
                                    </td>
                                    <td className="p-3 text-right">
                                        <div className="flex justify-end gap-1">
                                            <button onClick={() => openEdit(loc)} className="p-1.5 text-purple-400 hover:bg-purple-500/10 rounded-sm" title="Edit">
                                                <i className="fa-solid fa-pen-to-square"></i>
                                            </button>
                                            <button onClick={() => handleDelete(loc)} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-sm" title="Delete">
                                                <i className="fa-solid fa-trash-can"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination */}
            <div className="flex justify-between items-center text-sm text-slate-400 mb-8">
                <p className="text-xs">Page {page + 1} · showing {rows.length} of {PAGE_SIZE}</p>
                <div className="flex gap-2">
                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1.5 bg-slate-800 border border-white/10 rounded-sm text-xs font-bold disabled:opacity-30 hover:bg-slate-700">
                        <i className="fa-solid fa-chevron-left mr-1"></i> Prev
                    </button>
                    <button onClick={() => setPage(p => p + 1)} disabled={rows.length < PAGE_SIZE} className="px-3 py-1.5 bg-slate-800 border border-white/10 rounded-sm text-xs font-bold disabled:opacity-30 hover:bg-slate-700">
                        Next <i className="fa-solid fa-chevron-right ml-1"></i>
                    </button>
                </div>
            </div>

            {/* Edit Modal */}
            {editing && (
                <div className="fixed inset-0 z-150 bg-black/90 backdrop-blur-sm flex items-start justify-center animate-fade-in overflow-y-auto p-4">
                    <div className="bg-slate-900 border border-purple-500/30 shadow-2xl shadow-purple-900/20 rounded-2xl max-w-xl w-full my-8 relative">
                        <div className="absolute top-0 left-0 w-full h-1 bg-linear-to-r from-purple-500 to-pink-500 rounded-t-2xl"></div>

                        <div className="p-6 border-b border-white/10 flex justify-between items-center">
                            <div>
                                <h3 className="text-lg font-bold text-white">Edit Location</h3>
                                <p className="text-xs text-slate-500 mt-0.5">{editing.path || editing.name}</p>
                                <p className="text-[10px] text-slate-600 mt-0.5 font-mono">id: {editing.id} · kind: {editing.kind} · uex#: {editing.externalId}</p>
                            </div>
                            <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-white">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <div className="p-6 space-y-4">
                            <div>
                                <label className={labelClass}>Nickname (admin override)</label>
                                <input value={editForm.nickname || ''} onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })} className={inputClass} placeholder="Optional friendly alias" />
                                <p className="text-[10px] text-slate-600 mt-1">UEX-sourced nickname is replaced by this value. Preserved across re-syncs.</p>
                            </div>
                            <div>
                                <label className={labelClass}>Wiki URL</label>
                                <input value={editForm.wiki_url || ''} onChange={(e) => setEditForm({ ...editForm, wiki_url: e.target.value })} className={inputClass} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <label className="flex items-start gap-2 cursor-pointer">
                                    <input type="checkbox" checked={!!editForm.is_hidden} onChange={(e) => setEditForm({ ...editForm, is_hidden: e.target.checked })} className="accent-purple-500 mt-1" />
                                    <span>
                                        <span className="text-sm text-white block">Hidden</span>
                                        <span className="text-[10px] text-slate-500">Excluded from search.</span>
                                    </span>
                                </label>
                                <label className="flex items-start gap-2 cursor-pointer">
                                    <input type="checkbox" checked={!!editForm.is_internal} onChange={(e) => setEditForm({ ...editForm, is_internal: e.target.checked })} className="accent-purple-500 mt-1" />
                                    <span>
                                        <span className="text-sm text-white block">Internal</span>
                                        <span className="text-[10px] text-slate-500">Scaffolding only — never user-facing.</span>
                                    </span>
                                </label>
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
