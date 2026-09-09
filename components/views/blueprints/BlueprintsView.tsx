// Blueprint Manager — a member registry of what people can make, and a two-sided
// crafting-request board on top of it.
//
// Three tabs, each backed by its own permission-gated RPC read; nothing rides the
// boot payload or a realtime slice. Every mutation re-fetches the tab it touched,
// which is also why the db layer emits no broadcast: there would be no consumer.
//
// The permission gates below HIDE affordances; they are not the control. The
// server re-checks every one of them (api/services.ts fullPermissionMap plus the
// ownership guards in lib/db/blueprints.ts), so a hidden button is a courtesy and
// a removed one is not a boundary.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { HeroShell, HeroStat, HeroActionButton, EmptyState } from '../../shared/ui';
import WindowFrame from '../../layout/WindowFrame';
import type { Blueprint, CraftableItem, BlueprintRequest, BlueprintRequestStatus } from '../../../types';

const OK_TOAST = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50';
const ERR_TOAST = 'bg-red-500/10 text-red-400 border-red-500/50';
const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-purple-500 outline-hidden';
const BTN_PRIMARY = 'px-4 py-2 text-xs font-bold uppercase tracking-widest text-white rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:cursor-not-allowed transition-colors';
const BTN_GHOST = 'px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white disabled:opacity-40';
const CARD = 'bg-slate-800/40 border border-slate-700/60 rounded-xl';

const UNCATEGORISED = 'Uncategorised';

type Tab = 'craftable' | 'registry' | 'requests';

