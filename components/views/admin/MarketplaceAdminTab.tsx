// MarketplaceAdminTab — Admin Console surface for the marketplace (gated
// marketplace:admin). Two sections: a moderation queue for member reports
// (resolve = take the listing down + notify, or dismiss) and a category
// manager (CRUD + restore-defaults for orgs that upgraded past first-boot).
// All data flows through rpcAction → the permission-gated dispatcher; this view
// renders only the projections the admin actions return.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useFormatDate } from '../../../contexts/AuthContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { TabPageHeader, EmptyState } from '../../shared/ui';
import WindowFrame from '../../layout/WindowFrame';
import type { MarketplaceCategory, MarketplaceReport } from '../../../types';

const REPORT_STATUS_META: Record<string, { cls: string; label: string; icon: string }> = {
    open: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30', label: 'Open', icon: 'fa-circle-exclamation' },
    reviewing: { cls: 'bg-sky-500/15 text-sky-400 border-sky-500/30', label: 'Reviewing', icon: 'fa-eye' },
    actioned: { cls: 'bg-red-500/15 text-red-400 border-red-500/30', label: 'Actioned', icon: 'fa-gavel' },
    dismissed: { cls: 'bg-slate-600/20 text-slate-400 border-slate-600/40', label: 'Dismissed', icon: 'fa-xmark' },
};
const KIND_LABEL: Record<string, string> = { item: 'Items', service: 'Services', both: 'Items & Services' };

const inputCls = 'w-full bg-slate-800 border border-slate-600 rounded-md px-3 py-2 text-white text-sm outline-hidden focus:border-indigo-500';
const labelCls = 'block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5';

