// Shared marketplace UI primitives: status/type styling + small cards used by
// MarketplaceView and the detail modals.
import React from 'react';
import type { MarketplaceListing, MarketplaceContract } from '../../../types';
import { LISTING_TYPE_META, CONTRACT_STATUS_META, fmtUec } from './marketplaceMeta';
import { ConsiderationBadge } from './ConsiderationDisplay';

export const Stars: React.FC<{ value: number; size?: string }> = ({ value, size = 'text-xs' }) => (
    <span className={`${size} text-amber-400`} aria-label={`${value} stars`}>
        {[1, 2, 3, 4, 5].map((i) => (
            <i key={i} className={`fa-${i <= Math.round(value) ? 'solid' : 'regular'} fa-star`} aria-hidden />
        ))}
    </span>
);

export const ListingCard: React.FC<{ listing: MarketplaceListing; onClick: () => void }> = ({ listing, onClick }) => {
    const meta = LISTING_TYPE_META[listing.listingType];
    return (
        <button onClick={onClick} className="group w-full text-left flex items-stretch gap-0 rounded-lg border border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/60 hover:border-indigo-500/40 transition-colors overflow-hidden">
            <div className={`w-1 shrink-0 ${meta.stripe}`} />
            <div className="flex-1 min-w-0 p-3">
                <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-white truncate">{listing.title}</p>
                    <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${meta.chip}`}>
                        <i className={`fa-solid ${meta.icon} mr-1`} aria-hidden />{meta.label}
                    </span>
                </div>
                <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-400">
                    {listing.categoryName && <span><i className={`fa-solid ${listing.categoryIcon || 'fa-tag'} mr-1 text-slate-500`} aria-hidden />{listing.categoryName}</span>}
                    {listing.kind === 'item' && listing.quantity != null && (
                        <span><i className="fa-solid fa-layer-group mr-1 text-slate-500" aria-hidden />{Math.max(0, listing.quantity - listing.quantityClaimed)} left</span>
                    )}
                    {listing.location && <span className="truncate"><i className="fa-solid fa-location-dot mr-1 text-slate-500" aria-hidden />{listing.location}</span>}
                </div>
                <div className="flex items-center justify-between gap-2 mt-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-black text-lime-400 font-mono">{listing.priceUec != null ? fmtUec(listing.priceUec) : 'Negotiable'}{listing.priceType === 'per_unit' ? '/unit' : listing.priceType === 'hourly' ? '/hr' : ''}</span>
                        {/* The card has no room for the legs themselves; the chip says they
                            exist so a cash-only headline is not misread as the whole deal. */}
                        <ConsiderationBadge considerations={listing.considerations} />
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-slate-500 truncate">
                        {listing.seller?.avatarUrl && <img src={listing.seller.avatarUrl} alt="" className="w-4 h-4 rounded-full" />}
                        {listing.seller?.name || `User #${listing.sellerId}`}
                    </span>
                </div>
            </div>
        </button>
    );
};

export const ContractRow: React.FC<{ contract: MarketplaceContract; meId: number; onClick: () => void }> = ({ contract, meId, onClick }) => {
    const meta = CONTRACT_STATUS_META[contract.status];
    const role = contract.sellerId === meId ? 'Seller' : 'Buyer';
    return (
        <button onClick={onClick} className="w-full text-left p-3 rounded-lg border border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/60 hover:border-indigo-500/40 transition-colors">
            <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-white text-sm truncate">{contract.title}</p>
                <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${meta.cls}`}>
                    <i className={`fa-solid ${meta.icon} mr-1`} aria-hidden />{meta.label}
                </span>
            </div>
            <div className="flex items-center justify-between gap-2 mt-1.5 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded-sm border text-[9px] font-bold uppercase ${role === 'Seller' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' : 'bg-sky-500/10 text-sky-300 border-sky-500/20'}`}>{role}</span>
                    {contract.kind === 'item' && contract.quantity != null && <span>×{contract.quantity}</span>}
                </span>
                <span className="font-mono text-lime-400/80">{fmtUec(contract.agreedPriceUec)}</span>
            </div>
        </button>
    );
};