const STATUS_META: Record<BlueprintRequestStatus, { label: string; cls: string }> = {
    open: { label: 'Open', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
    claimed: { label: 'Claimed', cls: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
    ready: { label: 'Ready', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
    delivered: { label: 'Delivered', cls: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30' },
    completed: { label: 'Completed', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
    cancelled: { label: 'Cancelled', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/40' },
};

const errMsg = (err: unknown): string | undefined => (err instanceof Error ? err.message : undefined);

const Spinner: React.FC = () => (
    <div className="py-12 text-center text-slate-500"><i className="fa-solid fa-spinner animate-spin" aria-hidden /></div>
);

const TabButton: React.FC<{ id: Tab; active: Tab; label: string; icon: string; count?: number; onSelect: (id: Tab) => void }> =
    ({ id, active, label, icon, count, onSelect }) => (
        <button
            type="button"
            onClick={() => onSelect(id)}
            className={`px-3.5 py-2 text-[11px] font-bold uppercase tracking-widest rounded-lg border whitespace-nowrap transition-colors ${
                active === id ? 'bg-purple-500/10 text-purple-300 border-purple-500/40' : 'bg-slate-800/40 text-slate-400 border-slate-700 hover:text-white'
            }`}
        >
            <i className={`fa-solid ${icon} mr-2`} aria-hidden />{label}
            {count != null && count > 0 && <span className="ml-2 text-purple-300">{count}</span>}
        </button>
    );

// ════════════════════════════════════════════════════════════════════════════
// Register / edit a blueprint
// ════════════════════════════════════════════════════════════════════════════

const RegisterModal: React.FC<{
    existing: Blueprint | null;
    busy: boolean;
    onClose: () => void;
    onSave: (payload: { itemName: string; notes: string | null; offersCrafting: boolean }) => void;
}> = ({ existing, busy, onClose, onSave }) => {
    const [itemName, setItemName] = useState(existing?.itemName ?? '');
    const [notes, setNotes] = useState(existing?.notes ?? '');
    const [offers, setOffers] = useState(existing?.offersCrafting ?? false);

    return (
        <WindowFrame
            title={existing ? 'Edit Blueprint' : 'Register Blueprint'}
            subtitle={existing ? existing.itemName : 'Add an item you can make'}
            icon="fa-solid fa-scroll"
            isOpen
            onClose={onClose}
            color="purple"
            width="max-w-lg"
        >
            <div className="p-5 space-y-4">
                <div>
                    <label htmlFor="bp-item-name" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Item name</label>
                    <input id="bp-item-name" value={itemName} onChange={e => setItemName(e.target.value)} maxLength={160} disabled={busy} className={INPUT} placeholder="e.g. Ballista Dunestalker" />
                </div>
                <div>
                    <label htmlFor="bp-notes" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Notes <span className="text-slate-600">(optional)</span></label>
                    <textarea id="bp-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} maxLength={2000} disabled={busy} className={`${INPUT} resize-none`} placeholder="Materials you need supplied, lead time, anything a requester should know." />
                </div>
                <label className="flex items-start gap-2.5 text-sm text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={offers} onChange={e => setOffers(e.target.checked)} disabled={busy} className="mt-0.5 accent-purple-500" />
                    <span>
                        Offer to craft this for others
                        <span className="block text-[11px] text-slate-500 mt-0.5">
                            This publishes the ITEM to the crafting board — never your name — and is
                            the only thing that lets anyone raise a request for it. Yours to turn on
                            and off; nobody else can set it for you.
                        </span>
                    </span>
                </label>
            </div>
            <div className="p-5 border-t border-slate-800 flex items-center justify-end gap-2">
                <button type="button" onClick={onClose} disabled={busy} className={BTN_GHOST}>Cancel</button>
                <button
                    type="button"
                    disabled={busy || !itemName.trim()}
                    onClick={() => onSave({ itemName: itemName.trim(), notes: notes.trim() || null, offersCrafting: offers })}
                    className={BTN_PRIMARY}
                >
                    {existing ? 'Save' : 'Register'}
                </button>
            </div>
        </WindowFrame>
    );
};

// ════════════════════════════════════════════════════════════════════════════
// Raise a crafting request
// ════════════════════════════════════════════════════════════════════════════

const RequestModal: React.FC<{
    item: CraftableItem;
    busy: boolean;
    onClose: () => void;
    onSubmit: (payload: { quantity: number; materialsNote: string | null; offerPriceUec: number | null }) => void;
}> = ({ item, busy, onClose, onSubmit }) => {
    const [quantity, setQuantity] = useState('1');
    const [materialsNote, setMaterialsNote] = useState('');
    const [price, setPrice] = useState('');

    return (
        <WindowFrame
            title="Raise Crafting Request"
            subtitle={item.itemName}
            icon="fa-solid fa-hammer"
            isOpen
            onClose={onClose}
            color="purple"
            width="max-w-lg"
        >
            <div className="p-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label htmlFor="bp-qty" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Quantity</label>
                        <input id="bp-qty" type="number" min={1} max={10000} value={quantity} onChange={e => setQuantity(e.target.value)} disabled={busy} className={INPUT} />
                    </div>
                    <div>
                        <label htmlFor="bp-price" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Offered <span className="text-slate-600">(aUEC)</span></label>
                        <input id="bp-price" type="number" min={0} value={price} onChange={e => setPrice(e.target.value)} disabled={busy} className={INPUT} placeholder="Optional" />
                    </div>
                </div>
                <div>
                    <label htmlFor="bp-materials" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Materials note <span className="text-slate-600">(optional)</span></label>
                    <textarea id="bp-materials" value={materialsNote} onChange={e => setMaterialsNote(e.target.value)} rows={3} maxLength={2000} disabled={busy} className={`${INPUT} resize-none`} placeholder="What you can supply, where you'll collect, any deadline." />
                    <p className="text-[11px] text-slate-500 mt-1">
                        Visible to whoever claims the job, and on the board. It is not posted to Discord.
                    </p>
                </div>
            </div>
            <div className="p-5 border-t border-slate-800 flex items-center justify-end gap-2">
                <button type="button" onClick={onClose} disabled={busy} className={BTN_GHOST}>Cancel</button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSubmit({
                        quantity: Math.max(1, Math.min(10000, Math.floor(Number(quantity) || 1))),
                        materialsNote: materialsNote.trim() || null,
                        offerPriceUec: price.trim() === '' ? null : Math.max(0, Math.floor(Number(price) || 0)),
                    })}
                    className={BTN_PRIMARY}
                >
                    Raise Request
                </button>
            </div>
        </WindowFrame>
    );
};

// ════════════════════════════════════════════════════════════════════════════

export const BlueprintsView: React.FC = () => {
    const { rpcAction } = useData();
    const { hasPermission, currentUser } = useAuth();
    const { addToast, confirm } = useNotification();

    const canRegister = hasPermission('blueprint:register');
    const canRequest = hasPermission('blueprint:request');
    const canCraft = hasPermission('blueprint:craft');
    const canManage = hasPermission('blueprint:manage');
    const myId = currentUser?.id ?? null;

    const [tab, setTab] = useState<Tab>('craftable');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);

    const [craftable, setCraftable] = useState<CraftableItem[]>([]);
    const [craftableTruncated, setCraftableTruncated] = useState(false);
    const [registry, setRegistry] = useState<Blueprint[]>([]);
    const [requests, setRequests] = useState<BlueprintRequest[]>([]);

    const [search, setSearch] = useState('');
    const [editing, setEditing] = useState<Blueprint | null>(null);
    const [registerOpen, setRegisterOpen] = useState(false);
    const [requestItem, setRequestItem] = useState<CraftableItem | null>(null);

    const ok = useCallback((msg: string) => addToast(msg, <i className="fa-solid fa-check" />, OK_TOAST), [addToast]);
    const fail = useCallback((title: string, err: unknown) => addToast(title, <i className="fa-solid fa-xmark" />, ERR_TOAST, { description: errMsg(err) }), [addToast]);

    // All three tabs in one pass. They are small, they share the hero's counters,
    // and fetching per-tab would make those counters lie until you visited the tab.
    const fetchAll = useCallback(async () => {
        const [c, r, q] = await Promise.all([
            rpcAction('blueprint:list_craftable', {}) as Promise<{ items: CraftableItem[]; truncated: boolean }>,
            rpcAction('blueprint:list_registry', {}) as Promise<Blueprint[]>,
            rpcAction('blueprint:list_requests', {}) as Promise<BlueprintRequest[]>,
        ]);
        setCraftable(Array.isArray(c?.items) ? c.items : []);
        setCraftableTruncated(c?.truncated === true);
        setRegistry(Array.isArray(r) ? r : []);
        setRequests(Array.isArray(q) ? q : []);
    }, [rpcAction]);

    const reload = useCallback(async () => {
        try {
            await fetchAll();
        } catch (err) {
            fail('Failed to load Blueprints', err);
        }
    }, [fetchAll, fail]);

    // `loading` starts true and only ever goes false, so nothing is set
    // synchronously inside the effect (which would cascade a second render).
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                await fetchAll();
            } catch (err) {
                if (alive) fail('Failed to load Blueprints', err);
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [fetchAll, fail]);

    const run = useCallback(async (fn: () => Promise<unknown>, okMsg: string, failMsg: string) => {
        setBusy(true);
        try {
            await fn();
            ok(okMsg);
            await reload();
        } catch (err) {
            fail(failMsg, err);
        } finally {
            setBusy(false);
        }
    }, [ok, fail, reload]);

    // ── derived ──────────────────────────────────────────────────────────────
    const q = search.trim().toLowerCase();
    const craftableGroups = useMemo(() => {
        const filtered = q ? craftable.filter(i => i.itemName.toLowerCase().includes(q)) : craftable;
        const groups = new Map<string, CraftableItem[]>();
        for (const item of filtered) {
            const key = item.category || UNCATEGORISED;
            const arr = groups.get(key) || [];
            arr.push(item);
            groups.set(key, arr);
        }
        return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, [craftable, q]);

    const visibleRegistry = useMemo(
        () => (q ? registry.filter(b => b.itemName.toLowerCase().includes(q)) : registry),
        [registry, q],
    );

    const openRequests = requests.filter(r => r.status === 'open').length;
    const myOpen = requests.filter(r => r.requesterId === myId && r.status !== 'completed' && r.status !== 'cancelled').length;

    // ── request actions ──────────────────────────────────────────────────────
    const saveBlueprint = (payload: { itemName: string; notes: string | null; offersCrafting: boolean }) => {
        const target = editing;
        setRegisterOpen(false);
        setEditing(null);
        void run(
            () => target
                ? rpcAction('blueprint:update', { blueprintId: target.id, ...payload })
                : rpcAction('blueprint:register', payload),
            target ? 'Blueprint saved' : 'Blueprint registered',
            target ? 'Save failed' : 'Registration failed',
        );
    };

    const removeBlueprint = async (b: Blueprint) => {
        const yes = await confirm({
            title: 'Remove blueprint?',
            message: `"${b.itemName}" will be removed from the registry. Crafting requests already raised for it are unaffected.`,
            confirmText: 'Remove',
            variant: 'danger',
        });
        if (yes) void run(() => rpcAction('blueprint:delete', { blueprintId: b.id }), 'Blueprint removed', 'Removal failed');
    };

    const submitRequest = (payload: { quantity: number; materialsNote: string | null; offerPriceUec: number | null }) => {
        const item = requestItem;
        setRequestItem(null);
        if (!item) return;
        void run(
            () => rpcAction('blueprint:create_request', { itemName: item.itemName, qmCatalogId: item.qmCatalogId, ...payload }),
            'Request raised',
            'Request failed',
        );
        setTab('requests');
    };

    const cancelRequest = async (r: BlueprintRequest) => {
        const yes = await confirm({
            title: 'Cancel request?',
            message: `The request for "${r.itemName}" will be closed.`,
            confirmText: 'Cancel request',
            variant: 'warning',
        });
        if (yes) void run(() => rpcAction('blueprint:cancel_request', { requestId: r.id }), 'Request cancelled', 'Cancellation failed');
    };

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · BLUEPRINTS"
                chipIcon="fa-scroll"
                chipAccent="purple"
                title="Blueprint Manager"
                subtitle="What the org can make, and who is making it."
                titleBreakpoint="lg"
                actions={canRegister ? (
                    <HeroActionButton accent="purple" icon="fa-plus" onClick={() => { setEditing(null); setRegisterOpen(true); }}>Register Blueprint</HeroActionButton>
                ) : undefined}
                stats={
                    <>
                        <HeroStat label="Craftable Items" value={String(craftable.length)} icon="fa-hammer" accent="purple" />
                        <HeroStat label="Registered" value={String(registry.length)} icon="fa-scroll" accent="sky" />
                        <HeroStat label="Open Requests" value={String(openRequests)} icon="fa-inbox" accent="amber" />
                        <HeroStat label="Mine In Flight" value={String(myOpen)} icon="fa-user-clock" accent="emerald" />
                    </>
                }
                tabs={
                    <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar pb-1">
                        <TabButton id="craftable" active={tab} onSelect={setTab} label="Craftable" icon="fa-hammer" />
                        <TabButton id="registry" active={tab} onSelect={setTab} label="Registry" icon="fa-scroll" />
                        <TabButton id="requests" active={tab} onSelect={setTab} label="Requests" icon="fa-inbox" count={openRequests} />
                    </div>
                }
            />

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 sm:p-6 space-y-4">
                {tab !== 'requests' && (
                    <div className="relative max-w-sm">
                        <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs" aria-hidden />
                        <input
                            value={search} onChange={e => setSearch(e.target.value)}
                            placeholder="Search items" aria-label="Search items"
                            className="w-full bg-slate-800/60 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:ring-2 focus:ring-purple-500/50 outline-hidden"
                        />
                    </div>
                )}

                {loading ? <Spinner /> : (
                    <>
                        {/* ── CRAFTABLE ───────────────────────────────────── */}
                        {tab === 'craftable' && (
                            craftableGroups.length === 0 ? (
                                <EmptyState icon="fa-hammer" heading="Nothing on offer yet" accent="purple"
                                    description="Items appear here when a member registers a blueprint and offers to craft it. Your own offers are hidden — you cannot raise a request against yourself." />
                            ) : (
                                <div className="space-y-5">
                                    {craftableTruncated && (
                                        // Not decoration: the picker is capped, so "everything the org
                                        // can make" would be a claim the list cannot support.
                                        <p className="text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/25 rounded-lg px-3 py-2">
                                            <i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden />
                                            This list is capped — narrow it with the search box to see the rest.
                                        </p>
                                    )}
                                    {craftableGroups.map(([category, items]) => (
                                        <section key={category} className="space-y-2">
                                            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{category}</h3>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                                {items.map(item => (
                                                    <div key={`${item.category ?? ''}:${item.itemName}`} className={`${CARD} p-4 flex items-center gap-3`}>
                                                        <i className="fa-solid fa-cube text-purple-400/70" aria-hidden />
                                                        <span className="text-sm text-white flex-1 truncate">{item.itemName}</span>
                                                        {canRequest && (
                                                            <button type="button" disabled={busy} onClick={() => setRequestItem(item)}
                                                                className="shrink-0 px-3 py-1.5 text-[11px] font-black uppercase tracking-widest rounded-lg bg-purple-600 hover:bg-purple-500 text-white disabled:bg-slate-700">
                                                                Request
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    ))}
                                </div>
                            )
                        )}

                        {/* ── REGISTRY ────────────────────────────────────── */}
                        {tab === 'registry' && (
                            visibleRegistry.length === 0 ? (
                                <EmptyState icon="fa-scroll" heading="No blueprints registered" accent="purple"
                                    description="Register what you can make so the org knows where to come." />
                            ) : (
                                <div className="space-y-2">
                                    {visibleRegistry.map(b => {
                                        const mine = b.ownerId === myId;
                                        return (
                                            <div key={b.id} className={`${CARD} p-4 flex flex-wrap items-center gap-3`}>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-sm font-semibold text-white">{b.itemName}</span>
                                                        {b.category && <span className="text-[10px] uppercase tracking-widest text-slate-500">{b.category}</span>}
                                                        {b.offersCrafting && (
                                                            <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">Offers to craft</span>
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] text-slate-500 mt-0.5">
                                                        {/* Absent for a member who has left — the row is org history,
                                                            but a departed member is not named indefinitely. */}
                                                        {b.owner ? b.owner.name : 'Former member'}
                                                        {mine && <span className="text-purple-400 ml-1.5">· you</span>}
                                                    </p>
                                                    {b.notes && <p className="text-xs text-slate-400 mt-1.5 whitespace-pre-wrap break-words">{b.notes}</p>}
                                                </div>
                                                {(mine || canManage) && (
                                                    <div className="flex items-center gap-1 shrink-0">
                                                        {canRegister && (
                                                            <button type="button" disabled={busy} onClick={() => { setEditing(b); setRegisterOpen(true); }}
                                                                className="text-slate-500 hover:text-purple-400 px-2 py-1" aria-label={`Edit ${b.itemName}`}>
                                                                <i className="fa-solid fa-pen text-xs" aria-hidden />
                                                            </button>
                                                        )}
                                                        <button type="button" disabled={busy} onClick={() => void removeBlueprint(b)}
                                                            className="text-slate-500 hover:text-red-400 px-2 py-1" aria-label={`Remove ${b.itemName}`}>
                                                            <i className="fa-solid fa-trash text-xs" aria-hidden />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )
                        )}

                        {/* ── REQUESTS ────────────────────────────────────── */}
                        {tab === 'requests' && (
                            requests.length === 0 ? (
                                <EmptyState icon="fa-inbox" heading="No crafting requests" accent="purple"
                                    description={canCraft
                                        ? 'Open requests from anyone in the org land here, alongside your own.'
                                        : 'Requests you raise appear here. Claiming other people’s needs the crafting permission.'} />
                            ) : (
                                <div className="space-y-2">
                                    {requests.map(r => {
                                        const meta = STATUS_META[r.status];
                                        const isRequester = r.requesterId === myId;
                                        const isCrafter = r.crafterId === myId;
                                        return (
                                            <div key={r.id} className={`${CARD} p-4 space-y-2`}>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-sm font-semibold text-white">{r.itemName}</span>
                                                    <span className="text-xs text-slate-500">×{r.quantity}</span>
                                                    <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                                                    {typeof r.offerPriceUec === 'number' && r.offerPriceUec > 0 && (
                                                        <span className="text-[11px] text-amber-300">{r.offerPriceUec.toLocaleString('en-US')} aUEC</span>
                                                    )}
                                                    <span className="text-[11px] text-slate-600 ml-auto">
                                                        {r.requester ? r.requester.name : 'Former member'}
                                                        {r.crafter && <> → {r.crafter.name}</>}
                                                    </span>
                                                </div>
                                                {r.materialsNote && <p className="text-xs text-slate-400 whitespace-pre-wrap break-words">{r.materialsNote}</p>}
                                                {r.cancelReason && <p className="text-xs text-red-400/80">Cancelled: {r.cancelReason}</p>}
                                                <div className="flex flex-wrap items-center justify-end gap-2">
                                                    {canCraft && r.status === 'open' && !isRequester && (
                                                        <button type="button" disabled={busy} onClick={() => void run(() => rpcAction('blueprint:claim_request', { requestId: r.id }), 'Request claimed', 'Claim failed')} className={BTN_PRIMARY}>Claim</button>
                                                    )}
                                                    {r.status === 'claimed' && (isCrafter || canManage) && (
                                                        <button type="button" disabled={busy} onClick={() => void run(() => rpcAction('blueprint:release_request', { requestId: r.id }), 'Request released', 'Release failed')} className={BTN_GHOST}>Release</button>
                                                    )}
                                                    {r.status === 'claimed' && isCrafter && (
                                                        <button type="button" disabled={busy} onClick={() => void run(() => rpcAction('blueprint:mark_ready', { requestId: r.id }), 'Marked ready', 'Update failed')} className={BTN_PRIMARY}>Mark Ready</button>
                                                    )}
                                                    {r.status === 'ready' && isCrafter && (
                                                        <button type="button" disabled={busy} onClick={() => void run(() => rpcAction('blueprint:mark_delivered', { requestId: r.id }), 'Marked delivered', 'Update failed')} className={BTN_PRIMARY}>Mark Delivered</button>
                                                    )}
                                                    {r.status === 'delivered' && isRequester && (
                                                        // Requester only, and the server refuses a manage bypass too —
                                                        // confirming receipt on someone's behalf would forge it.
                                                        <button type="button" disabled={busy} onClick={() => void run(() => rpcAction('blueprint:confirm_received', { requestId: r.id }), 'Receipt confirmed', 'Confirmation failed')} className={BTN_PRIMARY}>Confirm Received</button>
                                                    )}
                                                    {(isRequester || canManage) && r.status !== 'completed' && r.status !== 'cancelled' && (
                                                        <button type="button" disabled={busy} onClick={() => void cancelRequest(r)} className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-red-400 hover:bg-red-500/10 rounded-lg disabled:opacity-40">Cancel</button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )
                        )}
                    </>
                )}
            </div>

            {registerOpen && (
                <RegisterModal existing={editing} busy={busy} onClose={() => { setRegisterOpen(false); setEditing(null); }} onSave={saveBlueprint} />
            )}
            {requestItem && (
                <RequestModal item={requestItem} busy={busy} onClose={() => setRequestItem(null)} onSubmit={submitRequest} />
            )}
        </div>
    );
};

export default BlueprintsView;
