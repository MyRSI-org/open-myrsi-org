import React from 'react';
import {
    type ConsiderationDraft, emptyConsideration,
    MAX_CONSIDERATIONS, MAX_LABEL_LEN, MAX_NOTES_LEN, MAX_LEG_QTY,
} from './considerationDrafts';

interface Props {
    drafts: ConsiderationDraft[];
    onChange: (next: ConsiderationDraft[]) => void;
    disabled?: boolean;
    /** Hide the want/offer toggle where only one side makes sense (a proposal). */
    sideLocked?: 'want' | 'offer';
}

const inputCls = 'bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-white outline-hidden focus:border-indigo-500/50 disabled:opacity-50';

/**
 * Free-text barter legs alongside (or instead of) an aUEC price.
 *
 * Deliberately free text and not a catalog picker. A pin would have to read the
 * quartermaster or commodity catalogue, both of which are gated on permissions the
 * marketplace audience does not hold — marketplace:view/list/contract are
 * CUSTOMER-GRANTABLE, so an external customer could reach this form while being
 * unable to search either catalogue.
 */
const ConsiderationBuilder: React.FC<Props> = ({ drafts, onChange, disabled, sideLocked }) => {
    const patch = (key: string, next: Partial<ConsiderationDraft>) =>
        onChange(drafts.map((d) => (d._key === key ? { ...d, ...next } : d)));
    const remove = (key: string) => onChange(drafts.filter((d) => d._key !== key));
    const add = () => onChange([...drafts, { ...emptyConsideration(), componentType: sideLocked ?? 'want' }]);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Barter items <span className="text-slate-600">(optional)</span></label>
                {drafts.length < MAX_CONSIDERATIONS && (
                    <button type="button" onClick={add} disabled={disabled} className="text-[11px] font-bold text-indigo-300 hover:text-indigo-200 disabled:opacity-40">
                        <i className="fa-solid fa-plus mr-1" aria-hidden />Add item
                    </button>
                )}
            </div>

            {/* The one sentence that prevents the most likely support ticket this
                feature generates. Repeated on the contract detail view, because that
                is where a party looks when a deal goes wrong. */}
            <p className="text-[11px] text-slate-500 leading-relaxed">
                These are <strong className="text-slate-400">documented terms</strong> — the goods are handed over
                in-game between you, not moved through the warehouse.
            </p>

            {drafts.length === 0 ? (
                <p className="text-[11px] text-slate-600 italic">Cash only. Add an item to trade goods as part of this deal.</p>
            ) : (
                <div className="space-y-2">
                    {drafts.map((d) => (
                        <div key={d._key} className="flex flex-wrap items-start gap-2 p-2 rounded-md border border-slate-700/50 bg-slate-800/30">
                            {!sideLocked && (
                                <select
                                    value={d.componentType}
                                    onChange={(e) => patch(d._key, { componentType: e.target.value as 'want' | 'offer' })}
                                    disabled={disabled}
                                    className={`${inputCls} w-24`}
                                    aria-label="Which side of the trade"
                                >
                                    <option value="want">Want</option>
                                    <option value="offer">Offer</option>
                                </select>
                            )}
                            <input
                                type="number"
                                min={1}
                                max={MAX_LEG_QTY}
                                value={d.quantity}
                                onChange={(e) => patch(d._key, { quantity: parseInt(e.target.value, 10) || 1 })}
                                disabled={disabled}
                                className={`${inputCls} w-24`}
                                aria-label="Quantity"
                            />
                            <input
                                type="text"
                                value={d.label}
                                maxLength={MAX_LABEL_LEN}
                                onChange={(e) => patch(d._key, { label: e.target.value })}
                                placeholder="Item or commodity (e.g. Titanium)"
                                disabled={disabled}
                                className={`${inputCls} flex-1 min-w-[10rem]`}
                                aria-label="Item name"
                            />
                            <input
                                type="text"
                                value={d.notes}
                                maxLength={MAX_NOTES_LEN}
                                onChange={(e) => patch(d._key, { notes: e.target.value })}
                                placeholder="Quality, condition… (optional)"
                                disabled={disabled}
                                className={`${inputCls} flex-1 min-w-[10rem]`}
                                aria-label="Notes"
                            />
                            <button
                                type="button"
                                onClick={() => remove(d._key)}
                                disabled={disabled}
                                className="px-2 py-1.5 text-slate-500 hover:text-red-400 disabled:opacity-40"
                                title="Remove this item"
                            >
                                <i className="fa-solid fa-xmark" aria-hidden />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default ConsiderationBuilder;
