import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useAuth } from '../../../contexts/AuthContext';

import { mergeRowSlice, byCreatedAtDesc } from '../../../lib/sliceMerge';
import HeroShell from '../../shared/ui/HeroShell';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import type {
    QmCatalogItem,
    QmLocation,
    QmInventoryItem,
    QmIssuance,
    QmLowStockRow,
    QmMemberRecord,
    QmOverview,
    QmUserRef,
} from '../../../types';
import { Skeleton } from '../../shared/ui/Skeleton';
import QmOverviewTab from './QmOverviewTab';
import QmArmoryTab from './QmArmoryTab';
import QmIssuancesTab from './QmIssuancesTab';
import QmCatalogTab from './QmCatalogTab';
import QmSettingsTab from './QmSettingsTab';
import CreateInventoryModal from './CreateInventoryModal';
import CreateLocationModal from './CreateLocationModal';
import IssueKitModal from './IssueKitModal';
import ReturnIssuanceModal from './ReturnIssuanceModal';
import ReturnManyModal from './ReturnManyModal';
import WriteOffIssuanceModal from './WriteOffIssuanceModal';
import { useNotification } from '../../../contexts/NotificationContext';

interface IssueKitTarget {
    seedItem?: QmInventoryItem;
    seedMember?: QmUserRef;
    lockMember?: boolean;
}

interface ReturnManyTarget {
    member: QmUserRef;
    issuances: QmIssuance[];
}

type Tab = 'overview' | 'armory' | 'issuances' | 'catalog' | 'settings';

const TABS: readonly { key: Tab; label: string; icon: string; permission?: string }[] = [
    { key: 'overview',  label: 'Overview',  icon: 'fa-gauge-high' },
    { key: 'armory',    label: 'Armory',    icon: 'fa-boxes-stacked' },
    { key: 'issuances', label: 'Issuances', icon: 'fa-clipboard-list' },
    { key: 'catalog',   label: 'Catalog',   icon: 'fa-book' },
    { key: 'settings',  label: 'Settings',  icon: 'fa-gear', permission: 'qm:manage' },
];

// Stable keys for the fixed-length loading-skeleton placeholders. The lists are
// static (never reordered/filtered/inserted), so these module-scope identifiers
// give each placeholder a stable, unique key without leaning on the array index.
const SKELETON_CARD_KEYS = ['sk-card-0', 'sk-card-1', 'sk-card-2', 'sk-card-3'] as const;
const SKELETON_ROW_KEYS = ['sk-row-0', 'sk-row-1', 'sk-row-2', 'sk-row-3'] as const;

