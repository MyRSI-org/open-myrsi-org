import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useWarehouse } from '../../../contexts/WarehouseContext';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import type { WarehouseStock, WarehouseCatalogCategory, QmLocation } from '../../../types';
import { SkeletonCardGrid } from '../../shared/ui/Skeleton';
import { useNotification } from '../../../contexts/NotificationContext';

const CATEGORY_LABEL: Record<WarehouseCatalogCategory, string> = {
    ore: 'Ore',
    refined: 'Refined',
    fuel: 'Fuel',
    rmc: 'RMC',
    munition: 'Munition',
    consumable: 'Consumable',
    misc: 'Misc',
};

const PAGE_SIZE = 60;
const CSV_EXPORT_PAGE_SIZE = 200;
const CSV_HEADER = ['Commodity', 'Quality', 'Category', 'Unit', 'Location', 'On Hand', 'Reserved', 'Notes'] as const;

function csvEscape(v: unknown): string {
    if (v == null) return '';
    const s = String(v);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

interface StockExportRow {
    commodity: string;
    quality: string;
    category: string;
    unit: string;
    location: string;
    onHand: number;
    reserved: number;
    notes: string;
}

/** Reserved-quantity badge with a breakdown tooltip (requests vs. open contracts). */
function ReservedBadge({ quantityReserved, fromRequests }: { quantityReserved: number; fromRequests: number }) {
    const fromContracts = Math.max(0, quantityReserved - fromRequests);
    const tooltip = fromRequests > 0 && fromContracts > 0
        ? `${fromRequests} from withdrawal requests · ${fromContracts} from open contracts`
        : fromRequests > 0
            ? `${fromRequests} from withdrawal requests`
            : fromContracts > 0
                ? `${fromContracts} from open marketplace contracts`
                : undefined;
    return (
        <div title={tooltip}>
            <div className="text-lg font-bold font-mono text-amber-300 cursor-help underline decoration-dotted decoration-amber-500/40 underline-offset-2">
                {quantityReserved}
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Reserved</div>
        </div>
    );
}

interface Props {
    locations: QmLocation[];
    canManage: boolean;
    canRequest: boolean;
    canAdmin: boolean;
    onAdjust: (s: WarehouseStock) => void;
    onTransfer: (s: WarehouseStock) => void;
    onDelete: (s: WarehouseStock) => void;
    onRequest: (s: WarehouseStock) => void;
    onEditCommodity: (s: WarehouseStock) => void;
    onCreateStock: () => void;
    /** Bumped by the parent to force a refetch (e.g. after a sibling action). */
    refreshKey?: number;
}

export default function WhStockTab({ locations, canManage, canRequest, canAdmin, onAdjust, onTransfer, onDelete, onRequest, onEditCommodity, onCreateStock, refreshKey }: Props) {
    const { rpcAction } = useData();
    const { warehouseRequests } = useWarehouse();
    const { addToast } = useNotification();

    const [search, setSearch] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<'all' | WarehouseCatalogCategory>('all');
    const [locationFilter, setLocationFilter] = useState<'all' | number>('all');
    const [page, setPage] = useState(0);
    const debouncedSearch = useDebouncedValue(search.trim(), 300);

    const [stock, setStock] = useState<WarehouseStock[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

    // CSV export — paginated loop with inline progress card.
    const [csvExporting, setCsvExporting] = useState(false);
    const [csvProgress, setCsvProgress] = useState<{ fetched: number; total: number } | null>(null);
    const csvCancelRef = useRef(false);

    const requestSeqRef = useRef(0);

    // Server filter — only locationId is a column on warehouse_stock; category
    // and search hit catalog joins, so we filter those over the visible page.
    const filterPayload = useMemo(() => ({
        locationId: locationFilter === 'all' ? null : locationFilter,
    }), [locationFilter]);

    const loadCount = useCallback(async () => {
        try {
            const c = await rpcAction('warehouse:count_stock', filterPayload);
            if (typeof c === 'number') setTotalCount(c);
        } catch { /* non-fatal */ }
    }, [rpcAction, filterPayload]);

    // Async fetch only — the loading flag is raised by the render-time tracker
    // below (on a refetch trigger) or by the initial useState(true), so this
    // sets state only after its awaited RPC and runs cleanly inside the effect.
    const load = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        try {
            const r = await rpcAction('warehouse:list_stock', {
                ...filterPayload,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (seq !== requestSeqRef.current) return;
            setStock(Array.isArray(r) ? r : []);
            setHasLoadedOnce(true);
        } catch (err: any) {
            if (seq !== requestSeqRef.current) return;
            addToast('Failed to load stock', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [rpcAction, filterPayload, page, addToast]);

    const isFirstFilterChangeRef = useRef(true);
    useEffect(() => {
        if (isFirstFilterChangeRef.current) { isFirstFilterChangeRef.current = false; return; }
        setPage(0);
    }, [filterPayload]);

    // Raise the loading flag during render whenever a refetch is about to run:
    // the filter (filterPayload), the page, or the parent refreshKey changed.
    // These are exactly the inputs that change load()'s identity and re-trigger
    // the fetch effect below. React re-renders before paint, so this is
    // behavior-equivalent to the old synchronous setLoading(true) at the top of
    // load(); the initial load is already covered by useState(true). The async
    // fetch then only resolves the result and clears the flag.
    const [prevFetchKey, setPrevFetchKey] = useState({ filterPayload, page, refreshKey });
    if (
        prevFetchKey.filterPayload !== filterPayload ||
        prevFetchKey.page !== page ||
        prevFetchKey.refreshKey !== refreshKey
    ) {
        setPrevFetchKey({ filterPayload, page, refreshKey });
        setLoading(true);
    }

    useEffect(() => {
        void (async () => { await load(); })();
    }, [load, refreshKey]);
    useEffect(() => {
        void (async () => { await loadCount(); })();
    }, [loadCount, refreshKey]);

    const handleStartCsvExport = useCallback(async () => {
        setCsvExporting(true);
        csvCancelRef.current = false;
        const collected: StockExportRow[] = [];
        let filename: string | null = null;
        let offset = 0;
        try {
            while (true) {
                if (csvCancelRef.current) break;
                const page: any = await rpcAction('warehouse:export_csv', { offset, limit: CSV_EXPORT_PAGE_SIZE });
                if (!page || !Array.isArray(page.rows)) {
                    throw new Error('Server returned an unexpected response.');
                }
                if (offset === 0) {
                    filename = page.filename || `warehouse-${new Date().toISOString().slice(0, 10)}.csv`;
                }
                collected.push(...page.rows);
                setCsvProgress({ fetched: collected.length, total: page.total });
                if (page.nextOffset == null) break;
                offset = page.nextOffset;
            }

            if (csvCancelRef.current) {
                addToast('Export cancelled', <i className="fa-solid fa-ban" />,
                    'bg-amber-500/10 text-amber-400 border-amber-500/50',
                    { description: `${collected.length} row${collected.length === 1 ? '' : 's'} fetched before cancel.` });
                return;
            }

            const lines = [CSV_HEADER.join(',')];
            for (const r of collected) {
                lines.push([
                    csvEscape(r.commodity),
                    csvEscape(r.quality),
                    csvEscape(r.category),
                    csvEscape(r.unit),
                    csvEscape(r.location),
                    csvEscape(r.onHand),
                    csvEscape(r.reserved),
                    csvEscape(r.notes),
                ].join(','));
            }
            const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename || `warehouse-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            addToast('Stock exported', <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                { description: `${collected.length} row${collected.length === 1 ? '' : 's'} written to ${a.download}.` });
        } catch (err: any) {
            addToast('Export failed', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not export stock.' });
        } finally {
            setCsvExporting(false);
        }
    }, [rpcAction, addToast]);

    const handleCancelCsvExport = useCallback(() => {
        csvCancelRef.current = true;
    }, []);

    const requestReservedByStock = useMemo(() => {
        const m = new Map<number, number>();
        for (const r of warehouseRequests) {
            if (r.status === 'pending' || r.status === 'approved') {
                m.set(r.stockId, (m.get(r.stockId) || 0) + r.requestedQuantity);
            }
        }
        return m;
    }, [warehouseRequests]);

    // Client-side category + name search across the visible page (joined cols).
    const visible = useMemo(() => {
        const q = debouncedSearch.toLowerCase();
        return stock.filter((s) => {
            if (categoryFilter !== 'all' && s.catalog?.category !== categoryFilter) return false;
            if (q) {
                const name = (s.catalog?.name || '').toLowerCase();
                const quality = (s.catalog?.qualityLabel || '').toLowerCase();
                if (!name.includes(q) && !quality.includes(q)) return false;
            }
            return true;
        });
    }, [stock, categoryFilter, debouncedSearch]);

    const grouped = useMemo(() => {
        const groups = new Map<string, { name: string; rows: WarehouseStock[] }>();
        for (const s of visible) {
            const key = s.location?.name || 'Unspecified Location';
            if (!groups.has(key)) groups.set(key, { name: key, rows: [] });
            groups.get(key)!.rows.push(s);
        }
        return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [visible]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 bg-slate-900 rounded-lg border border-white/10 p-1 overflow-x-auto custom-scrollbar max-w-full">
                    {(['all', 'ore', 'refined', 'fuel', 'rmc', 'munition', 'consumable', 'misc'] as const).map((cat) => (
                        <button
                            key={cat}
                            onClick={() => setCategoryFilter(cat)}
                            className={`shrink-0 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest transition whitespace-nowrap ${
                                categoryFilter === cat ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            {cat === 'all' ? 'All' : CATEGORY_LABEL[cat]}
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
                    onClick={csvExporting ? handleCancelCsvExport : handleStartCsvExport}
                    disabled={totalCount === 0 && !csvExporting}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest border transition disabled:opacity-50 ${
                        csvExporting
                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-white/10'
                    }`}
                    title={csvExporting ? 'Cancel CSV export' : 'Export all stock rows to CSV'}
                >
                    <i className={`fa-solid ${csvExporting ? 'fa-ban' : 'fa-file-csv'}`} />
                    {csvExporting ? 'Cancel' : 'Export CSV'}
                </button>
                {canManage && (
                    <button
                        onClick={onCreateStock}
                        className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition"
                    >
                        <i className="fa-solid fa-plus" /> Add Stock
                    </button>
                )}
            </div>

            {csvProgress && csvExporting && (
                <div className="rounded-xl border border-cyan-500/20 bg-slate-900/40 p-3 flex items-center gap-3">
                    <i className="fa-solid fa-file-csv text-cyan-300 text-xs" />
                    <div className="flex-1">
                        <div className="flex justify-between text-[10px] text-slate-400 uppercase tracking-widest font-black mb-1">
                            <span>Exporting CSV</span>
                            <span>{csvProgress.fetched} / {csvProgress.total}</span>
                        </div>
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-cyan-400 transition-all"
                                style={{ width: `${Math.min(100, Math.round((csvProgress.fetched / Math.max(1, csvProgress.total)) * 100))}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {loading && !hasLoadedOnce ? (
                <SkeletonCardGrid count={9} accent="cyan" />
            ) : visible.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 p-10 text-center text-slate-500 text-sm">
                    {totalCount === 0 ? 'No stock placed yet. Use "Add Stock" to seed your first commodity at a location.' : 'No commodities match the current filters.'}
                </div>
            ) : (
                <div className={`space-y-6 ${loading ? 'opacity-60 transition-opacity' : ''}`}>
                    {grouped.map((group) => (
                        <div key={group.name}>
                            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.25em] mb-3 flex items-center gap-2">
                                <i className="fa-solid fa-location-dot text-cyan-400" /> {group.name}
                                <span className="font-mono text-slate-600 tracking-normal">· {group.rows.length}</span>
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {group.rows.map((s) => {
                                    const lowStock = s.quantityOnHand === 0;
                                    const reserved = s.quantityReserved > 0;
                                    return (
                                        <div key={s.id} className="rounded-lg border border-cyan-500/20 bg-slate-900/40 overflow-hidden flex">
                                            <div className="w-1 shrink-0 bg-cyan-500" aria-hidden />
                                            <div className="flex-1 p-4 flex flex-col min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-300">
                                                        {s.catalog?.category ? CATEGORY_LABEL[s.catalog.category] : 'Misc'}
                                                    </span>
                                                    {s.catalog?.qualityLabel && (
                                                        <span className="text-[10px] font-mono text-slate-500">· {s.catalog.qualityLabel}</span>
                                                    )}
                                                </div>
                                                <div className="text-sm font-bold text-white truncate mb-2">
                                                    {s.catalog?.name || 'Unknown commodity'}
                                                </div>
                                                <div className="flex items-baseline gap-3 mt-1">
                                                    <div>
                                                        <div className={`text-2xl font-black font-mono ${lowStock ? 'text-rose-300' : 'text-white'}`}>
                                                            {s.quantityOnHand}
                                                        </div>
                                                        <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                                                            On hand · {s.catalog?.unit || 'units'}
                                                        </div>
                                                    </div>
                                                    {reserved && (
                                                        <ReservedBadge
                                                            quantityReserved={s.quantityReserved}
                                                            fromRequests={requestReservedByStock.get(s.id) || 0}
                                                        />
                                                    )}
                                                </div>
                                                <div className="flex-1" />
                                                <div className="flex items-center gap-3 pt-3 mt-3 border-t border-white/5 flex-wrap">
                                                    {canManage && (
                                                        <button
                                                            onClick={() => onAdjust(s)}
                                                            className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-cyan-200"
                                                            title="Adjust stock"
                                                        >
                                                            <i className="fa-solid fa-sliders mr-1" />Adjust
                                                        </button>
                                                    )}
                                                    {canManage && (
                                                        <button
                                                            onClick={() => onTransfer(s)}
                                                            className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-cyan-200"
                                                            title="Transfer to another location"
                                                            disabled={s.quantityOnHand === 0}
                                                        >
                                                            <i className="fa-solid fa-arrow-right-arrow-left mr-1" />Transfer
                                                        </button>
                                                    )}
                                                    {canAdmin && s.catalog && (
                                                        <button
                                                            onClick={() => onEditCommodity(s)}
                                                            className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-cyan-200"
                                                            title="Edit commodity — change name, quality, unit, category, or description"
                                                        >
                                                            <i className="fa-solid fa-pen mr-1" />Edit commodity
                                                        </button>
                                                    )}
                                                    {canManage && (
                                                        <button
                                                            onClick={() => onDelete(s)}
                                                            className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-rose-300"
                                                            title="Delete this stock row from the location"
                                                        >
                                                            <i className="fa-solid fa-trash mr-1" />Delete
                                                        </button>
                                                    )}
                                                    <div className="flex-1" />
                                                    {canRequest && (
                                                        <button
                                                            onClick={() => onRequest(s)}
                                                            disabled={s.quantityOnHand === 0}
                                                            title={s.quantityOnHand === 0 ? 'No stock available to request' : 'Request a withdrawal'}
                                                            className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 hover:text-cyan-200 disabled:text-slate-600 disabled:hover:text-slate-600 disabled:cursor-not-allowed"
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
                        </div>
                    ))}
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
        </div>
    );
}
