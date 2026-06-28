// MarketplaceView — single-org internal marketplace (Listings Board + Order
// Queue). Lazy view: fetches the gated `marketplace` subset on mount, filters
// client-side, and refetches on the id-only realtime nudge. Mutations go through
// rpcAction → the permission-gated dispatcher; per-resource authz is server-side.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useNotification } from '../../../contexts/NotificationContext';
import apiService from '../../../services/apiService';
import { EmptyState } from '../../shared/ui';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import type { MarketplaceCategory, MarketplaceListing, MarketplaceContract, MarketplaceListingType } from '../../../types';
import { ListingCard, ContractRow } from './marketplaceUi';
import { LISTING_TYPE_META } from './marketplaceMeta';
import { CreateListingModal, ListingDetailModal } from './MarketplaceModals';
import ContractDetailModal from './ContractDetailModal';

const TYPE_FILTERS: { key: 'all' | MarketplaceListingType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'sell', label: 'Selling' },
    { key: 'buy', label: 'Buying' },
    { key: 'offer', label: 'Offering' },
    { key: 'request', label: 'Requesting' },
];

const MarketplaceView: React.FC = () => {
    const { rpcAction } = useData();
    const { currentUser, hasPermission } = useAuth();
    const { addToast } = useNotification();
    const meId = currentUser?.id ?? -1;
    const canList = hasPermission('marketplace:list');
    const canContract = hasPermission('marketplace:contract');

    const [categories, setCategories] = useState<MarketplaceCategory[]>([]);
    const [listings, setListings] = useState<MarketplaceListing[]>([]);
    const [contracts, setContracts] = useState<MarketplaceContract[]>([]);
    const [loading, setLoading] = useState(true);

    const [typeFilter, setTypeFilter] = useState<'all' | MarketplaceListingType>('all');
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const [search, setSearch] = useState('');
    const [queueTab, setQueueTab] = useState<'active' | 'history'>('active');

    const [showCreate, setShowCreate] = useState(false);
    const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
    const [selectedContractId, setSelectedContractId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await apiService.getStateSubset('marketplace');
            setCategories(data?.marketplaceCategories || []);
            setListings(data?.marketplaceListings || []);
            setContracts(data?.marketplaceContracts || []);
        } catch {
            /* keep current */
        } finally {
            setLoading(false);
        }
    }, []);

    // Mount fetch. load setStates only after its awaited subset fetch (or in
    // finally), so awaiting it from an async IIFE keeps every update on the
    // post-await path (no synchronous set-in-effect). `loading` initialises to
    // true, so the spinner shows on mount with no extra render pass.
    useEffect(() => { void (async () => { await load(); })(); }, [load]);

    // Realtime nudge → coalesced refetch.
    useEffect(() => {
        let t: ReturnType<typeof setTimeout> | null = null;
        const onUpdate = () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; load(); }, 400); };
        window.addEventListener('app:realtime:marketplace-update', onUpdate);
        return () => { window.removeEventListener('app:realtime:marketplace-update', onUpdate); if (t) clearTimeout(t); };
    }, [load]);

    const filteredListings = useMemo(() => {
        const q = search.trim().toLowerCase();
        return listings.filter((l) =>
            (typeFilter === 'all' || l.listingType === typeFilter) &&
            (categoryId == null || l.categoryId === categoryId) &&
            (!q || l.title.toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q)),
        );
    }, [listings, typeFilter, categoryId, search]);

    const { activeContracts, historyContracts } = useMemo(() => {
        const active: MarketplaceContract[] = [];
        const history: MarketplaceContract[] = [];
        for (const c of contracts) (c.status === 'completed' || c.status === 'cancelled' ? history : active).push(c);
        return { activeContracts: active, historyContracts: history };
    }, [contracts]);

    const runAction = useCallback(async (action: string, payload: Record<string, unknown>, okMsg: string): Promise<boolean> => {
        try {
            await rpcAction(action, payload);
            addToast(okMsg, <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50');
            await load();
            return true;
        } catch (e: any) {
            addToast('Action Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e?.message || 'Something went wrong.' });
            return false;
        }
    }, [rpcAction, addToast, load]);

    const selectedListing = listings.find((l) => l.id === selectedListingId) || null;
    const selectedContract = contracts.find((c) => c.id === selectedContractId) || null;

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · MARKETPLACE"
                chipIcon="fa-store"
                chipAccent="indigo"
                title="Marketplace"
                subtitle="Trade items and services within the org. Post a listing, propose a contract, hand off, and rate. Prices are in aUEC for negotiation — settle in-game."
                actions={canList ? (
                    <HeroActionButton onClick={() => setShowCreate(true)} accent="indigo" icon="fa-plus">New Listing</HeroActionButton>
                ) : undefined}
                stats={<>
                    <HeroStat icon="fa-store" label="Listings" value={listings.length} accent="indigo" emphasize={listings.length > 0} />
                    <HeroStat icon="fa-file-signature" label="My Listings" value={listings.filter((l) => l.sellerId === meId).length} accent="purple" />
                    <HeroStat icon="fa-clipboard-list" label="Active Contracts" value={activeContracts.length} accent="amber" emphasize={activeContracts.length > 0} />
                    <HeroStat icon="fa-circle-check" label="Completed" value={historyContracts.filter((c) => c.status === 'completed').length} accent="emerald" />
                </>}
            />

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 md:p-8 space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        {TYPE_FILTERS.map((f) => (
                            <button key={f.key} onClick={() => setTypeFilter(f.key)}
                                className={`text-[11px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-full border transition-colors ${typeFilter === f.key ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40' : 'bg-slate-800/40 text-slate-400 border-slate-700/50 hover:text-white'}`}>
                                {f.key !== 'all' && <i className={`fa-solid ${LISTING_TYPE_META[f.key as MarketplaceListingType].icon} mr-1.5`} aria-hidden />}{f.label}
                            </button>
                        ))}
                        <div className="ml-auto flex items-center gap-2">
                            <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
                                className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-white outline-hidden focus:border-indigo-500">
                                <option value="">All categories</option>
                                {categories.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '— ' : ''}{c.name}</option>)}
                            </select>
                            <div className="relative">
                                <i className="fa-solid fa-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs" aria-hidden />
                                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search"
                                    className="bg-slate-800 border border-slate-700 rounded-md pl-7 pr-2 py-1.5 text-xs text-white outline-hidden focus:border-indigo-500 w-32 sm:w-44" />
                            </div>
                        </div>
                    </div>

                    {loading ? (
                        <div className="text-center text-slate-500 py-16"><i className="fa-solid fa-spinner animate-spin text-2xl"></i></div>
                    ) : filteredListings.length === 0 ? (
                        <EmptyState icon="fa-store-slash" accent="indigo" heading="No listings" description={listings.length === 0 ? 'Nothing on the market yet. Be the first to post a listing.' : 'No listings match these filters.'} />
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {filteredListings.map((l) => <ListingCard key={l.id} listing={l} onClick={() => setSelectedListingId(l.id)} />)}
                        </div>
                    )}
                </div>

                <div className="space-y-3">
                    <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                        <div className="px-4 py-3 bg-slate-800/50 border-b border-slate-700/50 flex items-center justify-between">
                            <h3 className="text-xs font-black uppercase tracking-wider text-white"><i className="fa-solid fa-clipboard-list mr-2 text-indigo-400"></i>My Contracts</h3>
                            <div className="flex gap-1">
                                {(['active', 'history'] as const).map((t) => (
                                    <button key={t} onClick={() => setQueueTab(t)}
                                        className={`text-[10px] font-bold uppercase px-2 py-1 rounded-sm transition-colors ${queueTab === t ? 'bg-indigo-500/15 text-indigo-300' : 'text-slate-500 hover:text-white'}`}>
                                        {t === 'active' ? `Active (${activeContracts.length})` : 'History'}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="p-3 space-y-2 max-h-[70vh] overflow-y-auto">
                            {(queueTab === 'active' ? activeContracts : historyContracts).length === 0 ? (
                                <p className="text-center text-slate-600 text-xs py-8 italic">{queueTab === 'active' ? 'No active contracts.' : 'No past contracts.'}</p>
                            ) : (
                                (queueTab === 'active' ? activeContracts : historyContracts).map((c) => (
                                    <ContractRow key={c.id} contract={c} meId={meId} onClick={() => setSelectedContractId(c.id)} />
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
            </div>

            {showCreate && (
                <CreateListingModal
                    categories={categories}
                    onClose={() => setShowCreate(false)}
                    onCreate={async (input) => { const ok = await runAction('marketplace:create_listing', input, 'Listing posted'); if (ok) setShowCreate(false); }}
                />
            )}
            {selectedListing && (
                <ListingDetailModal
                    listing={selectedListing} meId={meId} canContract={canContract}
                    onClose={() => setSelectedListingId(null)}
                    onPropose={async (payload) => { const ok = await runAction('marketplace:propose', payload, 'Contract proposed'); if (ok) setSelectedListingId(null); }}
                    onDelete={async () => { const ok = await runAction('marketplace:delete_listing', { id: selectedListing.id }, 'Listing removed'); if (ok) setSelectedListingId(null); }}
                    onReport={async (payload) => { await runAction('marketplace:report', { listingId: selectedListing.id, ...payload }, 'Report submitted'); }}
                />
            )}
            {selectedContract && (
                <ContractDetailModal
                    contract={selectedContract} meId={meId} rpcAction={rpcAction}
                    onClose={() => setSelectedContractId(null)}
                    onAction={runAction}
                />
            )}
        </div>
    );
};

export default MarketplaceView;