export default function QuartermasterView() {
    const { rpcAction } = useData();
    const { allUsers } = useMembers();
    const { hasPermission, currentUser } = useAuth();
    const { addToast } = useNotification();

    const [tab, setTab] = useState<Tab>('overview');
    const [overview, setOverview] = useState<QmOverview | null>(null);
    const [catalog, setCatalog] = useState<QmCatalogItem[]>([]);
    const [locations, setLocations] = useState<QmLocation[]>([]);
    const [issuances, setIssuances] = useState<QmIssuance[]>([]);
    const [memberRecords, setMemberRecords] = useState<QmMemberRecord[]>([]);
    const [lowStock, setLowStock] = useState<QmLowStockRow[]>([]);
    const [lowStockLoading, setLowStockLoading] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    // Bumped after sibling actions that mutate inventory/stock so the
    // self-fetching tabs (QmArmoryTab, IssueKitModal) re-pull. Keeps the
    // parent free of having to hold the full inventory list.
    const [armoryRefreshKey, setArmoryRefreshKey] = useState(0);

    const [createInventoryOpen, setCreateInventoryOpen] = useState(false);
    const [createLocationOpen, setCreateLocationOpen] = useState(false);
    const [issueTarget, setIssueTarget] = useState<IssueKitTarget | null>(null);
    const [returnTarget, setReturnTarget] = useState<QmIssuance | null>(null);
    const [returnManyTarget, setReturnManyTarget] = useState<ReturnManyTarget | null>(null);
    const [writeOffTarget, setWriteOffTarget] = useState<QmIssuance | null>(null);

    const canView    = hasPermission('qm:view');
    const canRequest = hasPermission('qm:request');
    const canManage  = hasPermission('qm:manage');
    const canAdmin   = hasPermission('qm:admin');

    const visibleTabs = useMemo(
        () => TABS.filter((t) => !t.permission || hasPermission(t.permission)),
        [hasPermission],
    );

    // Per-slice refreshers — each broadcast event refreshes only the slice it
    // affects, instead of re-fetching all 6 datasets every time. Mount loads
    // overview + the slices the active tab needs; other slices lazy-load on
    // tab switch.
    const errToast = useCallback((label: string, err: any) => {
        addToast(`Failed to load ${label}`, <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
    }, [addToast]);

    const refreshOverview = useCallback(async () => {
        if (!canView) return;
        try { setOverview(await rpcAction('qm:get_overview', {})); }
        catch (err: any) { errToast('overview', err); }
    }, [rpcAction, canView, errToast]);

    // Bounded low-stock list for the overview card. The threshold defaults to
    // 2 server-side; we only request the top 12 rows so the payload stays in
    // the kilobyte range even on orgs with hundreds of SKUs.
    const refreshLowStock = useCallback(async () => {
        if (!canView) return;
        setLowStockLoading(true);
        try { setLowStock((await rpcAction('qm:list_low_stock', { limit: 12 })) || []); }
        catch (err: any) { errToast('low stock', err); }
        finally { setLowStockLoading(false); }
    }, [rpcAction, canView, errToast]);

    const refreshCatalog = useCallback(async () => {
        if (!canView) return;
        try { setCatalog((await rpcAction('qm:list_catalog', {})) || []); }
        catch (err: any) { errToast('catalog', err); }
    }, [rpcAction, canView, errToast]);

    const refreshLocations = useCallback(async () => {
        if (!canView) return;
        try { setLocations((await rpcAction('qm:list_locations', {})) || []); }
        catch (err: any) { errToast('locations', err); }
    }, [rpcAction, canView, errToast]);

    // QmArmoryTab self-fetches its own paginated/filtered inventory. The
    // parent only signals via a refresh key when sibling actions (issue,
    // return, write-off) mutate inventory so the tab knows to re-pull.
    const bumpArmoryRefresh = useCallback(() => { setArmoryRefreshKey((k) => k + 1); }, []);
    const refreshInventory = bumpArmoryRefresh;

    const refreshIssuances = useCallback(async () => {
        if (!canView) return;
        try { setIssuances((await rpcAction('qm:list_issuances', { limit: 200 })) || []); }
        catch (err: any) { errToast('issuances', err); }
    }, [rpcAction, canView, errToast]);

    const refreshMemberRecords = useCallback(async () => {
        if (!canView) return;
        try { setMemberRecords((await rpcAction('qm:list_member_records', {})) || []); }
        catch (err: any) { errToast('member records', err); }
    }, [rpcAction, canView, errToast]);

    // Composite refresh — used by mutation flows where multiple slices may
    // change (e.g. issue-direct decrements stock AND creates an issuance).
    const refresh = useCallback(async () => {
        await Promise.all([refreshOverview(), refreshInventory(), refreshIssuances(), refreshMemberRecords()]);
    }, [refreshOverview, refreshInventory, refreshIssuances, refreshMemberRecords]);

    // Mount: load overview + locations always (cheap, used in headers),
    // then defer the heavy slices to the per-tab effect below.
    useEffect(() => {
        if (!canView) return;
        let cancelled = false;
        (async () => {
            setIsLoading(true);
            try {
                await Promise.all([refreshOverview(), refreshLocations(), refreshCatalog(), refreshLowStock()]);
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [canView, refreshOverview, refreshLocations, refreshCatalog, refreshLowStock]);

    // Tab-aware lazy load for issuances. Inventory is self-fetched by
    // QmArmoryTab (and IssueKitModal) so the parent never holds it.
    const loadedSlicesRef = useRef<{ issuances: boolean; memberRecords: boolean }>({
        issuances: false, memberRecords: false,
    });
    useEffect(() => {
        if (!canView) return;
        if (tab === 'issuances') {
            if (!loadedSlicesRef.current.issuances) { loadedSlicesRef.current.issuances = true; refreshIssuances(); }
            if (!loadedSlicesRef.current.memberRecords) { loadedSlicesRef.current.memberRecords = true; refreshMemberRecords(); }
        }
    }, [tab, canView, refreshIssuances, refreshMemberRecords]);

    // Live updates: refresh only the slice(s) an event changed; when the emit
    // carries row id(s), fetch ONLY those rows and splice them into local state
    // (null = row gone → removed). Id-less payloads or slice-fetch errors fall
    // back to the per-slice list refresh; aggregates stay full refetches.
    // Accepted race (no generation guard here): a local mutation's own list
    // refresh can resolve after the splice and briefly re-apply the old list;
    // self-heals on the next broadcast.
    useEffect(() => {
        const onCatalogUpdate = async (payload: { payload?: { catalogId?: number; bulk?: boolean } }) => {
            const catalogId = payload.payload?.catalogId;
            if (typeof catalogId !== 'number') { void refreshCatalog(); return; }
            try {
                const item: QmCatalogItem | null = await rpcAction('qm:get_catalog_item', { catalogId });
                setCatalog(prev => mergeRowSlice(prev, item ?? null, catalogId));
            } catch (err) {
                console.error('qm catalog slice failed; falling back to list refresh:', err);
                void refreshCatalog();
            }
        };
        const onLocationUpdate = async (payload: { payload?: { locationId?: number } }) => {
            const locationId = payload.payload?.locationId;
            if (typeof locationId !== 'number') { void refreshLocations(); return; }
            try {
                const loc: QmLocation | null = await rpcAction('qm:get_location', { locationId });
                setLocations(prev => mergeRowSlice(prev, loc ?? null, locationId));
            } catch (err) {
                console.error('qm location slice failed; falling back to list refresh:', err);
                void refreshLocations();
            }
        };
        const onIssuanceUpdate = async (payload: { payload?: { issuanceId?: number; issuanceIds?: number[] } }) => {
            const p = payload.payload ?? {};
            const ids = Array.isArray(p.issuanceIds)
                ? p.issuanceIds.filter((n): n is number => typeof n === 'number')
                : (typeof p.issuanceId === 'number' ? [p.issuanceId] : []);
            if (ids.length === 0) void refreshIssuances();
            else {
                try {
                    const fetched: (QmIssuance | null)[] = await Promise.all(
                        ids.map((issuanceId) => rpcAction('qm:get_issuance', { issuanceId })),
                    );
                    setIssuances(prev => {
                        let next = prev;
                        fetched.forEach((issuance, i) => {
                            next = mergeRowSlice(next, issuance ?? null, ids[i], byCreatedAtDesc);
                        });
                        return next;
                    });
                } catch (err) {
                    console.error('qm issuance slice failed; falling back to list refresh:', err);
                    void refreshIssuances();
                }
            }
            // Aggregates + the per-user rollup recompute regardless.
            void refreshMemberRecords();
            bumpArmoryRefresh();   // issue/return mutates qty on hand
            void refreshOverview();
            void refreshLowStock();
        };
        // Don't wire handlers when the viewer can't read QM — the locked view
        // otherwise fires a denied RPC on every org mutation.
        if (!canView) return;
        // The qm:* broadcasts arrive via DataCore's single PRIVATE 'db-changes'
        // channel and are relayed as window CustomEvents (handler attachment is
        // qm:view-gated there). Never subscribe to the 'db-changes' topic from a
        // view: supabase-js dedupes channels by topic, so a view-owned channel
        // object IS DataCore's channel and removeChannel() on unmount would kill
        // all org realtime app-wide.
        const catalog = (e: Event) => { void onCatalogUpdate({ payload: (e as CustomEvent).detail }); };
        const location = (e: Event) => { void onLocationUpdate({ payload: (e as CustomEvent).detail }); };
        const inventory = () => {
            bumpArmoryRefresh();   // QmArmoryTab self-fetches on key bump
            refreshOverview();     // overview totals come from SQL aggregate now
            refreshLowStock();     // low-stock card may have changed
        };
        const issuance = (e: Event) => { void onIssuanceUpdate({ payload: (e as CustomEvent).detail }); };
        const reset = () => { void refresh(); }; // post-admin-reset: module is empty — full refresh
        window.addEventListener('app:realtime:qm:catalog_update', catalog);
        window.addEventListener('app:realtime:qm:location_update', location);
        window.addEventListener('app:realtime:qm:inventory_update', inventory);
        window.addEventListener('app:realtime:qm:issuance_update', issuance);
        window.addEventListener('app:realtime:qm:reset', reset);
        return () => {
            window.removeEventListener('app:realtime:qm:catalog_update', catalog);
            window.removeEventListener('app:realtime:qm:location_update', location);
            window.removeEventListener('app:realtime:qm:inventory_update', inventory);
            window.removeEventListener('app:realtime:qm:issuance_update', issuance);
            window.removeEventListener('app:realtime:qm:reset', reset);
        };
    }, [rpcAction, refreshCatalog, refreshLocations, bumpArmoryRefresh, refreshIssuances, refreshMemberRecords, refreshOverview, refreshLowStock, canView, refresh]);

    if (!canView) {
        return (
            <div className="p-8">
                <EmptyState
                    icon="fa-lock"
                    accent="orange"
                    heading="You don't have access to Quartermaster"
                    description="Ask an admin to grant you the qm:view permission."
                />
            </div>
        );
    }

    // First-run = a brand new org with no locations defined yet. Once locations
    // exist the user is past the bootstrap phase. Inventory presence is no
    // longer checked here (the parent doesn't load it).
    const firstRun = !isLoading && locations.length === 0;
    const pendingRequestsCount = overview?.pendingRequests ?? 0;
    const overdueCount = overview?.overdueCount ?? 0;

    return (
        <div className="h-full flex flex-col overflow-hidden bg-slate-950 text-white animate-fade-in">
            <HeroShell
                chipLabel="MODULE · QUARTERMASTER"
                chipIcon="fa-warehouse"
                chipAccent="orange"
                title="Org Armoury"
                subtitle="Track physical in-game assets across your locations. Issue kit to members for operations and log returns with outcomes — the movement ledger keeps the stock totals honest."
                actions={canManage && !firstRun && (
                    <HeroActionButton onClick={() => setCreateInventoryOpen(true)} accent="orange" icon="fa-plus">
                        Add Stock
                    </HeroActionButton>
                )}
                tabs={!firstRun ? visibleTabs.map((t) => {
                    const active = tab === t.key;
                    const badgeCount = t.key === 'issuances' ? pendingRequestsCount + overdueCount : 0;
                    return (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap flex items-center gap-2 ${
                                active ? 'border-orange-400 text-orange-300' : 'border-transparent text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            <i className={`fa-solid ${t.icon}`} /> {t.label}
                            {badgeCount > 0 && (
                                <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-orange-500/20 text-orange-300 text-[10px] font-bold px-1.5">
                                    {badgeCount}
                                </span>
                            )}
                        </button>
                    );
                }) : undefined}
            />

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
                {isLoading && (
                    // Skeleton mimics the metric-card row + content slot so the
                    // page layout doesn't jump when data lands.
                    <div className="space-y-8" aria-busy="true" aria-live="polite">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            {SKELETON_CARD_KEYS.map((k) => (
                                <div key={k} className="rounded-xl border border-white/5 bg-slate-900/40 p-5 space-y-3 animate-pulse">
                                    <Skeleton className="h-3 w-16" />
                                    <Skeleton className="h-8 w-24" />
                                    <Skeleton className="h-3 w-32" />
                                </div>
                            ))}
                        </div>
                        <div className="space-y-2">
                            {SKELETON_ROW_KEYS.map((k) => (
                                <Skeleton key={k} className="h-12 w-full" />
                            ))}
                        </div>
                    </div>
                )}

                {!isLoading && firstRun && (
                    <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-10 space-y-6">
                        <EmptyState
                            icon="fa-warehouse"
                            accent="orange"
                            heading="Set up your armoury"
                            description="Start by creating a storage location (e.g. 'Main Hangar'), then add your first stock entry. Catalog items are optional — you can also use free-text custom names."
                        />
                        {canManage && (
                            <div className="flex flex-wrap items-center justify-center gap-3">
                                <button
                                    onClick={() => setCreateLocationOpen(true)}
                                    className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white px-5 py-2.5 rounded-lg font-bold uppercase tracking-widest text-xs transition-all"
                                >
                                    <i className="fa-solid fa-map-location-dot" /> Create first location
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {!isLoading && !firstRun && tab === 'overview' && overview && (
                    <QmOverviewTab
                        overview={overview}
                        lowStock={lowStock}
                        lowStockLoading={lowStockLoading}
                        onOpenArmory={() => setTab('armory')}
                        onOpenIssuances={() => setTab('issuances')}
                    />
                )}

                {!isLoading && !firstRun && tab === 'armory' && (
                    <QmArmoryTab
                        locations={locations}
                        canManage={canManage}
                        canRequest={canRequest}
                        onIssue={canManage ? (item) => setIssueTarget({ seedItem: item }) : undefined}
                        onCreate={canManage ? () => setCreateInventoryOpen(true) : undefined}
                        refreshKey={armoryRefreshKey}
                    />
                )}

                {!isLoading && !firstRun && tab === 'issuances' && (
                    <QmIssuancesTab
                        issuances={issuances}
                        memberRecords={memberRecords}
                        canManage={canManage}
                        onFulfil={async (issuanceId) => {
                            try {
                                await rpcAction('qm:fulfil_issuance', { issuanceId });
                                addToast('Issuance fulfilled', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
                                refresh();
                            } catch (err: any) {
                                addToast('Fulfilment failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
                            }
                        }}
                        onReturn={(iss) => setReturnTarget(iss)}
                        onWriteOff={(iss) => setWriteOffTarget(iss)}
                        onIssueKit={canManage ? () => setIssueTarget({}) : undefined}
                        onIssueToMember={canManage ? (member) => setIssueTarget({ seedMember: member, lockMember: true }) : undefined}
                        onReturnFromMember={canManage ? (member, active) => setReturnManyTarget({ member, issuances: active }) : undefined}
                    />
                )}

                {!isLoading && !firstRun && tab === 'catalog' && (
                    <QmCatalogTab
                        catalog={catalog}
                        canAdmin={canAdmin}
                        onRefresh={refresh}
                    />
                )}

                {!isLoading && !firstRun && tab === 'settings' && canManage && (
                    <QmSettingsTab
                        locations={locations}
                        onCreateLocation={() => setCreateLocationOpen(true)}
                        onRefresh={refresh}
                    />
                )}
                </div>
            </div>

            {createInventoryOpen && (
                <CreateInventoryModal
                    hasOrgCatalogItems={catalog.length > 0}
                    locations={locations}
                    onClose={() => setCreateInventoryOpen(false)}
                    onSubmitted={() => { setCreateInventoryOpen(false); refresh(); }}
                />
            )}
            {createLocationOpen && (
                <CreateLocationModal
                    locations={locations}
                    onClose={() => setCreateLocationOpen(false)}
                    onSubmitted={() => { setCreateLocationOpen(false); refresh(); }}
                />
            )}
            {issueTarget && (
                <IssueKitModal
                    members={allUsers}
                    seedItem={issueTarget.seedItem}
                    seedMember={issueTarget.seedMember}
                    lockMember={issueTarget.lockMember}
                    onClose={() => setIssueTarget(null)}
                    onSubmitted={() => { setIssueTarget(null); refresh(); }}
                />
            )}
            {returnTarget && (
                <ReturnIssuanceModal
                    issuance={returnTarget}
                    onClose={() => setReturnTarget(null)}
                    onSubmitted={() => { setReturnTarget(null); refresh(); }}
                />
            )}
            {returnManyTarget && (
                <ReturnManyModal
                    member={returnManyTarget.member}
                    issuances={returnManyTarget.issuances}
                    onClose={() => setReturnManyTarget(null)}
                    onSubmitted={() => { setReturnManyTarget(null); refresh(); }}
                />
            )}
            {writeOffTarget && (
                <WriteOffIssuanceModal
                    issuance={writeOffTarget}
                    onClose={() => setWriteOffTarget(null)}
                    onSubmitted={() => { setWriteOffTarget(null); refresh(); }}
                />
            )}
        </div>
    );
}
