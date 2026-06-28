import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useWarehouse } from '../../../contexts/WarehouseContext';
import { useAuth } from '../../../contexts/AuthContext';
import HeroShell from '../../shared/ui/HeroShell';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import { Skeleton } from '../../shared/ui/Skeleton';
import type {
    WarehouseCatalogItem,
    WarehouseStock,
    WarehouseMovement,
    WarehouseOverview,
    QmLocation,
} from '../../../types';
import WhStockTab from './WhStockTab';
import WhMovementsTab from './WhMovementsTab';
import WhWithdrawalsTab from './WhWithdrawalsTab';
import WhCatalogTab from './WhCatalogTab';
import WhLocationsTab from './WhLocationsTab';
import WhAdjustStockDialog from './modals/WhAdjustStockDialog';
import WhTransferStockDialog from './modals/WhTransferStockDialog';
import WhWithdrawalRequestDialog from './modals/WhWithdrawalRequestDialog';
import WhCatalogEditDialog from './modals/WhCatalogEditDialog';
import WhStockCreateDialog from './modals/WhStockCreateDialog';
import WhCreateLocationModal from './modals/WhCreateLocationModal';
import { useNotification } from '../../../contexts/NotificationContext';

type Tab = 'stock' | 'movements' | 'withdrawals' | 'catalog' | 'locations';

// Stable keys for the fixed-length loading skeletons (static, never reordered).
const STAT_SKELETON_KEYS = ['stat-0', 'stat-1', 'stat-2', 'stat-3'] as const;
const ROW_SKELETON_KEYS = ['row-0', 'row-1', 'row-2', 'row-3'] as const;

const TABS: readonly { key: Tab; label: string; icon: string; managerOnly?: boolean }[] = [
    { key: 'stock',       label: 'Stock',       icon: 'fa-boxes-stacked' },
    { key: 'movements',   label: 'Movements',   icon: 'fa-clock-rotate-left' },
    { key: 'withdrawals', label: 'Withdrawals', icon: 'fa-clipboard-list' },
    { key: 'catalog',     label: 'Catalog',     icon: 'fa-book' },
    { key: 'locations',   label: 'Locations',   icon: 'fa-map-location-dot', managerOnly: true },
];

