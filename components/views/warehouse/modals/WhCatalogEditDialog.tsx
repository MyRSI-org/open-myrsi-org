import React, { useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import { useWarehouse } from '../../../../contexts/WarehouseContext';
import WindowFrame from '../../../layout/WindowFrame';
import type { WarehouseCatalogItem, WarehouseCatalogCategory } from '../../../../types';
import { useNotification } from '../../../../contexts/NotificationContext';

const CATEGORIES: { key: WarehouseCatalogCategory; label: string }[] = [
    { key: 'ore',        label: 'Ore' },
    { key: 'refined',    label: 'Refined Material' },
    { key: 'fuel',       label: 'Fuel' },
    { key: 'rmc',        label: 'RMC' },
    { key: 'munition',   label: 'Munition' },
    { key: 'consumable', label: 'Consumable' },
    { key: 'misc',       label: 'Misc' },
];

interface Props {
    isOpen: boolean;
    target: WarehouseCatalogItem | 'new' | null;
    onClose: () => void;
    onSubmitted: () => void;
}

export default function WhCatalogEditDialog({ isOpen, target, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { warehouseCatalog } = useWarehouse();
    const { addToast, confirm } = useNotification();

    const [name, setName] = useState('');
    const [category, setCategory] = useState<WarehouseCatalogCategory>('ore');
    const [qualityLabel, setQualityLabel] = useState('');
    const [unit, setUnit] = useState('SCU');
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const isNew = target === 'new';
    const existing = !isNew && target ? target : null;

    // Seed the editable form fields when the dialog opens or the target item
    // changes. Adjusting state during render (React-documented pattern) is
    // equivalent to the old seed effect keyed on [isOpen, target] but runs
    // before paint without a synchronous effect setState. Keyed on the `target`
    // reference exactly like the original deps, so it does NOT re-fire (and
    // clobber in-progress edits) on unrelated catalog data updates.
    const [prevSeedKey, setPrevSeedKey] = useState<{ isOpen: boolean; target: typeof target }>({ isOpen, target });
    if (prevSeedKey.isOpen !== isOpen || prevSeedKey.target !== target) {
        setPrevSeedKey({ isOpen, target });
        if (isOpen) {
            if (existing) {
                setName(existing.name);
                setCategory(existing.category);
                setQualityLabel(existing.qualityLabel || '');
                setUnit(existing.unit);
                setDescription(existing.description || '');
            } else {
                setName('');
                setCategory('ore');
                setQualityLabel('');
                setUnit('SCU');
                setDescription('');
            }
            setSubmitting(false);
        }
    }

    if (!isOpen || !target) return null;

    const trimmedName = name.trim();
    const validationError = !trimmedName ? 'Name is required.' : null;

    const handleSubmit = async () => {
        if (validationError) return;
        setSubmitting(true);
        try {
            if (existing) {
                await rpcAction('warehouse:update_catalog_item', {
                    catalogId: existing.id, name: trimmedName, category,
                    qualityLabel: qualityLabel.trim() || null, unit: unit.trim() || 'units',
                    description: description.trim() || null,
                });
            } else {
                await rpcAction('warehouse:create_catalog_item', {
                    name: trimmedName, category,
                    qualityLabel: qualityLabel.trim() || null, unit: unit.trim() || 'units',
                    description: description.trim() || null,
                });
            }
            addToast(existing ? 'Commodity updated' : 'Commodity added',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Save failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        } finally {
            setSubmitting(false);
        }
    };

    const handleArchive = async () => {
        if (!existing) return;
        const archived = !!existing.archivedAt;
        const confirmed = await confirm({
            title: archived ? 'Restore commodity?' : 'Archive commodity?',
            message: archived
                ? 'Restoring brings this commodity back to the active catalog.'
                : 'Archiving hides this commodity from the catalog and stock-creation pickers. Existing stock rows and movement history are preserved.',
            confirmText: archived ? 'Restore' : 'Archive',
            variant: archived ? 'info' : 'warning',
        });
        if (!confirmed) return;
        setSubmitting(true);
        try {
            await rpcAction('warehouse:archive_catalog_item', { catalogId: existing.id, archive: !archived });
            addToast(archived ? 'Commodity restored' : 'Commodity archived',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Archive failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async () => {
        if (!existing) return;
        const confirmed = await confirm({
            title: 'Delete commodity?',
            message: `Permanently delete "${existing.name}" from the catalog. All stock rows, movement history, and withdrawal requests for this commodity will also be deleted. This cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (!confirmed) return;
        setSubmitting(true);
        try {
            await rpcAction('warehouse:delete_catalog_item', { catalogId: existing.id });
            addToast('Commodity deleted',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Delete failed',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        } finally {
            setSubmitting(false);
        }
    };

    const qualitySuggestions = Array.from(new Set(
        warehouseCatalog
            .filter((c) => c.name === trimmedName && c.qualityLabel)
            .map((c) => c.qualityLabel as string)
    ));

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={existing ? existing.name : 'Add a commodity to the catalog'}
            subtitle={existing ? 'Edit Commodity' : 'New Commodity'}
            icon="fa-solid fa-boxes-stacked"
            color="sky"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Name</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Iron Ore"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden" />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Category</label>
                            <select value={category} onChange={(e) => setCategory(e.target.value as WarehouseCatalogCategory)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden">
                                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Unit</label>
                            <input type="text" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="SCU / L / rounds"
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden" />
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Quality label (optional)</label>
                        <input type="text" list="wh-quality-suggestions" value={qualityLabel} onChange={(e) => setQualityLabel(e.target.value)} placeholder="500-600"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden" />
                        {qualitySuggestions.length > 0 && (
                            <datalist id="wh-quality-suggestions">
                                {qualitySuggestions.map((q) => <option key={q} value={q} />)}
                            </datalist>
                        )}
                        <p className="text-[10px] text-slate-500 mt-1 font-mono uppercase tracking-widest">Free-text — pick a banding scheme that fits your org.</p>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Description (optional)</label>
                        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden resize-none" />
                    </div>

                    {validationError && (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                            <i className="fa-solid fa-triangle-exclamation mr-2" />{validationError}
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex items-center justify-between gap-3 rounded-b-xl">
                    {existing ? (
                        <div className="flex items-center gap-2">
                            <button onClick={handleArchive} disabled={submitting}
                                className={`px-3 py-2 text-[11px] font-bold uppercase tracking-widest rounded-lg transition-colors disabled:opacity-50 ${
                                    existing.archivedAt
                                        ? 'text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30'
                                        : 'text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30'
                                }`}>
                                <i className={`fa-solid ${existing.archivedAt ? 'fa-arrow-rotate-left' : 'fa-box-archive'} mr-1.5`} />
                                {existing.archivedAt ? 'Restore' : 'Archive'}
                            </button>
                            <button onClick={handleDelete} disabled={submitting}
                                title="Permanently delete this commodity along with all its stock rows and history."
                                className="px-3 py-2 text-[11px] font-bold uppercase tracking-widest rounded-lg transition-colors disabled:opacity-50 text-rose-300 hover:text-rose-200 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30">
                                <i className="fa-solid fa-trash mr-1.5" />
                                Delete
                            </button>
                        </div>
                    ) : <span />}

                    <div className="flex items-center gap-3">
                        <button onClick={onClose} disabled={submitting}
                            className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors disabled:opacity-50">
                            Cancel
                        </button>
                        <button onClick={handleSubmit} disabled={submitting || !!validationError}
                            className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50 disabled:cursor-not-allowed">
                            {submitting ? <><i className="fa-solid fa-spinner fa-spin" />Saving…</> : <><i className="fa-solid fa-check" />{existing ? 'Save' : 'Create'}</>}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
}