// ---- Category create/edit modal ----
const CategoryEditor: React.FC<{
    initial: MarketplaceCategory | null;
    parents: MarketplaceCategory[];
    onClose: () => void;
    onSave: (payload: Record<string, unknown>) => Promise<void>;
}> = ({ initial, parents, onClose, onSave }) => {
    const [name, setName] = useState(initial?.name || '');
    const [parentId, setParentId] = useState<number | ''>(initial?.parentId ?? '');
    const [listingKind, setListingKind] = useState<string>(initial?.listingKind || 'both');
    const [icon, setIcon] = useState(initial?.icon || '');
    const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
    const [active, setActive] = useState(initial?.active ?? true);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (!name.trim()) return;
        setBusy(true);
        await onSave({
            name: name.trim(),
            parentId: parentId === '' ? null : Number(parentId),
            listingKind,
            icon: icon.trim() || null,
            sortOrder: Number(sortOrder) || 0,
            active,
        }).finally(() => setBusy(false));
    };

    return (
        <WindowFrame isOpen onClose={onClose} title={initial ? 'Edit Category' : 'New Category'} subtitle="Marketplace" icon="fa-solid fa-tags" color="indigo" width="max-w-md">
            <div className="p-5 space-y-4">
                <div><label className={labelCls}>Name</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={inputCls} placeholder="e.g. Ship Components" /></div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className={labelCls}>Parent</label>
                        <select value={parentId} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : '')} className={inputCls}>
                            <option value="">Top level</option>
                            {parents.filter((p) => p.parentId == null && p.id !== initial?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={labelCls}>Applies to</label>
                        <select value={listingKind} onChange={(e) => setListingKind(e.target.value)} className={inputCls}>
                            <option value="both">Items &amp; Services</option>
                            <option value="item">Items</option>
                            <option value="service">Services</option>
                        </select>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div><label className={labelCls}>Icon (FA class)</label><input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={60} className={inputCls} placeholder="fa-solid fa-box" /></div>
                    <div><label className={labelCls}>Sort order</label><input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className={inputCls} /></div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-indigo-500" />
                    Active (visible to members)
                </label>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-700/60">
                <button onClick={onClose} className="text-xs font-bold uppercase px-4 py-2 rounded-md text-slate-300 hover:text-white">Cancel</button>
                <button onClick={submit} disabled={busy || !name.trim()} className="text-xs font-bold uppercase px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
                    {busy ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save'}
                </button>
            </div>
        </WindowFrame>
    );
};

const REPORT_FILTERS: { key: string; label: string }[] = [
    { key: 'open', label: 'Open' },
    { key: 'actioned', label: 'Actioned' },
    { key: 'dismissed', label: 'Dismissed' },
    { key: 'all', label: 'All' },
];

const MarketplaceAdminTab: React.FC = () => {
    const { rpcAction } = useData();
    const fmt = useFormatDate();
    const { addToast, confirm } = useNotification();

    const [section, setSection] = useState<'reports' | 'categories'>('reports');

    const [reports, setReports] = useState<MarketplaceReport[]>([]);
    const [reportFilter, setReportFilter] = useState('open');
    const [loadingReports, setLoadingReports] = useState(true);

    const [categories, setCategories] = useState<MarketplaceCategory[]>([]);
    const [loadingCats, setLoadingCats] = useState(true);
    const [editing, setEditing] = useState<MarketplaceCategory | null>(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);

    const ok = (msg: string) => addToast(msg, <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50');
    const fail = (e: any) => addToast('Action Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e?.message || 'Something went wrong.' });
    // Latest-ref for `fail` so the data-fetch callbacks below can depend only on their real
    // inputs (rpcAction / reportFilter) without listing the per-render `fail` closure. `fail`
    // only fires in the async `.catch` after the awaited rpc settles — long after this effect
    // has committed the current `fail` — so failRef.current is never stale at call time.
    const failRef = useRef(fail);
    useEffect(() => { failRef.current = fail; });

    // Refetch the reports queue. The synchronous `setLoadingReports(true)` lives in the
    // `loadReports` wrapper (for button/refresh re-invocations) and in the render-time
    // filter-change tracker below — NOT in the effect — so the effect runs no sync setState.
    const fetchReports = useCallback(async () => {
        // 'open' tab shows the working queue (open + reviewing); send no status.
        const status = reportFilter === 'open' ? undefined : reportFilter;
        // Settle data/error/loading entirely on the async promise chain so the effect that
        // calls this has no synchronously-reachable setState (no sync `catch` to flag).
        await rpcAction('marketplace:admin:list_reports', status ? { status } : {})
            .then((data) => { setReports(data || []); })
            .catch((e) => { failRef.current(e); })
            .finally(() => { setLoadingReports(false); });
    }, [rpcAction, reportFilter]);
    const loadReports = useCallback(async () => {
        setLoadingReports(true);
        await fetchReports();
    }, [fetchReports]);

    const fetchCategories = useCallback(async () => {
        await rpcAction('marketplace:admin:list_categories', {})
            .then((data) => { setCategories(data || []); })
            .catch((e) => { failRef.current(e); })
            .finally(() => { setLoadingCats(false); });
    }, [rpcAction]);
    const loadCategories = useCallback(async () => {
        setLoadingCats(true);
        await fetchCategories();
    }, [fetchCategories]);

    // Show the spinner the moment the report filter changes (adjust-state-during-render
    // pattern). This replaces the in-effect setLoadingReports(true) so the effect performs
    // only the async fetch. React re-renders before paint, so it is behavior-equivalent.
    const [prevReportFilter, setPrevReportFilter] = useState(reportFilter);
    if (reportFilter !== prevReportFilter) {
        setPrevReportFilter(reportFilter);
        setLoadingReports(true);
    }

    // Both loaders are async external-data fetches. loadingReports/loadingCats start `true`,
    // and the effects below run only the async fetch (whose async setState is not flagged).
    useEffect(() => { fetchReports(); }, [fetchReports]);
    useEffect(() => { fetchCategories(); }, [fetchCategories]);

    const resolveReport = async (report: MarketplaceReport, decision: 'actioned' | 'dismissed') => {
        if (decision === 'actioned' && report.targetType === 'listing') {
            const confirmed = await confirm({
                title: 'Take down listing?',
                message: `This closes "${report.targetTitle || 'the listing'}" so it leaves the board, and notifies the owner it was removed by a moderator.`,
                confirmText: 'Take down', variant: 'danger',
            });
            if (!confirmed) return;
        }
        try {
            await rpcAction('marketplace:admin:review_report', { id: report.id, decision });
            ok(decision === 'actioned' ? 'Report actioned' : 'Report dismissed');
            loadReports();
        } catch (e) { fail(e); }
    };

    const saveCategory = async (payload: Record<string, unknown>) => {
        try {
            if (editing) await rpcAction('marketplace:admin:update_category', { id: editing.id, updates: payload });
            else await rpcAction('marketplace:admin:create_category', payload);
            ok(editing ? 'Category updated' : 'Category created');
            setEditing(null); setCreating(false);
            loadCategories();
        } catch (e) { fail(e); throw e; }
    };

    const deleteCategory = async (cat: MarketplaceCategory) => {
        const confirmed = await confirm({
            title: 'Delete category?',
            message: `Delete "${cat.name}"? Sub-categories are removed too; existing listings keep their data but become Uncategorised.`,
            confirmText: 'Delete', variant: 'danger',
        });
        if (!confirmed) return;
        try {
            await rpcAction('marketplace:admin:delete_category', { id: cat.id });
            ok('Category deleted');
            loadCategories();
        } catch (e) { fail(e); }
    };

    const restoreDefaults = async () => {
        const confirmed = await confirm({
            title: 'Restore default categories?',
            message: 'Re-adds the built-in category set. Existing categories with the same slug are left untouched — nothing is deleted.',
            confirmText: 'Restore', variant: 'warning',
        });
        if (!confirmed) return;
        setBusy(true);
        try {
            const data = await rpcAction('marketplace:admin:seed_categories', {});
            setCategories(data || []);
            ok('Default categories restored');
        } catch (e) { fail(e); } finally { setBusy(false); }
    };

    const openReportCount = useMemo(() => reports.filter((r) => r.status === 'open' || r.status === 'reviewing').length, [reports]);
    const parentName = (id: number | null) => (id == null ? '—' : categories.find((c) => c.id === id)?.name || `#${id}`);

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Marketplace"
                icon="fa-solid fa-store"
                accent="indigo"
                subtitle="Moderate member reports and manage the listing category taxonomy."
                meta={reportFilter === 'open' && openReportCount > 0 ? (
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border bg-amber-500/15 text-amber-400 border-amber-500/30">{openReportCount} open</span>
                ) : undefined}
            />

            <div className="flex items-center gap-1 border-b border-slate-700/50">
                {(['reports', 'categories'] as const).map((s) => (
                    <button key={s} onClick={() => setSection(s)}
                        className={`px-4 py-2.5 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors ${section === s ? 'text-indigo-300 border-indigo-400' : 'text-slate-500 border-transparent hover:text-slate-300'}`}>
                        <i className={`fa-solid ${s === 'reports' ? 'fa-flag' : 'fa-tags'} mr-2`}></i>{s === 'reports' ? 'Reports' : 'Categories'}
                    </button>
                ))}
            </div>

            {section === 'reports' ? (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        {REPORT_FILTERS.map((f) => (
                            <button key={f.key} onClick={() => setReportFilter(f.key)}
                                className={`text-[11px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-full border transition-colors ${reportFilter === f.key ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40' : 'bg-slate-800/40 text-slate-400 border-slate-700/50 hover:text-white'}`}>
                                {f.label}
                            </button>
                        ))}
                        <button onClick={loadReports} className="ml-auto text-xs text-slate-400 hover:text-white"><i className="fa-solid fa-rotate mr-1"></i>Refresh</button>
                    </div>

                    {loadingReports ? (
                        <div className="text-center text-slate-500 py-16"><i className="fa-solid fa-spinner animate-spin text-2xl"></i></div>
                    ) : reports.length === 0 ? (
                        <EmptyState icon="fa-flag" accent="indigo" heading="No reports" description={reportFilter === 'open' ? 'No open reports. The queue is clear.' : 'No reports in this view.'} />
                    ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                            {reports.map((r) => {
                                const meta = REPORT_STATUS_META[r.status] || REPORT_STATUS_META.open;
                                const resolved = r.status === 'actioned' || r.status === 'dismissed';
                                return (
                                    <div key={r.id} className="bg-slate-900/40 border border-slate-700/50 rounded-xl p-4 space-y-2.5">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${meta.cls}`}><i className={`fa-solid ${meta.icon} mr-1`} aria-hidden />{meta.label}</span>
                                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm border bg-slate-700/30 text-slate-300 border-slate-600/40">{r.targetType}</span>
                                            <span className="ml-auto text-[11px] text-slate-500">{fmt(r.createdAt)}</span>
                                        </div>
                                        <div className="text-sm text-white font-semibold">
                                            {r.targetTitle || <span className="italic text-slate-500">(target removed)</span>}
                                            {r.targetStatus && <span className="text-xs text-slate-500 font-normal"> · {r.targetStatus}</span>}
                                        </div>
                                        <div className="text-xs text-slate-400">Reason: <span className="text-slate-200 font-medium">{r.reasonCategory}</span></div>
                                        {r.details && <p className="text-sm text-slate-300 bg-slate-950/30 border border-slate-800/50 rounded-lg p-2.5 whitespace-pre-wrap">{r.details}</p>}
                                        <div className="text-[11px] text-slate-500">Reported by {r.reporterName || `#${r.reporterId}`}</div>
                                        {resolved ? (
                                            <div className="text-[11px] text-slate-500 italic border-t border-slate-700/40 pt-2">
                                                {meta.label} by {r.reviewerName || '—'}{r.reviewedAt ? ` · ${fmt(r.reviewedAt)}` : ''}
                                            </div>
                                        ) : (
                                            <div className="flex gap-2 border-t border-slate-700/40 pt-3">
                                                <button onClick={() => resolveReport(r, 'actioned')} className="flex-1 bg-red-600 hover:bg-red-500 text-white text-xs font-bold uppercase py-2 rounded-md">
                                                    <i className="fa-solid fa-gavel mr-2"></i>{r.targetType === 'listing' ? 'Take down & resolve' : 'Mark actioned'}
                                                </button>
                                                <button onClick={() => resolveReport(r, 'dismissed')} className="px-4 bg-slate-700/60 hover:bg-slate-600 text-slate-200 text-xs font-bold uppercase py-2 rounded-md">
                                                    Dismiss
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <button onClick={() => { setEditing(null); setCreating(true); }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-md transition-colors">
                            <i className="fa-solid fa-plus mr-2"></i>New Category
                        </button>
                        <button onClick={restoreDefaults} disabled={busy} className="text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-md border border-slate-700/60 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50">
                            {busy ? <i className="fa-solid fa-spinner animate-spin mr-2"></i> : <i className="fa-solid fa-arrows-rotate mr-2"></i>}Restore Defaults
                        </button>
                        <button onClick={loadCategories} className="ml-auto text-xs text-slate-400 hover:text-white"><i className="fa-solid fa-rotate mr-1"></i>Refresh</button>
                    </div>

                    {loadingCats ? (
                        <div className="text-center text-slate-500 py-16"><i className="fa-solid fa-spinner animate-spin text-2xl"></i></div>
                    ) : categories.length === 0 ? (
                        <EmptyState icon="fa-tags" accent="indigo" heading="No categories" description="No categories yet. Create one, or restore the built-in defaults." />
                    ) : (
                        <div className="bg-slate-900/40 border border-slate-700/50 rounded-xl overflow-hidden">
                            <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2.5 bg-slate-800/50 border-b border-slate-700/50 text-[10px] font-black uppercase tracking-wider text-slate-500">
                                <div className="col-span-5">Name</div>
                                <div className="col-span-2">Applies to</div>
                                <div className="col-span-2">Parent</div>
                                <div className="col-span-1 text-center">Sort</div>
                                <div className="col-span-2 text-right">Actions</div>
                            </div>
                            {categories.map((c) => (
                                <div key={c.id} className="grid grid-cols-2 sm:grid-cols-12 gap-2 px-4 py-3 border-b border-slate-800/40 items-center text-sm">
                                    <div className="col-span-2 sm:col-span-5 flex items-center gap-2 min-w-0">
                                        {c.icon && <i className={`${c.icon} text-indigo-300 w-4 text-center shrink-0`} aria-hidden />}
                                        <span className={`truncate ${c.parentId ? 'text-slate-300' : 'text-white font-semibold'}`}>{c.parentId ? '— ' : ''}{c.name}</span>
                                        {!c.active && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm bg-slate-700/40 text-slate-500 shrink-0">Hidden</span>}
                                    </div>
                                    <div className="sm:col-span-2 text-xs text-slate-400">{KIND_LABEL[c.listingKind] || c.listingKind}</div>
                                    <div className="sm:col-span-2 text-xs text-slate-400 truncate">{parentName(c.parentId)}</div>
                                    <div className="sm:col-span-1 text-xs text-slate-500 sm:text-center">{c.sortOrder}</div>
                                    <div className="col-span-2 sm:col-span-2 flex justify-end gap-1.5">
                                        <button onClick={() => { setCreating(false); setEditing(c); }} title="Edit" className="w-7 h-7 rounded-md text-slate-400 hover:text-white hover:bg-slate-700/60"><i className="fa-solid fa-pen text-xs"></i></button>
                                        <button onClick={() => deleteCategory(c)} title="Delete" className="w-7 h-7 rounded-md text-slate-400 hover:text-red-300 hover:bg-red-500/10"><i className="fa-solid fa-trash text-xs"></i></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {(creating || editing) && (
                <CategoryEditor
                    initial={editing}
                    parents={categories}
                    onClose={() => { setCreating(false); setEditing(null); }}
                    onSave={saveCategory}
                />
            )}
        </div>
    );
};

export default MarketplaceAdminTab;
