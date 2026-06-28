import React, { useMemo, useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import WindowFrame from '../../../layout/WindowFrame';
import type { WarehouseStock, WarehouseMovementReason } from '../../../../types';
import { useNotification } from '../../../../contexts/NotificationContext';

type AdjustReasonKey = 'restock' | 'adjust' | 'loss' | 'destruction';

interface ReasonOption {
    key: AdjustReasonKey;
    label: string;
    description: string;
    serverReason: WarehouseMovementReason;
    deltaSign: 'positive' | 'negative' | 'either';
    destructive: boolean;
    notesRequired: boolean;
}

const REASON_OPTIONS: ReasonOption[] = [
    { key: 'restock',     label: 'Restock',           description: 'New stock arrived (mining haul, refinery output, purchase).', serverReason: 'restock',     deltaSign: 'positive', destructive: false, notesRequired: false },
    { key: 'adjust',      label: 'Adjust (correction)', description: 'Fix a count error. Can go up or down.',                       serverReason: 'adjust',      deltaSign: 'either',   destructive: false, notesRequired: false },
    { key: 'loss',        label: 'Loss / shrinkage',  description: 'Stock missing without explanation.',                          serverReason: 'loss',        deltaSign: 'negative', destructive: true,  notesRequired: true  },
    { key: 'destruction', label: 'Destruction',       description: 'Stock destroyed (combat, accident, expiry).',                 serverReason: 'destruction', deltaSign: 'negative', destructive: true,  notesRequired: true  },
];

interface Props {
    isOpen: boolean;
    stock: WarehouseStock | null;
    onClose: () => void;
    onSubmitted: () => void;
}

export default function WhAdjustStockDialog({ isOpen, stock, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();

    const [mode, setMode] = useState<'delta' | 'set'>('delta');
    const [reasonKey, setReasonKey] = useState<AdjustReasonKey>('restock');
    const [deltaInput, setDeltaInput] = useState('');
    const [setTotalInput, setSetTotalInput] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const reason = useMemo(() => REASON_OPTIONS.find((r) => r.key === reasonKey)!, [reasonKey]);

    // Reset the editable form fields when the dialog opens or the target stock
    // row changes. Adjusting state during render (React-documented pattern) is
    // equivalent to the old reset effect keyed on [isOpen, stock?.id] but runs
    // before paint without a synchronous effect setState. The reset only fires
    // while open, matching the original effect's `if (isOpen)` guard.
    const resetKey = `${isOpen}:${stock?.id ?? ''}`;
    const [prevResetKey, setPrevResetKey] = useState(resetKey);
    if (resetKey !== prevResetKey) {
        setPrevResetKey(resetKey);
        if (isOpen) {
            setMode('delta');
            setReasonKey('restock');
            setDeltaInput('');
            setSetTotalInput(String(stock?.quantityOnHand ?? 0));
            setNotes('');
            setSubmitting(false);
        }
    }

    if (!isOpen || !stock) return null;

    const currentQty = stock.quantityOnHand;
    const itemName = stock.catalog?.name || 'Commodity';
    const quality = stock.catalog?.qualityLabel ? ` · ${stock.catalog.qualityLabel}` : '';
    const unit = stock.catalog?.unit || 'units';
    const locationName = stock.location?.name || '—';

    const computedDelta: number | null = (() => {
        if (mode === 'delta') {
            const n = parseInt(deltaInput, 10);
            return Number.isFinite(n) ? n : null;
        }
        const n = parseInt(setTotalInput, 10);
        if (!Number.isFinite(n)) return null;
        return n - currentQty;
    })();

    const projectedTotal = computedDelta == null ? null : currentQty + computedDelta;

    let validationError: string | null = null;
    if (computedDelta == null) validationError = 'Enter a number.';
    else if (computedDelta === 0) validationError = 'Delta must be non-zero.';
    else if (reason.deltaSign === 'positive' && computedDelta < 0) validationError = 'Restock delta must be positive.';
    else if (reason.deltaSign === 'negative' && computedDelta > 0) validationError = `${reason.label} delta must be negative.`;
    else if (projectedTotal != null && projectedTotal < 0) validationError = `Would take stock below zero (current ${currentQty}).`;
    else if (reason.notesRequired && !notes.trim()) validationError = `Notes are required for ${reason.label.toLowerCase()}.`;

    const handleSubmit = async () => {
        if (validationError || computedDelta == null) return;
        if (reason.destructive) {
            const confirmed = await confirm({
                title: `Confirm ${reason.label}`,
                message: `Record ${Math.abs(computedDelta)} ${unit} of ${itemName}${quality} as ${reason.label.toLowerCase()}? This is logged to the movement ledger.`,
                confirmText: reason.label,
                variant: 'danger',
            });
            if (!confirmed) return;
        }
        setSubmitting(true);
        try {
            await rpcAction('warehouse:adjust_stock', {
                stockId: stock.id,
                delta: computedDelta,
                reason: reason.serverReason,
                notes: notes.trim() || undefined,
            });
            addToast('Stock adjusted',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
                { description: `${itemName}${quality}: ${currentQty} → ${projectedTotal}` });
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Adjustment failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not adjust stock.' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={`${itemName}${quality}`}
            subtitle={`Adjust Stock · ${locationName}`}
            icon="fa-solid fa-scale-balanced"
            color={reason.destructive ? 'red' : 'sky'}
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div className="flex items-center justify-between rounded-lg bg-slate-900/60 border border-white/5 px-4 py-3">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Current on hand</span>
                        <span className="text-2xl font-black font-mono text-white">{currentQty} <span className="text-xs text-slate-500 font-normal">{unit}</span></span>
                    </div>

                    <div className="flex items-center gap-1 bg-slate-900 rounded-lg border border-white/10 p-1">
                        <button onClick={() => setMode('delta')}
                            className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest transition ${mode === 'delta' ? 'bg-sky-500/20 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}>
                            Delta (+/-)
                        </button>
                        <button onClick={() => setMode('set')}
                            className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest transition ${mode === 'set' ? 'bg-sky-500/20 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}>
                            Set new total
                        </button>
                    </div>

                    {mode === 'delta' ? (
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Change by (use - to decrease)</label>
                            <input type="number" value={deltaInput} onChange={(e) => setDeltaInput(e.target.value)} placeholder="e.g. 1000 or -200"
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-sky-500 outline-hidden" autoFocus />
                        </div>
                    ) : (
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">New total</label>
                            <input type="number" min={0} value={setTotalInput} onChange={(e) => setSetTotalInput(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-sky-500 outline-hidden" autoFocus />
                        </div>
                    )}

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Reason</label>
                        <div className="space-y-1.5">
                            {REASON_OPTIONS.map((opt) => (
                                <label key={opt.key} className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                                    reasonKey === opt.key
                                        ? opt.destructive ? 'bg-red-500/10 border-red-500/40' : 'bg-sky-500/10 border-sky-500/40'
                                        : 'bg-slate-900/40 border-slate-700/40 hover:border-slate-600'
                                }`}>
                                    <input type="radio" name="wh-adjust-reason" value={opt.key} checked={reasonKey === opt.key} onChange={() => setReasonKey(opt.key)}
                                        className={`mt-0.5 ${opt.destructive ? 'accent-red-500' : 'accent-sky-500'}`} />
                                    <div className="flex-1">
                                        <div className={`text-xs font-bold ${opt.destructive ? 'text-red-200' : 'text-white'}`}>{opt.label}</div>
                                        <div className="text-[11px] text-slate-400">{opt.description}</div>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">
                            Notes {reason.notesRequired && <span className="text-red-400">*</span>}
                        </label>
                        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                            placeholder={reason.notesRequired ? 'Required — what happened?' : 'Optional context for the audit log'}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:ring-2 focus:ring-sky-500 outline-hidden resize-none" />
                    </div>

                    {projectedTotal != null && validationError == null && (
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
                            <i className="fa-solid fa-arrow-right-arrow-left mr-2" />
                            <strong>{currentQty}</strong> → <strong>{projectedTotal}</strong>
                            <span className="text-emerald-400/70 ml-2">({computedDelta != null && computedDelta > 0 ? `+${computedDelta}` : computedDelta})</span>
                        </div>
                    )}
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
                        className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white border rounded-lg shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed ${
                            reason.destructive
                                ? 'bg-red-600 hover:bg-red-500 border-red-500/40 shadow-red-900/30'
                                : 'bg-sky-600 hover:bg-sky-500 border-sky-500/40 shadow-sky-900/30'
                        }`}>
                        {submitting ? <><i className="fa-solid fa-spinner fa-spin" />Saving…</> : <><i className="fa-solid fa-check" />Apply</>}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
}
