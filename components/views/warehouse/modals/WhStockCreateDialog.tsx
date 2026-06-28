import React, { useEffect, useMemo, useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import { useWarehouse } from '../../../../contexts/WarehouseContext';
import WindowFrame from '../../../layout/WindowFrame';
import CatalogSearchCombobox, { ComboboxItem } from '../../../ui/CatalogSearchCombobox';
import { useNotification } from '../../../../contexts/NotificationContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSubmitted: () => void;
}

interface QmLocationOption {
    id: number;
    name: string;
}

export default function WhStockCreateDialog({ isOpen, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { warehouseCatalog } = useWarehouse();
    const { addToast } = useNotification();

    const [locations, setLocations] = useState<QmLocationOption[]>([]);
    const [locationsLoading, setLocationsLoading] = useState(false);

    const [selectedCommodity, setSelectedCommodity] = useState<ComboboxItem | null>(null);

    // Surface the org's existing custom catalog as defaults so admins don't
    // have to type to discover what's already there. Archived rows are
    // excluded — they shouldn't seed new stock placements.
    const customCatalogDefaults = useMemo<ComboboxItem[]>(() => (
        (warehouseCatalog || [])
            .filter((c) => !c.archivedAt)
            .map((c) => ({
                id: c.id,
                name: c.qualityLabel ? `${c.name} · ${c.qualityLabel}` : c.name,
                source: 'custom',
                category: c.category,
            }))
    ), [warehouseCatalog]);
    const [locationId, setLocationId] = useState<number | ''>('');
    const [initialQty, setInitialQty] = useState('');
    const [notes, setNotes] = useState('');
    const [qualityLabel, setQualityLabel] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Lock the quality field when an existing custom commodity is picked —
    // its quality is a property of the catalog row itself and changing it
    // requires the dedicated Edit Commodity flow (warehouse:admin).
    const lockedCustom = selectedCommodity?.source === 'custom'
        ? (warehouseCatalog || []).find((c) => c.id === selectedCommodity.id) ?? null
        : null;
    const qualityLocked = !!lockedCustom;

    // When a custom commodity is picked the quality is owned by its catalog row,
    // so show that value (read-only) instead of the user-typed state. Derived
    // during render — the field is disabled while locked and `qualityLabel` is
    // not sent for custom rows (see handleSubmit), so this preserves behavior.
    const displayedQuality = lockedCustom ? (lockedCustom.qualityLabel || '') : qualityLabel;

    const qualitySuggestions = useMemo(() => {
        const name = selectedCommodity?.name?.split(' · ')[0]?.trim();
        if (!name) return [] as string[];
        return Array.from(new Set(
            (warehouseCatalog || [])
                .filter((c) => c.name === name && c.qualityLabel)
                .map((c) => c.qualityLabel as string)
        ));
    }, [warehouseCatalog, selectedCommodity]);

    // Reset all user-editable form fields on the dialog's closed→open transition.
    // Done during render via a prevIsOpen tracker (React re-renders before paint,
    // so it is behavior-equivalent to the old open-reset effect) instead of a
    // synchronous setState inside the effect. The async locations fetch (which
    // owns locationsLoading on its async path) stays in the effect below; the
    // synchronous setLocationsLoading(true) moves here so the effect carries no
    // synchronous set.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    if (isOpen && !prevIsOpen) {
        setPrevIsOpen(true);
        setSelectedCommodity(null);
        setLocationId('');
        setInitialQty('');
        setNotes('');
        setQualityLabel('');
        setSubmitting(false);
        setLocationsLoading(true);
    } else if (!isOpen && prevIsOpen) {
        setPrevIsOpen(false);
    }

    useEffect(() => {
        if (isOpen) {
            // Kick off the locations fetch on open. The loading flag was already
            // flipped true in the render-time open-reset above; only the async
            // result handlers (not flagged) set state here.
            rpcAction('warehouse:list_locations', {})
                .then((rows: any[]) => setLocations(Array.isArray(rows) ? rows : []))
                .catch((err: any) => {
                    addToast('Could not load locations',
                        <i className="fa-solid fa-xmark" />,
                        'bg-red-500/10 text-red-400 border-red-500/50',
                        { description: err?.message });
                    setLocations([]);
                })
                .finally(() => setLocationsLoading(false));
        }
    }, [isOpen, rpcAction, addToast]);

    if (!isOpen) return null;

    const qtyNum = initialQty.trim() ? parseInt(initialQty, 10) : 0;
    let validationError: string | null = null;
    if (!selectedCommodity) validationError = 'Pick a commodity.';
    else if (!locationId) validationError = 'Pick a location.';
    else if (initialQty.trim() && (!Number.isFinite(qtyNum) || qtyNum < 0)) validationError = 'Initial quantity must be zero or positive.';

    const handleSubmit = async () => {
        if (validationError || !selectedCommodity) return;
        setSubmitting(true);
        try {
            const stock = await rpcAction('warehouse:create_stock', {
                catalogId: selectedCommodity.id,
                source: selectedCommodity.source === 'platform' ? 'platform' : 'custom',
                locationId,
                notes: notes.trim() || undefined,
                // Only meaningful when source='platform' — server ignores it otherwise.
                qualityLabel: selectedCommodity.source === 'platform' ? (qualityLabel.trim() || null) : null,
            });
            if (qtyNum > 0 && stock?.id) {
                await rpcAction('warehouse:adjust_stock', {
                    stockId: stock.id, delta: qtyNum, reason: 'initial',
                    notes: 'Initial stock seed',
                });
            }
            addToast('Stock created',
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Could not create stock',
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
            title="Place a commodity at a location"
            subtitle="New Stock Row"
            icon="fa-solid fa-warehouse"
            color="sky"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Commodity</label>
                        <CatalogSearchCombobox
                            rpcName="warehouse:search_catalog"
                            value={selectedCommodity}
                            onChange={setSelectedCommodity}
                            initialScope="both"
                            showScopeToggle
                            placeholder="Search org and platform commodities…"
                            helpText="Your org's commodities appear by default; type to also search the platform catalog. Picking a platform commodity adds it to your catalog automatically."
                            defaultItems={customCatalogDefaults}
                            defaultItemsLabel="Your org commodities"
                        />
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">
                            Quality label {qualityLocked ? '' : '(optional)'}
                        </label>
                        <input
                            type="text"
                            list="wh-stock-quality-suggestions"
                            value={displayedQuality}
                            onChange={(e) => setQualityLabel(e.target.value)}
                            disabled={qualityLocked || !selectedCommodity}
                            placeholder="500-600"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden disabled:opacity-50"
                        />
                        {qualitySuggestions.length > 0 && (
                            <datalist id="wh-stock-quality-suggestions">
                                {qualitySuggestions.map((q) => <option key={q} value={q} />)}
                            </datalist>
                        )}
                        <p className="text-[10px] text-slate-500 mt-1 font-mono uppercase tracking-widest">
                            {qualityLocked
                                ? 'Locked to this commodity’s catalog row — use Edit Commodity on the stock card to change it.'
                                : selectedCommodity
                                    ? 'Free-text — pick a banding scheme that fits your org.'
                                    : 'Pick a commodity first to set its quality.'}
                        </p>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Location</label>
                        <select value={locationId} onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : '')}
                            disabled={locationsLoading}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden disabled:opacity-50">
                            <option value="">{locationsLoading ? 'Loading…' : 'Select…'}</option>
                            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                        {!locationsLoading && locations.length === 0 && (
                            <p className="text-[11px] text-amber-300 mt-1">No locations exist yet — open the Locations tab to add one.</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Initial quantity (optional)</label>
                        <input type="number" min={0} value={initialQty} onChange={(e) => setInitialQty(e.target.value)} placeholder="0"
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base font-mono text-white focus:ring-2 focus:ring-sky-500 outline-hidden" />
                        <p className="text-[10px] text-slate-500 mt-1 font-mono uppercase tracking-widest">Records as an "initial" movement.</p>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Notes (optional)</label>
                        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
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
                        {submitting ? <><i className="fa-solid fa-spinner fa-spin" />Saving…</> : <><i className="fa-solid fa-plus" />Create</>}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
}
