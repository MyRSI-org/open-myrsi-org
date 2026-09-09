import React from 'react';
import type { MarketplaceConsideration } from '../../../types';
import { fmtUec } from './marketplaceMeta';

/**
 * Compact "+N items" chip for card surfaces that only have room for the aUEC
 * headline. Renders nothing when there are no barter legs.
 */
export const ConsiderationBadge: React.FC<{ considerations?: MarketplaceConsideration[]; className?: string }> = ({ considerations, className }) => {
    const n = considerations?.length ?? 0;
    if (n === 0) return null;
    return (
        <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider border border-cyan-500/30 text-cyan-300 bg-cyan-500/10 ${className || ''}`}
            title={`${n} barter item${n === 1 ? '' : 's'} in this trade`}
        >
            <i className="fa-solid fa-boxes-stacked text-[9px]" aria-hidden />
            +{n} {n === 1 ? 'item' : 'items'}
        </span>
    );
};

/** Top-level, not nested in ConsiderationList: a component declared inside another
 *  is re-created on every parent render and remounts its subtree each time. */
const Leg: React.FC<{ leg: MarketplaceConsideration }> = ({ leg }) => (
    <div className="flex items-baseline gap-2 text-sm">
        <span className="font-mono font-bold text-cyan-300">{leg.quantity.toLocaleString()}×</span>
        <span className="text-white break-words min-w-0">{leg.label}</span>
        {leg.notes && <span className="text-[11px] text-slate-500 italic truncate">— {leg.notes}</span>}
    </div>
);

/**
 * The itemised terms for a detail view: the aUEC leg (when there is one) plus each
 * barter leg, split by side.
 *
 * `showDisclaimer` puts the honour-system note next to the terms on a CONTRACT,
 * which is where a party looks when a deal goes wrong — the builder says the same
 * thing at write time, and this is the read-time half.
 */
export const ConsiderationList: React.FC<{
    priceUec: number | null;
    considerations?: MarketplaceConsideration[];
    showDisclaimer?: boolean;
}> = ({ priceUec, considerations, showDisclaimer }) => {
    const legs = considerations || [];
    const hasCash = priceUec != null && priceUec > 0;
    if (!hasCash && legs.length === 0) {
        return <p className="text-lg font-bold text-amber-400 font-mono">{fmtUec(priceUec)}</p>;
    }
    const want = legs.filter((l) => l.componentType === 'want');
    const offer = legs.filter((l) => l.componentType === 'offer');

    return (
        <div className="space-y-1.5">
            {(hasCash || legs.length === 0) && (
                <p className="text-lg font-bold text-amber-400 font-mono leading-none">{fmtUec(priceUec)}</p>
            )}
            {want.length > 0 && (
                <div className="space-y-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Wanted</p>
                    {want.map((l) => <Leg key={l.id} leg={l} />)}
                </div>
            )}
            {offer.length > 0 && (
                <div className="space-y-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Offered</p>
                    {offer.map((l) => <Leg key={l.id} leg={l} />)}
                </div>
            )}
            {showDisclaimer && legs.length > 0 && (
                <p className="text-[11px] text-slate-500 italic pt-1">
                    Documented terms — these goods are handed over in-game, not moved through the warehouse.
                </p>
            )}
        </div>
    );
};
