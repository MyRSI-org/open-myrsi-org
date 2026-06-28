import React, { useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import WindowFrame from '../../../layout/WindowFrame';
import type { WarehouseStock, WarehouseReasonCategory } from '../../../../types';
import { useNotification } from '../../../../contexts/NotificationContext';

const REASONS: { key: WarehouseReasonCategory; label: string; description: string }[] = [
    { key: 'sale',      label: 'Sale',                description: 'Selling the stock for aUEC.' },
    { key: 'craft',     label: 'Crafting',            description: 'Material consumed in crafting / manufacturing.' },
    { key: 'transport', label: 'Transport',           description: 'Hauling between warehouses or to a partner.' },
    { key: 'other',     label: 'Other',               description: 'Anything else — explain in notes.' },
];

interface Props {
    isOpen: boolean;
    stock: WarehouseStock | null;
    onClose: () => void;
    onSubmitted: () => void;
}

export default function WhWithdrawalRequestDialog({ isOpen, stock, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const [quantity, setQuantity] = useState('');
    const [reason, setReason] = useState<WarehouseReasonCategory>('sale');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Reset the editable form fields when the dialog opens or the target stock
    // changes, mirroring the old [isOpen, stock?.id] effect. Done during render
    // via a previous-value tracker (React re-renders before paint, so this is
    // behavior-equivalent to the effect-reset): the reset fires on any change to
    // the (isOpen, stock?.id) tuple that lands with the dialog open.
    const openKey = `${isOpen ? 1 : 0}:${stock?.id ?? ''}`;
    const [prevOpenKey, setPrevOpenKey] = useState(openKey);
    if (openKey !== prevOpenKey) {
        setPrevOpenKey(openKey);
        if (isOpen) {
            setQuantity('');
            setReason('sale');
            setNotes('');
            setSubmitting(false);
        }
    }

    if (!isOpen || !stock) return null;

    const itemName = stock.catalog?.name || 'Commodity';
    const quality = stock.catalog?.qualityLabel ? ` · ${stock.catalog.qualityLabel}` : '';
    const unit = stock.catalog?.unit || 'units';
    const qtyNum = parseInt(quantity, 10);
    let validationError: string | null = null;
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) validationError = 'Quantity must be positive.';
    else if (qtyNum > stock.quantityOnHand) validationError = `Only ${stock.quantityOnHand} ${unit} on hand.`;
    else if (reason === 'other' && !notes.trim()) validationError = 'Notes are required when reason is "Other".';

    const handleSubmit = async () => {
        if (validationError) return;
        setSubmitting(true);
        try {
            await rpcAction('warehouse:request_withdrawal', {
                stockId: stock.id,
                requestedQuantity: qtyNum,
                reasonCategory: reason,
                reasonNotes: notes.trim() || undefined,
            });
            addToast('Request submitted',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
                { description: 'An officer will review and fulfil it.' });
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Request failed',
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
            subtitle={`Withdraw · ${stock.location?.name || '—'} · ${stock.quantityOnHand} ${unit}`}
            icon="fa-solid fa-paper-plane"
            color="sky"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Quantity</label>
                        <input type="number" min={1} max={stock.quantityOnHand} value={quantity} onChange={(e) => setQuantity(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-sky-500 outline-hidden" autoFocus />
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Reason</label>
                        <div className="space-y-1.5">
                            {REASONS.map((r) => (
                                <label key={r.key} className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                                    reason === r.key ? 'bg-sky-500/10 border-sky-500/40' : 'bg-slate-900/40 border-slate-700/40 hover:border-slate-600'
                                }`}>
                                    <input type="radio" name="wh-withdraw-reason" value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)} className="mt-0.5 accent-sky-500" />
                                    <div className="flex-1">
                                        <div className="text-xs font-bold text-white">{r.label}</div>
                                        <div className="text-[11px] text-slate-400">{r.description}</div>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">
                            Notes {reason === 'other' && <span className="text-red-400">*</span>}
                        </label>
                        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                            placeholder={reason === 'other' ? 'Required — describe the reason' : 'Optional context for the officer'}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:ring-2 focus:ring-sky-500 outline-hidden resize-none" />
                    </div>

                    {validationError && (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                            <i className="fa-solid fa-triangle-exclamation mr-2" />{validationError}
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={onClose} disabled={submitting}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors disabled:opacity-50">
                        Cancel
                    </button>
                    <button onClick={handleSubmit} disabled={submitting || !!validationError}
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50 disabled:cursor-not-allowed">
                        {submitting ? <><i className="fa-solid fa-spinner fa-spin" />Submitting…</> : <><i className="fa-solid fa-paper-plane" />Submit Request</>}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
}
