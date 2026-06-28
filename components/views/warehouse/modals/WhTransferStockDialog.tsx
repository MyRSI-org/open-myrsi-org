import React, { useEffect, useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import WindowFrame from '../../../layout/WindowFrame';
import type { WarehouseStock } from '../../../../types';
import { useNotification } from '../../../../contexts/NotificationContext';

interface Props {
    isOpen: boolean;
    fromStock: WarehouseStock | null;
    onClose: () => void;
    onSubmitted: () => void;
}

export default function WhTransferStockDialog({ isOpen, fromStock, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const [toStockId, setToStockId] = useState<number | ''>('');
    const [quantity, setQuantity] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [candidates, setCandidates] = useState<WarehouseStock[]>([]);
    const [loadingCandidates, setLoadingCandidates] = useState(false);

    // Reset the user-editable form fields whenever the dialog opens or the
    // source stock changes, and flip the candidate-loading flag on at the same
    // moment the async fetch below is about to start. Done during render via the
    // React "adjust state during render" pattern (re-renders before paint), which
    // is behaviour-equivalent to the previous open/id-change reset effect and to
    // the synchronous setLoadingCandidates(true) at fetch start.
    const fromStockId = fromStock?.id;
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    const [prevFromStockId, setPrevFromStockId] = useState(fromStockId);
    if (isOpen !== prevIsOpen || fromStockId !== prevFromStockId) {
        setPrevIsOpen(isOpen);
        setPrevFromStockId(fromStockId);
        if (isOpen) {
            setToStockId('');
            setQuantity('');
            setNotes('');
            setSubmitting(false);
            // Enter the loading state synchronously when (re)opening with a
            // source stock — mirrors the old setLoadingCandidates(true) that ran
            // at fetch start, so there is no spinner flash regression.
            if (fromStock) setLoadingCandidates(true);
        }
    }

    // Load other stocks of the same commodity when the dialog opens. Avoids
    // having to keep the full warehouseStock array in DataContext just for
    // this dropdown — the catalog filter limits the read to a handful of rows.
    // The loading flag is flipped on above (render-time) so this effect only
    // performs the async fetch and its async result sets.
    useEffect(() => {
        if (!isOpen || !fromStock) return;
        let cancelled = false;
        rpcAction('warehouse:list_stock', { catalogId: fromStock.catalogId, limit: 200 })
            .then((rows: WarehouseStock[] | undefined) => {
                if (cancelled) return;
                setCandidates((rows || []).filter((s) => s.id !== fromStock.id));
            })
            .catch((err: any) => {
                if (cancelled) return;
                console.warn('[WhTransferStockDialog] Failed to load candidates:', err?.message);
                setCandidates([]);
            })
            .finally(() => {
                if (!cancelled) setLoadingCandidates(false);
            });
        return () => { cancelled = true; };
    }, [isOpen, fromStock, rpcAction]);

    if (!isOpen || !fromStock) return null;

    const itemName = fromStock.catalog?.name || 'Commodity';
    const quality = fromStock.catalog?.qualityLabel ? ` · ${fromStock.catalog.qualityLabel}` : '';
    const unit = fromStock.catalog?.unit || 'units';
    const qtyNum = parseInt(quantity, 10);
    const validQty = Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= fromStock.quantityOnHand;

    let validationError: string | null = null;
    if (!toStockId) validationError = 'Pick a destination location.';
    else if (!Number.isFinite(qtyNum) || qtyNum <= 0) validationError = 'Quantity must be a positive number.';
    else if (qtyNum > fromStock.quantityOnHand) validationError = `Cannot transfer more than ${fromStock.quantityOnHand} on hand.`;

    const handleSubmit = async () => {
        if (validationError || !validQty) return;
        setSubmitting(true);
        try {
            await rpcAction('warehouse:transfer_stock', {
                fromStockId: fromStock.id,
                toStockId,
                quantity: qtyNum,
                notes: notes.trim() || undefined,
            });
            addToast('Stock transferred',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
                { description: `Moved ${qtyNum} ${unit} of ${itemName}${quality}.` });
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Transfer failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={`${itemName}${quality}`}
            subtitle={`Transfer Stock · from ${fromStock.location?.name || '—'} · ${fromStock.quantityOnHand} ${unit}`}
            icon="fa-solid fa-arrow-right-arrow-left"
            color="sky"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    {loadingCandidates ? (
                        <div className="rounded-lg border border-white/5 bg-slate-900/30 px-3 py-3 text-xs text-slate-400">
                            <i className="fa-solid fa-spinner fa-spin mr-2" />
                            Loading destinations…
                        </div>
                    ) : candidates.length === 0 ? (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-amber-200">
                            <i className="fa-solid fa-triangle-exclamation mr-2" />
                            No other warehouses hold this commodity yet. Create a stock row at another location first.
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Destination</label>
                                <select value={toStockId} onChange={(e) => setToStockId(e.target.value ? Number(e.target.value) : '')}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden">
                                    <option value="">Select location…</option>
                                    {candidates.map((c) => (
                                        <option key={c.id} value={c.id}>{c.location?.name || `Stock #${c.id}`} (currently {c.quantityOnHand})</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Quantity</label>
                                <input type="number" min={1} max={fromStock.quantityOnHand} value={quantity} onChange={(e) => setQuantity(e.target.value)}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-sky-500 outline-hidden" autoFocus />
                                <p className="text-[10px] text-slate-500 mt-1 font-mono uppercase tracking-widest">Max {fromStock.quantityOnHand} {unit}</p>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Notes (optional)</label>
                                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                                    placeholder="Hauler, contract, freight reason…"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:ring-2 focus:ring-sky-500 outline-hidden resize-none" />
                            </div>
                            {validationError && (
                                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                                    <i className="fa-solid fa-triangle-exclamation mr-2" />{validationError}
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={onClose} disabled={submitting}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors disabled:opacity-50">
                        Cancel
                    </button>
                    <button onClick={handleSubmit} disabled={submitting || loadingCandidates || !!validationError || candidates.length === 0}
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50 disabled:cursor-not-allowed">
                        {submitting ? <><i className="fa-solid fa-spinner fa-spin" />Transferring…</> : <><i className="fa-solid fa-arrow-right-arrow-left" />Transfer</>}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
}
