// ContractDetailModal — the contract lifecycle: status timeline, role-gated
// action buttons, service milestones, and post-completion ratings. All actions
// route through onAction → rpcAction (server enforces party membership).
import React, { useCallback, useEffect, useState } from 'react';
import type { MarketplaceContract, MarketplaceMilestone, MarketplaceRating } from '../../../types';
import { Stars } from './marketplaceUi';
import { CONTRACT_STATUS_META, fmtUec } from './marketplaceMeta';
import WindowFrame from '../../layout/WindowFrame';
import { ReportModal } from './MarketplaceModals';

const STEPS: { key: string; label: string }[] = [
    { key: 'proposed', label: 'Proposed' },
    { key: 'accepted', label: 'Accepted' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'completed', label: 'Completed' },
];
const STEP_INDEX: Record<string, number> = { proposed: 0, accepted: 1, in_progress: 1, delivered: 2, completed: 3 };

const ContractDetailModal: React.FC<{
    contract: MarketplaceContract;
    meId: number;
    rpcAction: (action: string, payload: any) => Promise<any>;
    onClose: () => void;
    onAction: (action: string, payload: Record<string, unknown>, okMsg: string) => Promise<boolean>;
}> = ({ contract, meId, rpcAction, onClose, onAction }) => {
    const amSeller = contract.sellerId === meId;
    const amBuyer = contract.buyerId === meId;
    const amProposer = contract.proposedById === meId;
    const meta = CONTRACT_STATUS_META[contract.status];

    const [milestones, setMilestones] = useState<MarketplaceMilestone[]>([]);
    const [ratings, setRatings] = useState<MarketplaceRating[]>([]);
    const [stars, setStars] = useState(5);
    const [feedback, setFeedback] = useState('');
    const [busy, setBusy] = useState(false);
    const [showReport, setShowReport] = useState(false);

    const loadExtras = useCallback(async () => {
        try { setMilestones(await rpcAction('marketplace:get_milestones', { id: contract.id }) || []); } catch { /* none */ }
        if (contract.status === 'completed') {
            try { setRatings(await rpcAction('marketplace:get_contract_ratings', { id: contract.id }) || []); } catch { /* none */ }
        }
    }, [rpcAction, contract.id, contract.status]);

    // Load milestones/ratings on mount and when the contract id/status changes.
    // loadExtras setStates only after its awaited fetches, so awaiting it from an
    // async IIFE keeps every update on the post-await path (no synchronous
    // set-in-effect) — identical timing to a bare loadExtras() call.
    useEffect(() => { void (async () => { await loadExtras(); })(); }, [loadExtras]);

    const act = async (action: string, payload: Record<string, unknown>, okMsg: string) => {
        setBusy(true);
        const ok = await onAction(action, payload, okMsg);
        setBusy(false);
        if (ok) onClose();
    };

    const toggleMilestone = async (m: MarketplaceMilestone) => {
        await onAction('marketplace:toggle_milestone', { milestoneId: m.id }, 'Milestone updated');
        await loadExtras();
    };

    const iRated = ratings.some((r) => r.raterId === meId);
    const stepIdx = STEP_INDEX[contract.status] ?? 0;
    const isCancelled = contract.status === 'cancelled';

    return (
        <>
        <WindowFrame isOpen onClose={onClose} title={contract.title} subtitle="Marketplace" icon={`fa-solid ${meta.icon}`} color="indigo" width="max-w-2xl">
            <div className="p-5 space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${meta.cls}`}><i className={`fa-solid ${meta.icon} mr-1`} aria-hidden />{meta.label}</span>
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm border bg-slate-700/30 text-slate-300 border-slate-600/40">{amSeller ? 'You are the seller' : amBuyer ? 'You are the buyer' : 'Party'}</span>
                    <span className="ml-auto text-lg font-black text-lime-400 font-mono">{fmtUec(contract.agreedPriceUec)}</span>
                </div>

                {!isCancelled ? (
                    <div className="flex items-center">
                        {STEPS.map((s, i) => (
                            <React.Fragment key={s.key}>
                                <div className="flex flex-col items-center gap-1">
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] border ${i <= stepIdx ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' : 'bg-slate-800 text-slate-600 border-slate-700'}`}>
                                        {i < stepIdx ? <i className="fa-solid fa-check" aria-hidden /> : i + 1}
                                    </div>
                                    <span className={`text-[9px] uppercase font-bold ${i <= stepIdx ? 'text-indigo-300' : 'text-slate-600'}`}>{s.label}</span>
                                </div>
                                {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-1 ${i < stepIdx ? 'bg-indigo-500/40' : 'bg-slate-700'}`} />}
                            </React.Fragment>
                        ))}
                    </div>
                ) : (
                    <div className="text-center text-red-300 text-sm bg-red-500/5 border border-red-500/20 rounded-lg py-3">
                        <i className="fa-solid fa-ban mr-2" aria-hidden />Cancelled{contract.cancelReason ? ` — ${contract.cancelReason}` : ''}
                    </div>
                )}

                <div className="flex flex-wrap gap-4 text-xs text-slate-400">
                    {contract.kind === 'item' && contract.quantity != null && <span><i className="fa-solid fa-layer-group mr-1 text-slate-500" aria-hidden />Qty {contract.quantity}</span>}
                    <span><i className="fa-solid fa-user-tag mr-1 text-slate-500" aria-hidden />Seller: {contract.seller?.name || `#${contract.sellerId}`}</span>
                    <span><i className="fa-solid fa-user mr-1 text-slate-500" aria-hidden />Buyer: {contract.buyer?.name || `#${contract.buyerId}`}</span>
                    {contract.warehouseStockId && <span className="text-cyan-400"><i className="fa-solid fa-boxes-stacked mr-1" aria-hidden />Warehouse-linked</span>}
                </div>
                {contract.termsNote && <p className="text-sm text-slate-300 bg-slate-950/30 border border-slate-800/50 rounded-lg p-3">{contract.termsNote}</p>}

                {milestones.length > 0 && (
                    <div className="space-y-1.5">
                        <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-400">Milestones</h4>
                        {milestones.map((m) => (
                            <div key={m.id} className="flex items-center gap-2.5 p-2 rounded-md bg-slate-800/30 border border-slate-700/40">
                                <button disabled={!amSeller || isCancelled || contract.status === 'completed'} onClick={() => toggleMilestone(m)}
                                    className={`w-5 h-5 rounded shrink-0 border flex items-center justify-center text-[10px] ${m.completedAt ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-slate-800 border-slate-600 text-transparent'} ${amSeller && !isCancelled ? 'hover:border-indigo-500 cursor-pointer' : 'cursor-default'}`}>
                                    <i className="fa-solid fa-check" aria-hidden />
                                </button>
                                <span className={`text-sm ${m.completedAt ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{m.title}</span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="flex flex-wrap gap-2 border-t border-slate-700/50 pt-4">
                    {contract.status === 'proposed' && !amProposer && (
                        <button disabled={busy} onClick={() => act('marketplace:accept', { id: contract.id }, 'Contract accepted')} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase py-2.5 rounded-md disabled:opacity-50"><i className="fa-solid fa-check mr-2"></i>Accept</button>
                    )}
                    {(contract.status === 'accepted' || contract.status === 'in_progress') && amSeller && (
                        <button disabled={busy} onClick={() => act('marketplace:mark_delivered', { id: contract.id }, 'Marked delivered')} className="flex-1 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold uppercase py-2.5 rounded-md disabled:opacity-50"><i className="fa-solid fa-truck mr-2"></i>Mark Delivered</button>
                    )}
                    {contract.status === 'delivered' && amBuyer && (
                        <button disabled={busy} onClick={() => act('marketplace:confirm_received', { id: contract.id }, 'Receipt confirmed')} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase py-2.5 rounded-md disabled:opacity-50"><i className="fa-solid fa-circle-check mr-2"></i>Confirm Received</button>
                    )}
                    {!['completed', 'cancelled'].includes(contract.status) && (
                        <button disabled={busy} onClick={() => act('marketplace:cancel', { id: contract.id }, 'Contract cancelled')} className="px-4 bg-slate-700/60 hover:bg-red-600/80 text-slate-200 hover:text-white text-xs font-bold uppercase py-2.5 rounded-md disabled:opacity-50"><i className="fa-solid fa-ban mr-2"></i>{contract.status === 'proposed' && amProposer ? 'Withdraw' : 'Cancel'}</button>
                    )}
                </div>

                {contract.status === 'completed' && (
                    <div className="border-t border-slate-700/50 pt-4 space-y-3">
                        <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-400">Ratings</h4>
                        {ratings.map((r) => (
                            <div key={r.id} className="flex items-start gap-2 text-sm">
                                <Stars value={r.stars} />
                                <div className="min-w-0">
                                    <span className="text-slate-400 text-xs">{r.rater?.name || `#${r.raterId}`} ({r.raterRole})</span>
                                    {r.feedback && <p className="text-slate-300">{r.feedback}</p>}
                                </div>
                            </div>
                        ))}
                        {(amSeller || amBuyer) && !iRated && (
                            <div className="bg-slate-800/30 border border-slate-700/40 rounded-lg p-3 space-y-2">
                                <p className="text-xs text-slate-400">Rate your counterparty:</p>
                                <div className="flex gap-1 text-xl text-amber-400">
                                    {[1, 2, 3, 4, 5].map((i) => (
                                        <button key={i} onClick={() => setStars(i)}><i className={`fa-${i <= stars ? 'solid' : 'regular'} fa-star`} aria-hidden /></button>
                                    ))}
                                </div>
                                <input value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={1000} placeholder="Optional feedback" className="w-full bg-slate-800 border border-slate-600 rounded-md px-3 py-2 text-white text-sm outline-hidden focus:border-indigo-500" />
                                <button disabled={busy} onClick={() => act('marketplace:rate', { id: contract.id, stars, feedback: feedback.trim() || undefined }, 'Rating submitted')} className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold uppercase px-4 py-2 rounded-md disabled:opacity-50">Submit Rating</button>
                            </div>
                        )}
                        {iRated && <p className="text-[11px] text-emerald-400/80 italic">You've rated this contract.</p>}
                    </div>
                )}
                <div className="flex justify-end pt-1">
                    <button onClick={() => setShowReport(true)} className="text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-red-300 transition-colors">
                        <i className="fa-solid fa-flag mr-1.5"></i>Report
                    </button>
                </div>
            </div>
        </WindowFrame>
        {showReport && (
            <ReportModal targetLabel={contract.title} onClose={() => setShowReport(false)}
                onSubmit={async (reasonCategory, details) => { const ok = await onAction('marketplace:report', { contractId: contract.id, reasonCategory, details: details || undefined }, 'Report submitted'); if (ok) setShowReport(false); }} />
        )}
        </>
    );
};

export default ContractDetailModal;