export default function WarehouseView() {
    const { rpcAction } = useData();
    const { refreshWarehouse, warehouseCatalog, warehouseStock, warehouseRequests } = useWarehouse();
    const { hasPermission } = useAuth();
    const { addToast, confirm } = useNotification();

    const [tab, setTab] = useState<Tab>('stock');
    const [overview, setOverview] = useState<WarehouseOverview | null>(null);
    const [movements, setMovements] = useState<WarehouseMovement[]>([]);
    const [movementsLoading, setMovementsLoading] = useState(false);
    const [locations, setLocations] = useState<QmLocation[]>([]);

    const [adjustTarget, setAdjustTarget] = useState<WarehouseStock | null>(null);
    const [transferTarget, setTransferTarget] = useState<WarehouseStock | null>(null);
    const [withdrawalTarget, setWithdrawalTarget] = useState<WarehouseStock | null>(null);
    const [catalogEditTarget, setCatalogEditTarget] = useState<WarehouseCatalogItem | 'new' | null>(null);
    const [stockCreateOpen, setStockCreateOpen] = useState(false);
    const [locationCreateOpen, setLocationCreateOpen] = useState(false);

    const canView    = hasPermission('warehouse:view');
    const canRequest = hasPermission('warehouse:request');
    const canManage  = hasPermission('warehouse:manage');
    const canAdmin   = hasPermission('warehouse:admin');

    const visibleTabs = useMemo(
        () => TABS.filter((t) => !t.managerOnly || canManage),
        [canManage],
    );

    const loadLocations = useCallback(async () => {
        if (!canView) return;
        try {
            const rows: QmLocation[] = await rpcAction('warehouse:list_locations', {});
            setLocations(rows || []);
        } catch (err: any) {
            console.warn('[Warehouse] Failed to load locations:', err?.message);
        }
    }, [rpcAction, canView]);

    const refreshOverview = useCallback(async () => {
        if (!canView) return;
        try {
            const ov: WarehouseOverview = await rpcAction('warehouse:get_overview', {});
            setOverview(ov);
        } catch (err: any) {
            console.warn('[Warehouse] Failed to load overview:', err?.message);
        }
    }, [rpcAction, canView]);

    // Async fetch only — no synchronous loading set, so it can run inside the
    // tab-change effect without a cascading sync render. The loading flag is
    // raised separately by the imperative wrapper (event handlers) or by the
    // render-time tab tracker (on tab change) before this runs.
    const fetchMovements = useCallback(async () => {
        if (!canView) return;
        try {
            const rows: WarehouseMovement[] = await rpcAction('warehouse:list_movements', { limit: 200 });
            setMovements(rows || []);
        } catch (err: any) {
            addToast('Failed to load movements', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        } finally {
            setMovementsLoading(false);
        }
    }, [rpcAction, canView, addToast]);

    // Imperative refresh for event handlers (Refresh button, refreshAll): raise
    // the loading flag then fetch — identical to the previous loadMovements.
    const loadMovements = useCallback(async () => {
        if (!canView) return;
        setMovementsLoading(true);
        await fetchMovements();
    }, [canView, fetchMovements]);

    useEffect(() => {
        // Fire the three initial fetches concurrently (as before). Each is an
        // async request whose setState lands only after its awaited RPC
        // resolves — none runs synchronously on the effect's sync path.
        void (async () => { await refreshWarehouse(); })();
        void (async () => { await refreshOverview(); })();
        void (async () => { await loadLocations(); })();
    }, [refreshWarehouse, refreshOverview, loadLocations]);

    // Raise the movements loading flag during render when the Movements tab is
    // entered (React re-renders before paint), replacing the old in-effect
    // synchronous setMovementsLoading(true). The effect below then performs only
    // the async fetch — matching the previous "loadMovements on tab change".
    const [prevTab, setPrevTab] = useState(tab);
    if (tab !== prevTab) {
        setPrevTab(tab);
        if (tab === 'movements' && canView) setMovementsLoading(true);
    }

    useEffect(() => {
        if (tab !== 'movements') return;
        void (async () => { await fetchMovements(); })();
    }, [tab, fetchMovements]);

    const [stockRefreshKey, setStockRefreshKey] = useState(0);
    const bumpStockRefresh = useCallback(() => setStockRefreshKey((k) => k + 1), []);

    const refreshAll = useCallback(async () => {
        await refreshWarehouse();
        await refreshOverview();
        await loadLocations();
        bumpStockRefresh();
        if (tab === 'movements') await loadMovements();
    }, [refreshWarehouse, refreshOverview, loadLocations, loadMovements, tab, bumpStockRefresh]);

    const handleDeleteStock = useCallback(async (s: WarehouseStock) => {
        const itemName = s.catalog?.name || 'commodity';
        const quality = s.catalog?.qualityLabel ? ` · ${s.catalog.qualityLabel}` : '';
        const locName = s.location?.name || 'location';
        const unit = s.catalog?.unit || 'units';
        const ok = await confirm({
            title: `Delete ${itemName}${quality} at ${locName}?`,
            message: s.quantityOnHand > 0
                ? `This stock row holds ${s.quantityOnHand} ${unit}. Deleting wipes the row, its full movement history, and any historical withdrawal requests for it. Marketplace contracts that referenced it stay but become unlinked. The commodity remains in your catalog.`
                : 'Deletes this stock row and its movement history. The commodity remains in your catalog and can be re-added at any location.',
            confirmText: 'Delete Stock',
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await rpcAction('warehouse:delete_stock', { stockId: s.id });
            addToast('Stock deleted',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
                { description: `${itemName}${quality} at ${locName}` });
            await refreshAll();
        } catch (err: any) {
            addToast('Delete failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        }
    }, [confirm, rpcAction, addToast, refreshAll]);

    if (!canView) {
        return (
            <div className="p-8">
                <EmptyState
                    icon="fa-lock"
                    accent="cyan"
                    heading="You don't have access to Warehouse"
                    description="Ask an admin to grant you the warehouse:view permission."
                />
            </div>
        );
    }

    // Distinguish "definitely empty" from "still loading": during the initial
    // fetch the context arrays are [] and the overview is null.
    const initialLoading = overview === null && warehouseCatalog.length === 0 && warehouseStock.length === 0;
    const firstRun = !initialLoading && warehouseCatalog.length === 0 && warehouseStock.length === 0;
    const openRequestCount = overview?.openRequestCount ?? warehouseRequests.length;

    return (
        <div className="h-full flex flex-col overflow-hidden bg-slate-950 text-white animate-fade-in">
            <HeroShell
                chipLabel="MODULE · WAREHOUSE"
                chipIcon="fa-boxes-stacked"
                chipAccent="cyan"
                title="Org Warehouse"
                subtitle="Track bulk fungible commodities — ore, refined materials, fuel, RMC, missiles — across your warehouses. Stock totals are computed from an append-only movement ledger so concurrent adjustments stay honest."
                actions={canManage && !firstRun && (
                    <HeroActionButton onClick={() => setStockCreateOpen(true)} accent="cyan" icon="fa-plus">
                        Add Stock
                    </HeroActionButton>
                )}
                tabs={!firstRun ? visibleTabs.map((t) => {
                    const active = tab === t.key;
                    const badgeCount = t.key === 'withdrawals' ? openRequestCount : 0;
                    return (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`flex items-center gap-2 px-3 py-2 text-[11px] font-bold uppercase tracking-widest transition-colors border-b-2 ${
                                active
                                    ? 'text-cyan-200 border-cyan-400'
                                    : 'text-slate-400 hover:text-slate-200 border-transparent'
                            }`}
                        >
                            <i className={`fa-solid ${t.icon}`} />
                            {t.label}
                            {badgeCount > 0 && (
                                <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/20 text-amber-200 text-[10px] font-mono">
                                    {badgeCount}
                                </span>
                            )}
                        </button>
                    );
                }) : undefined}
            />

            <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 custom-scrollbar">
                {initialLoading ? (
                    <div className="space-y-6" aria-busy="true" aria-live="polite">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            {STAT_SKELETON_KEYS.map((key) => (
                                <div key={key} className="rounded-xl border border-white/5 bg-slate-900/40 p-5 space-y-3 animate-pulse">
                                    <Skeleton className="h-3 w-16" />
                                    <Skeleton className="h-8 w-24" />
                                    <Skeleton className="h-3 w-32" />
                                </div>
                            ))}
                        </div>
                        <div className="space-y-2">
                            {ROW_SKELETON_KEYS.map((key) => (
                                <Skeleton key={key} className="h-12 w-full" />
                            ))}
                        </div>
                    </div>
                ) : firstRun ? (
                    <EmptyState
                        icon="fa-boxes-stacked"
                        accent="cyan"
                        heading="No commodities yet"
                        description={canAdmin
                            ? 'Start by defining a commodity in the Catalog (e.g. "Iron Ore", quality "500-600", unit "SCU"). Then add stock at a location.'
                            : 'Ask an officer to set up your org\'s commodity catalog and warehouse stock.'}
                        action={canAdmin && (
                            <button
                                onClick={() => setCatalogEditTarget('new')}
                                className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest"
                            >
                                <i className="fa-solid fa-plus" /> Add Commodity
                            </button>
                        )}
                    />
                ) : tab === 'stock' ? (
                    <WhStockTab
                        locations={locations}
                        canManage={canManage}
                        canRequest={canRequest}
                        canAdmin={canAdmin}
                        onAdjust={(s) => setAdjustTarget(s)}
                        onTransfer={(s) => setTransferTarget(s)}
                        onDelete={handleDeleteStock}
                        onRequest={(s) => setWithdrawalTarget(s)}
                        onEditCommodity={(s) => { if (s.catalog) setCatalogEditTarget(s.catalog); }}
                        onCreateStock={() => setStockCreateOpen(true)}
                        refreshKey={stockRefreshKey}
                    />
                ) : tab === 'movements' ? (
                    <WhMovementsTab
                        movements={movements}
                        isLoading={movementsLoading}
                        onRefresh={loadMovements}
                    />
                ) : tab === 'withdrawals' ? (
                    <WhWithdrawalsTab
                        requests={warehouseRequests}
                        canManage={canManage}
                        onRefresh={refreshAll}
                    />
                ) : tab === 'catalog' ? (
                    <WhCatalogTab
                        catalog={warehouseCatalog}
                        canAdmin={canAdmin}
                        onEdit={(item) => setCatalogEditTarget(item)}
                        onAdd={() => setCatalogEditTarget('new')}
                        onCatalogChanged={() => refreshWarehouse()}
                    />
                ) : tab === 'locations' ? (
                    <WhLocationsTab
                        locations={locations}
                        canManage={canManage}
                        onCreate={() => setLocationCreateOpen(true)}
                        onRefresh={refreshAll}
                    />
                ) : null}
            </div>

            <WhAdjustStockDialog
                isOpen={adjustTarget !== null}
                stock={adjustTarget}
                onClose={() => setAdjustTarget(null)}
                onSubmitted={refreshAll}
            />
            <WhTransferStockDialog
                isOpen={transferTarget !== null}
                fromStock={transferTarget}
                onClose={() => setTransferTarget(null)}
                onSubmitted={refreshAll}
            />
            <WhWithdrawalRequestDialog
                isOpen={withdrawalTarget !== null}
                stock={withdrawalTarget}
                onClose={() => setWithdrawalTarget(null)}
                onSubmitted={refreshAll}
            />
            <WhStockCreateDialog
                isOpen={stockCreateOpen}
                onClose={() => setStockCreateOpen(false)}
                onSubmitted={refreshAll}
            />
            <WhCatalogEditDialog
                isOpen={catalogEditTarget !== null}
                target={catalogEditTarget}
                onClose={() => setCatalogEditTarget(null)}
                onSubmitted={refreshAll}
            />
            <WhCreateLocationModal
                isOpen={locationCreateOpen}
                locations={locations}
                onClose={() => setLocationCreateOpen(false)}
                onSubmitted={loadLocations}
            />
        </div>
    );
}
