import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowFrame from '../../layout/WindowFrame';
import { useData } from '../../../contexts/DataContext';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import type { QmInventoryItem, QmUserRef, User } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';

type MemberLike = Pick<User, 'id' | 'name' | 'avatarUrl'> & { rsiHandle?: string | null };

interface Props {
    members: User[];
    /** If provided, kit starts with this item pre-added. */
    seedItem?: QmInventoryItem;
    /** If provided, kit starts targeted at this member. */
    seedMember?: QmUserRef;
    /** If true, member can't be changed (used when opened from a member's Q-Record). */
    lockMember?: boolean;
    onClose: () => void;
    onSubmitted: () => void;
}

interface Line {
    inventoryId: number;
    quantity: string;
}

export default function IssueKitModal({
    members, seedItem, seedMember, lockMember, onClose, onSubmitted,
}: Props) {
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const [member, setMember] = useState<MemberLike | null>(seedMember ?? null);
    const [memberSearch, setMemberSearch] = useState('');
    const [lines, setLines] = useState<Line[]>(
        seedItem ? [{ inventoryId: seedItem.id, quantity: '1' }] : [],
    );
    const [pickerSearch, setPickerSearch] = useState('');
    const [pickerOpen, setPickerOpen] = useState(!seedItem);
    const [dueBackAt, setDueBackAt] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const debouncedPickerSearch = useDebouncedValue(pickerSearch.trim(), 250);

    // Cache of inventory item details we've seen (seed + picker selections + search results).
    // Used so kit lines can render name/category/quantity without holding the
    // entire org inventory array.
    const [knownInventory, setKnownInventory] = useState<Map<number, QmInventoryItem>>(() => {
        const m = new Map<number, QmInventoryItem>();
        if (seedItem) m.set(seedItem.id, seedItem);
        return m;
    });

    const rememberInventory = useCallback((items: QmInventoryItem[]) => {
        if (!items.length) return;
        setKnownInventory((prev) => {
            const next = new Map(prev);
            for (const it of items) next.set(it.id, it);
            return next;
        });
    }, []);

    const inventoryById = knownInventory;

    // Server-side picker search — fetches inventory matching the query, capped
    // at 40 rows. Avoids holding the entire org inventory in memory.
    const [pickerResults, setPickerResults] = useState<QmInventoryItem[]>([]);
    // Loading starts true exactly when the picker starts open (no seedItem), so
    // the very first fetch's loading state needs no synchronous effect-set.
    const [pickerLoading, setPickerLoading] = useState(() => !seedItem);
    const pickerSeqRef = useRef(0);

    // Begin the loading state for a new picker fetch during render, on the same
    // key that drives the fetch effect below (picker open + debounced query).
    // Keeping it out of the effect avoids a synchronous set-state-in-effect; the
    // effect still owns the async RPC and resolves loading to false. The mount
    // case is covered by the lazy initial value above (so this tracker is inited
    // to the current key and does not double-fire on first render).
    const pickerFetchKey = pickerOpen ? debouncedPickerSearch : null;
    const [prevPickerFetchKey, setPrevPickerFetchKey] = useState<string | null>(pickerFetchKey);
    if (pickerFetchKey !== prevPickerFetchKey) {
        setPrevPickerFetchKey(pickerFetchKey);
        if (pickerOpen) setPickerLoading(true);
    }

    useEffect(() => {
        if (!pickerOpen) return;
        const seq = ++pickerSeqRef.current;
        rpcAction('qm:list_inventory', {
            search: debouncedPickerSearch || undefined,
            includeArchived: false,
            limit: 40,
        })
            .then((rows: QmInventoryItem[] | undefined) => {
                if (seq !== pickerSeqRef.current) return;
                const list = Array.isArray(rows) ? rows : [];
                setPickerResults(list);
                rememberInventory(list);
            })
            .catch(() => {
                if (seq !== pickerSeqRef.current) return;
                setPickerResults([]);
            })
            .finally(() => {
                if (seq === pickerSeqRef.current) setPickerLoading(false);
            });
    }, [pickerOpen, debouncedPickerSearch, rpcAction, rememberInventory]);

    const availableForPicker = useMemo(() => {
        const existingIds = new Set(lines.map(l => l.inventoryId));
        return pickerResults.filter(it => !it.isArchived && it.quantityOnHand > 0 && !existingIds.has(it.id));
    }, [pickerResults, lines]);

    const filteredMembers = useMemo(() => {
        const q = memberSearch.trim().toLowerCase();
        const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
        if (!q) return sorted.slice(0, 40);
        return sorted.filter(u =>
            u.name.toLowerCase().includes(q) || (u.rsiHandle || '').toLowerCase().includes(q),
        ).slice(0, 40);
    }, [members, memberSearch]);

    const addLine = (item: QmInventoryItem) => {
        setLines(prev => [...prev, { inventoryId: item.id, quantity: '1' }]);
        setPickerSearch('');
        setPickerOpen(false);
    };

    const updateQty = (idx: number, qty: string) => {
        setLines(prev => prev.map((l, i) => i === idx ? { ...l, quantity: qty } : l));
    };

    const removeLine = (idx: number) => {
        setLines(prev => prev.filter((_, i) => i !== idx));
    };

    const linesValid = lines.length > 0 && lines.every(l => {
        const qty = Math.trunc(Number(l.quantity));
        const inv = inventoryById.get(l.inventoryId);
        return Number.isFinite(qty) && qty > 0 && !!inv && qty <= inv.quantityOnHand;
    });
    const valid = member !== null && linesValid;
    const totalItems = lines.reduce((sum, l) => sum + (Math.trunc(Number(l.quantity)) || 0), 0);

    const submit = async () => {
        if (!valid || submitting || !member) return;
        setSubmitting(true);

        const dueBackIso = dueBackAt ? new Date(dueBackAt).toISOString() : undefined;
        const notesClean = notes.trim() || undefined;
        const payload = lines.map(l => ({
            inventoryId: l.inventoryId,
            quantity: Math.trunc(Number(l.quantity)),
        }));

        try {
            const res = await rpcAction('qm:issue_bulk', {
                issuedToUserId: member.id,
                lines: payload,
                dueBackAt: dueBackIso,
                notes: notesClean,
            });
            const issued = Array.isArray(res?.issuanceIds) ? res.issuanceIds.length : payload.length;
            addToast(
                `Issued ${issued} ${issued === 1 ? 'item' : 'items'} to ${member.name}`,
                <i className="fa-solid fa-check" />,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
            );
            onSubmitted();
        } catch (err: any) {
            addToast(
                'Issue failed — kit not applied',
                <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'The whole kit was rolled back.' },
            );
            setSubmitting(false);
        }
    };

    const titleSubtitle =
        lines.length === 0 ? 'Build a kit' :
        lines.length === 1 ? `1 item · ${totalItems}× total` :
        `${lines.length} items · ${totalItems}× total`;

    return (
        <WindowFrame
            isOpen
            onClose={onClose}
            title={lockMember && member ? `Issue Kit · ${member.name}` : 'Issue Kit'}
            subtitle={titleSubtitle}
            icon="fa-solid fa-people-carry-box"
            color="amber"
            width="max-w-xl"
        >
            <div className="p-5 space-y-4">
                {member ? (
                    <div className="flex items-center gap-3 bg-slate-900/60 border border-white/10 rounded-lg p-3">
                        <img src={member.avatarUrl} alt="" className="w-10 h-10 rounded-full shrink-0 object-cover" />
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-bold text-white truncate">{member.name}</div>
                            {member.rsiHandle && <div className="text-[11px] font-mono text-slate-500 truncate">{member.rsiHandle}</div>}
                        </div>
                        {!lockMember && (
                            <button
                                onClick={() => { setMember(null); setMemberSearch(''); }}
                                className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
                            >
                                Change
                            </button>
                        )}
                    </div>
                ) : (
                    <div>
                        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Issue to</span>
                        <input
                            type="text"
                            value={memberSearch}
                            onChange={(e) => setMemberSearch(e.target.value)}
                            placeholder="Search members…"
                            className="mt-1 w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                            autoFocus
                        />
                        <div className="mt-1 max-h-44 overflow-y-auto space-y-1 border border-white/5 rounded-lg bg-slate-950/60 p-1">
                            {filteredMembers.length === 0 && <div className="text-xs text-slate-500 p-2">No matches.</div>}
                            {filteredMembers.map((u) => (
                                <button
                                    key={u.id}
                                    type="button"
                                    onClick={() => { setMember(u); setMemberSearch(''); }}
                                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left text-slate-300 hover:bg-slate-800/60 transition"
                                >
                                    <img src={u.avatarUrl} alt="" className="w-6 h-6 rounded-full shrink-0 object-cover" />
                                    <span className="truncate">{u.name}</span>
                                    {u.rsiHandle && <span className="text-[10px] text-slate-500 font-mono ml-auto">{u.rsiHandle}</span>}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div>
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Items in kit</span>
                        {lines.length > 0 && !pickerOpen && (
                            <button
                                onClick={() => setPickerOpen(true)}
                                className="text-[10px] font-bold uppercase tracking-widest text-orange-300 hover:text-orange-200"
                            >
                                <i className="fa-solid fa-plus mr-1" />Add item
                            </button>
                        )}
                    </div>
                    {lines.length > 0 && (
                        <div className="space-y-1.5 mb-2">
                            {lines.map((line, idx) => {
                                const inv = inventoryById.get(line.inventoryId);
                                const qty = Math.trunc(Number(line.quantity));
                                const overStock = !!inv && qty > inv.quantityOnHand;
                                const invalid = overStock || !Number.isFinite(qty) || qty < 1;
                                return (
                                    <div key={line.inventoryId} className={`flex items-center gap-2 bg-slate-900/60 border rounded-lg px-3 py-2 ${invalid ? 'border-rose-500/50' : 'border-white/10'}`}>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm text-white truncate font-bold">{inv?.catalog?.name || inv?.customName || `Item #${line.inventoryId}`}</div>
                                            <div className="text-[10px] text-slate-500 font-mono truncate">
                                                {inv?.catalog?.category || 'custom'}
                                                {inv && ` · ${inv.quantityOnHand} on hand`}
                                                {overStock && <span className="text-rose-400"> · exceeds stock</span>}
                                            </div>
                                        </div>
                                        <input
                                            type="number"
                                            inputMode="numeric"
                                            min={1}
                                            max={inv?.quantityOnHand || 1}
                                            value={line.quantity}
                                            onChange={(e) => updateQty(idx, e.target.value)}
                                            className={`w-16 bg-slate-950 border rounded-sm px-2 py-1 text-sm text-white font-mono text-right ${invalid ? 'border-rose-500/60 text-rose-200' : 'border-white/10'}`}
                                            aria-label="Quantity"
                                        />
                                        <button
                                            onClick={() => removeLine(idx)}
                                            className="text-slate-500 hover:text-rose-400 w-7 h-7 rounded-sm flex items-center justify-center transition"
                                            aria-label="Remove line"
                                        >
                                            <i className="fa-solid fa-xmark" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {pickerOpen && (
                        <div className="bg-slate-950/60 border border-white/5 rounded-lg p-2">
                            <input
                                type="text"
                                value={pickerSearch}
                                onChange={(e) => setPickerSearch(e.target.value)}
                                placeholder={lines.length === 0 ? 'Search items to add…' : 'Add another item…'}
                                className="w-full bg-slate-900 border border-white/10 rounded-sm px-3 py-1.5 text-sm text-white mb-1"
                            />
                            <div className="max-h-44 overflow-y-auto space-y-1">
                                {pickerLoading && availableForPicker.length === 0 && (
                                    <div className="text-xs text-slate-500 p-2"><i className="fa-solid fa-spinner animate-spin mr-2" />Searching…</div>
                                )}
                                {!pickerLoading && availableForPicker.length === 0 && (
                                    <div className="text-xs text-slate-500 p-2">
                                        {pickerSearch
                                            ? 'No matches.'
                                            : lines.length > 0
                                                ? 'No more items available.'
                                                : 'No inventory matches. Type to search.'}
                                    </div>
                                )}
                                {availableForPicker.map((it) => (
                                    <button
                                        key={it.id}
                                        type="button"
                                        onClick={() => addLine(it)}
                                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left text-slate-300 hover:bg-slate-800/60 transition"
                                    >
                                        <span className="truncate flex-1">{it.catalog?.name || it.customName}</span>
                                        {it.catalog?.category && <span className="text-[9px] font-mono text-slate-500 uppercase">{it.catalog.category}</span>}
                                        <span className="text-[10px] font-mono text-slate-500">{it.quantityOnHand} left</span>
                                    </button>
                                ))}
                            </div>
                            {lines.length > 0 && (
                                <button
                                    onClick={() => { setPickerOpen(false); setPickerSearch(''); }}
                                    className="mt-1 w-full text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 py-1"
                                >
                                    Close picker
                                </button>
                            )}
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Due back (optional)</span>
                        <input
                            type="datetime-local"
                            value={dueBackAt}
                            onChange={(e) => setDueBackAt(e.target.value)}
                            className="mt-1 w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                        />
                        <span className="text-[10px] text-slate-600 mt-1 block">Applies to every line</span>
                    </label>
                    <label className="block">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Notes (optional)</span>
                        <input
                            type="text"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            maxLength={400}
                            className="mt-1 w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                            placeholder="e.g. Op Nightstorm"
                        />
                    </label>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2">
                    <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                        {lines.length > 0 && `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · ${totalItems}× total`}
                    </div>
                    <div className="flex gap-2">
                        <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white">
                            Cancel
                        </button>
                        <button
                            onClick={submit}
                            disabled={!valid || submitting}
                            className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {submitting
                                ? 'Issuing…'
                                : lines.length > 1 ? `Issue ${lines.length} items` : 'Issue'}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
}
