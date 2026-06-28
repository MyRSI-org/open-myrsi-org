import React, { useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import type { QmInventoryItem, QmMovementReason } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';

type AdjustReasonKey = 'restock' | 'adjust' | 'loss' | 'destruction';

interface ReasonOption {
    key: AdjustReasonKey;
    label: string;
    description: string;
    serverReason: Extract<QmMovementReason, 'adjust' | 'loss' | 'destruction'>;
    deltaSign: 'positive' | 'negative' | 'either';
    destructive: boolean;
    notesRequired: boolean;
}

const REASON_OPTIONS: ReasonOption[] = [
    {
        key: 'restock',
        label: 'Restock',
        description: 'New stock arrived. Adds to the on-hand total.',
        serverReason: 'adjust',
        deltaSign: 'positive',
        destructive: false,
        notesRequired: false,
    },
    {
        key: 'adjust',
        label: 'Adjust (correction)',
        description: 'Fix an inventory miscount. Can go up or down.',
        serverReason: 'adjust',
        deltaSign: 'either',
        destructive: false,
        notesRequired: false,
    },
    {
        key: 'loss',
        label: 'Loss / shrinkage',
        description: 'Stock has gone missing. Reduces the on-hand total.',
        serverReason: 'loss',
        deltaSign: 'negative',
        destructive: true,
        notesRequired: true,
    },
    {
        key: 'destruction',
        label: 'Destruction',
        description: 'Stock destroyed (combat, accident, expiry). Reduces the on-hand total.',
        serverReason: 'destruction',
        deltaSign: 'negative',
        destructive: true,
        notesRequired: true,
    },
];

interface Props {
    isOpen: boolean;
    inventory: QmInventoryItem | null;
    onClose: () => void;
    onSubmitted: () => void;
}

export default function AdjustStockDialog({ isOpen, inventory, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();

    const [mode, setMode] = useState<'delta' | 'set'>('delta');
    const [reasonKey, setReasonKey] = useState<AdjustReasonKey>('restock');
    const [deltaInput, setDeltaInput] = useState('');
    const [setTotalInput, setSetTotalInput] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const reason = useMemo(() => REASON_OPTIONS.find((r) => r.key === reasonKey)!, [reasonKey]);

    // Reset the editable form fields when the dialog opens or the target item
    // changes. We do this during render with a previous-key tracker (the
    // React-documented "adjust state during render" pattern) instead of an
    // effect: React re-renders before paint, so it is equivalent to the old
    // effect-reset but the rule does not fire. The seed reads
    // inventory?.quantityOnHand at the moment of open / id-change only — it is
    // intentionally NOT part of the key, so a later realtime quantity update on
    // the same item does NOT re-trigger the reset and clobber the user's typed
    // delta (this preserves the old exhaustive-deps exclusion). The null sentinel
    // makes the very first render seed the form when the dialog is mounted open.
    const resetKey = `${isOpen ? '1' : '0'}|${inventory?.id ?? ''}`;
    const [prevResetKey, setPrevResetKey] = useState<string | null>(null);
    if (resetKey !== prevResetKey) {
        setPrevResetKey(resetKey);
        if (isOpen) {
            setMode('delta');
            setReasonKey('restock');
            setDeltaInput('');
            setSetTotalInput(String(inventory?.quantityOnHand ?? 0));
            setNotes('');
            setSubmitting(false);
        }
    }

    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    if (!isOpen || !inventory) return null;

    const currentQty = inventory.quantityOnHand;
    const itemName = inventory.catalog?.name || inventory.customName || 'Item';
    const locationName = inventory.location?.name || '—';

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
    else if (reason.deltaSign === 'positive' && computedDelta < 0) validationError = 'Restock delta must be positive. Use "Adjust" or "Loss" to decrease.';
    else if (reason.deltaSign === 'negative' && computedDelta > 0) validationError = `${reason.label} delta must be negative.`;
    else if (projectedTotal != null && projectedTotal < 0) validationError = `Would take stock below zero (current ${currentQty}).`;
    else if (reason.notesRequired && !notes.trim()) validationError = `Notes are required for ${reason.label.toLowerCase()}.`;

    const handleSubmit = async () => {
        if (validationError || computedDelta == null) return;

        if (reason.destructive) {
            const confirmed = await confirm({
                title: `Confirm ${reason.label}`,
                message: `Record ${Math.abs(computedDelta)} ${itemName} as ${reason.label.toLowerCase()}? This is logged to the movement ledger and cannot be reverted directly — you'd need an opposite restock.`,
                confirmText: reason.label,
                variant: 'danger',
            });
            if (!confirmed) return;
        }

        setSubmitting(true);
        try {
            await rpcAction('qm:adjust_inventory', {
                inventoryId: inventory.id,
                delta: computedDelta,
                reason: reason.serverReason,
                notes: notes.trim() || undefined,
            });
            addToast(
                'Stock adjusted',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
                { description: `${itemName}: ${currentQty} → ${projectedTotal}` }
            );
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast(
                'Adjustment failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not adjust stock.' }
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
            <div onClick={onClose} className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs" />
            <div className="relative w-full max-w-lg bg-slate-950/95 border border-white/10 rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                    <div className="min-w-0">
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.25em]">Adjust Stock</p>
                        <h2 className="text-base font-bold text-white truncate">{itemName}</h2>
                        <p className="text-[11px] text-slate-500 truncate">at {locationName}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-500 hover:text-white text-sm w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-800 transition-colors"
                        aria-label="Close"
                    >
                        <i className="fa-solid fa-xmark" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 custom-scrollbar">
                    <div className="flex items-center justify-between rounded-lg bg-slate-900/60 border border-white/5 px-4 py-3">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Current on hand</span>
                        <span className="text-2xl font-black font-mono text-white">{currentQty}</span>
                    </div>

                    <div className="flex items-center gap-1 bg-slate-900 rounded-lg border border-white/10 p-1">
                        <button
                            onClick={() => setMode('delta')}
                            className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest transition ${
                                mode === 'delta' ? 'bg-orange-500/20 text-orange-200' : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            Delta (+/-)
                        </button>
                        <button
                            onClick={() => setMode('set')}
                            className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest transition ${
                                mode === 'set' ? 'bg-orange-500/20 text-orange-200' : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            Set new total
                        </button>
                    </div>

                    {mode === 'delta' ? (
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">
                                Change by (use - to decrease)
                            </label>
                            <input
                                type="number"
                                value={deltaInput}
                                onChange={(e) => setDeltaInput(e.target.value)}
                                placeholder="e.g. 5 or -3"
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-orange-500 outline-hidden"
                                autoFocus
                            />
                        </div>
                    ) : (
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">
                                New total
                            </label>
                            <input
                                type="number"
                                min={0}
                                value={setTotalInput}
                                onChange={(e) => setSetTotalInput(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-orange-500 outline-hidden"
                                autoFocus
                            />
                        </div>
                    )}

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Reason</label>
                        <div className="space-y-1.5">
                            {REASON_OPTIONS.map((opt) => (
                                <label
                                    key={opt.key}
                                    className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                                        reasonKey === opt.key
                                            ? opt.destructive
                                                ? 'bg-red-500/10 border-red-500/40'
                                                : 'bg-orange-500/10 border-orange-500/40'
                                            : 'bg-slate-900/40 border-slate-700/40 hover:border-slate-600'
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="qm-adjust-reason"
                                        value={opt.key}
                                        checked={reasonKey === opt.key}
                                        onChange={() => setReasonKey(opt.key)}
                                        className={`mt-0.5 ${opt.destructive ? 'accent-red-500' : 'accent-orange-500'}`}
                                    />
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
                        <textarea
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder={reason.notesRequired ? 'Required — what happened?' : 'Optional context for the audit log'}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:ring-2 focus:ring-orange-500 outline-hidden resize-none"
                        />
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

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 bg-slate-900/40">
                    <button
                        onClick={onClose}
                        disabled={submitting}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !!validationError}
                        className={`px-4 py-2 text-xs font-bold uppercase tracking-widest rounded-lg text-white transition-colors disabled:opacity-50 ${
                            reason.destructive ? 'bg-red-600 hover:bg-red-500' : 'bg-orange-600 hover:bg-orange-500'
                        }`}
                    >
                        {submitting ? <><i className="fa-solid fa-spinner fa-spin mr-1.5" />Saving…</> : <><i className="fa-solid fa-check mr-1.5" />Apply</>}
                    </button>
                </div>
            </div>
        </div>
    );
}
