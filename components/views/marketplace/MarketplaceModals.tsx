// Create-listing + listing-detail (propose) modals for the marketplace.
import React, { useEffect, useMemo, useState } from 'react';
import apiService from '../../../services/apiService';
import type { MarketplaceCategory, MarketplaceListing, MarketplaceListingType, MarketplaceTraderProfile } from '../../../types';
import { LISTING_TYPE_META, fmtUec } from './marketplaceMeta';
import ConsiderationBuilder from './ConsiderationBuilder';
import { ConsiderationList } from './ConsiderationDisplay';
import { type ConsiderationDraft, considerationsToDrafts, draftsToInput } from './considerationDrafts';
import WindowFrame from '../../layout/WindowFrame';

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
    <div>
        <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{label}</label>
        {children}
        {hint && <p className="text-[10px] text-slate-500 mt-1">{hint}</p>}
    </div>
);

const inputCls = 'w-full bg-slate-800 border border-slate-600 rounded-md px-3 py-2 text-white text-sm outline-hidden focus:border-indigo-500';

interface WhStockOption { id: number; label: string }

const REPORT_REASONS: { value: string; label: string }[] = [
    { value: 'prohibited', label: 'Prohibited / banned goods' },
    { value: 'scam', label: 'Scam or fraud' },
    { value: 'spam', label: 'Spam or duplicate' },
    { value: 'misleading', label: 'Misleading description or price' },
    { value: 'harassment', label: 'Harassment or abuse' },
    { value: 'other', label: 'Other' },
];

// Confidential flag to moderators. Reused by the listing + contract detail modals;
// the caller wires onSubmit to the marketplace:report action with the right target.
export const ReportModal: React.FC<{
    targetLabel: string;
    onClose: () => void;
    onSubmit: (reasonCategory: string, details: string) => Promise<void>;
}> = ({ targetLabel, onClose, onSubmit }) => {
    const [reason, setReason] = useState('prohibited');
    const [details, setDetails] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async () => { setBusy(true); await onSubmit(reason, details.trim()).finally(() => setBusy(false)); };
    return (
        <WindowFrame isOpen onClose={onClose} title="Report" subtitle={targetLabel} icon="fa-solid fa-flag" color="red" width="max-w-md">
            <div className="p-5 space-y-4">
                <p className="text-xs text-slate-400">Flag this for a moderator to review. Reports are confidential — the other party isn't notified you reported.</p>
                <Field label="Reason">
                    <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls}>
                        {REPORT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                </Field>
                <Field label="Details (optional)">
                    <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} className={`${inputCls} min-h-[90px]`} placeholder="What's wrong with this?" />
                </Field>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-700/60">
                <button onClick={onClose} className="text-xs font-bold uppercase px-4 py-2 rounded-md text-slate-300 hover:text-white">Cancel</button>
                <button onClick={submit} disabled={busy} className="text-xs font-bold uppercase px-4 py-2 rounded-md bg-red-600 hover:bg-red-500 text-white disabled:opacity-50">
                    {busy ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-flag mr-2"></i>Submit Report</>}
                </button>
            </div>
        </WindowFrame>
    );
};

export const CreateListingModal: React.FC<{
    categories: MarketplaceCategory[];
    onClose: () => void;
    onCreate: (input: Record<string, unknown>) => Promise<void>;
}> = ({ categories, onClose, onCreate }) => {
    const [listingType, setListingType] = useState<MarketplaceListingType>('sell');
    const kind: 'item' | 'service' = listingType === 'sell' || listingType === 'buy' ? 'item' : 'service';
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [categoryId, setCategoryId] = useState<number | ''>('');
    const [quantity, setQuantity] = useState('1');
    const [priceUec, setPriceUec] = useState('');
    const [priceType, setPriceType] = useState('fixed');
    const [location, setLocation] = useState('');
    const [warehouseStockId, setWarehouseStockId] = useState<number | ''>('');
    const [whStock, setWhStock] = useState<WhStockOption[]>([]);
    const [legs, setLegs] = useState<ConsiderationDraft[]>([]);
    const [busy, setBusy] = useState(false);

    // Best-effort warehouse stock list for the optional link (empty if no perm).
    useEffect(() => {
        let alive = true;
        apiService.getStateSubset('warehouse_stock').then((d) => {
            if (!alive) return;
            const rows = (d?.warehouseStock || []) as { id: number; catalog?: { name?: string }; quantityOnHand?: number }[];
            setWhStock(rows.map((r) => ({ id: r.id, label: `${r.catalog?.name || `Stock #${r.id}`} (${r.quantityOnHand ?? 0} on hand)` })));
        }).catch(() => undefined);
        return () => { alive = false; };
    }, []);

    const catOptions = useMemo(() => categories.filter((c) => c.listingKind === 'both' || c.listingKind === kind), [categories, kind]);

    const submit = async () => {
        if (!title.trim()) return;
        setBusy(true);
        await onCreate({
            kind, listingType, categoryId: categoryId || null, title: title.trim(),
            description: description.trim() || undefined,
            quantity: kind === 'item' ? Number(quantity) : null,
            priceUec: priceUec ? Number(priceUec) : null, priceType,
            location: location.trim() || undefined,
            warehouseStockId: kind === 'item' && warehouseStockId ? Number(warehouseStockId) : null,
            considerations: draftsToInput(legs),
        }).finally(() => setBusy(false));
    };

    return (
        <WindowFrame isOpen onClose={onClose} title="New Listing" subtitle="Marketplace" icon="fa-solid fa-plus" color="indigo" width="max-w-lg">
            <div className="p-5 space-y-4">
                <Field label="Listing Type">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {(['sell', 'buy', 'offer', 'request'] as MarketplaceListingType[]).map((t) => {
                            const m = LISTING_TYPE_META[t];
                            return (
                                <button key={t} onClick={() => setListingType(t)}
                                    className={`flex flex-col items-center gap-1 py-2 rounded-md border text-[11px] font-bold transition-colors ${listingType === t ? m.chip : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-white'}`}>
                                    <i className={`fa-solid ${m.icon}`} aria-hidden />{m.label}
                                </button>
                            );
                        })}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1.5">{kind === 'item' ? 'An item trade — quantity applies.' : 'A service — no quantity; add milestones when a contract is proposed.'}</p>
                </Field>
                <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} className={inputCls} placeholder={kind === 'item' ? 'e.g. Idris-P power plant' : 'e.g. Cargo hauling, any system'} /></Field>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Category">
                        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')} className={inputCls}>
                            <option value="">Uncategorised</option>
                            {catOptions.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '— ' : ''}{c.name}</option>)}
                        </select>
                    </Field>
                    {kind === 'item' && <Field label="Quantity"><input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} /></Field>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Price (aUEC)"><input type="number" min={0} value={priceUec} onChange={(e) => setPriceUec(e.target.value)} className={inputCls} placeholder="Leave blank = negotiable" /></Field>
                    <Field label="Pricing">
                        <select value={priceType} onChange={(e) => setPriceType(e.target.value)} className={inputCls}>
                            <option value="fixed">Fixed</option>
                            <option value="negotiable">Negotiable</option>
                            {kind === 'item' ? <option value="per_unit">Per unit</option> : <option value="hourly">Per hour</option>}
                        </select>
                    </Field>
                </div>
                <Field label="Location (optional)"><input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={160} className={inputCls} placeholder="e.g. Port Olisar / Area18" /></Field>
                {kind === 'item' && whStock.length > 0 && (
                    <Field label="Link Warehouse Stock (optional)" hint="Reserves and moves real stock when the contract is accepted & delivered.">
                        <select value={warehouseStockId} onChange={(e) => setWarehouseStockId(e.target.value ? Number(e.target.value) : '')} className={inputCls}>
                            <option value="">No warehouse link</option>
                            {whStock.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                    </Field>
                )}
                <Field label="Description (optional)"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} className={`${inputCls} min-h-[80px]`} /></Field>
                <ConsiderationBuilder drafts={legs} onChange={setLegs} disabled={busy} />
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-700/60">
                <button onClick={onClose} className="text-xs font-bold uppercase px-4 py-2 rounded-md text-slate-300 hover:text-white">Cancel</button>
                <button onClick={submit} disabled={busy || !title.trim()} className="text-xs font-bold uppercase px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
                    {busy ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Post Listing'}
                </button>
            </div>
        </WindowFrame>
    );
};

// Public trader card: aggregate reputation + that trader's active listings. Reached by
// clicking a seller's name. Deliberately shows NO per-rating feedback or rater identities —
// getMarketplaceTraderProfile withholds them because they are party-confidential, and this
// modal must not imply otherwise.
const TraderProfileModal: React.FC<{
    userId: number; fallbackName: string;
    rpcAction: (action: string, payload: Record<string, unknown>) => Promise<any>;
    onClose: () => void;
}> = ({ userId, fallbackName, rpcAction, onClose }) => {
    const [profile, setProfile] = useState<MarketplaceTraderProfile | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const p = await rpcAction('marketplace:get_profile', { targetUserId: userId });
                if (cancelled) return;
                setProfile((p as MarketplaceTraderProfile) || null);
                setState('ready');
            } catch {
                if (!cancelled) setState('error');
            }
        })();
        return () => { cancelled = true; };
    }, [rpcAction, userId]);

    const rep = profile?.reputation;
    return (
        <WindowFrame isOpen onClose={onClose} title={profile?.trader?.name || fallbackName} subtitle="Trader Profile" icon="fa-solid fa-user-tag" color="indigo" width="max-w-lg">
            <div className="p-5 space-y-4">
                {state === 'loading' && <div className="text-center text-slate-500 py-8"><i className="fa-solid fa-spinner animate-spin text-xl" /></div>}
                {state === 'error' && <p className="text-center text-slate-500 text-sm py-8 italic">Could not load this trader&apos;s profile.</p>}
                {state === 'ready' && !profile && <p className="text-center text-slate-500 text-sm py-8 italic">This trader is no longer active.</p>}
                {state === 'ready' && profile && (
                    <>
                        <div className="flex items-center gap-3">
                            {profile.trader?.avatarUrl && <img src={profile.trader.avatarUrl} alt="" className="w-12 h-12 rounded-full" />}
                            <div className="min-w-0">
                                <p className="text-sm font-bold text-white truncate">{profile.trader?.name}</p>
                                {profile.trader?.rsiHandle && <p className="text-[11px] text-slate-500 truncate">{profile.trader.rsiHandle}</p>}
                            </div>
                            {rep && (
                                <span className="ml-auto text-right">
                                    <span className="block text-[10px] font-black uppercase tracking-wider text-indigo-300">{rep.tier}</span>
                                    <span className="block text-xs text-slate-400 font-mono">
                                        {rep.ratingCount > 0 ? `${rep.averageStars.toFixed(1)} ★ · ${rep.ratingCount}` : 'No ratings yet'}
                                    </span>
                                </span>
                            )}
                        </div>
                        <div>
                            <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-2">Active Listings</h4>
                            {profile.activeListings.length === 0 ? (
                                <p className="text-xs text-slate-600 italic">Nothing on the board right now.</p>
                            ) : (
                                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                                    {profile.activeListings.map((l) => (
                                        <div key={l.id} className="flex items-center gap-2 p-2 rounded-md bg-slate-800/30 border border-slate-700/40">
                                            <i className={`fa-solid ${LISTING_TYPE_META[l.listingType].icon} text-slate-500 text-xs`} aria-hidden />
                                            <span className="text-xs text-slate-200 truncate flex-1">{l.title}</span>
                                            <span className="text-xs font-mono text-lime-400 shrink-0">{l.priceUec != null ? fmtUec(l.priceUec) : '—'}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </WindowFrame>
    );
};

const OWNER_STATUS_META: Record<string, { label: string; cls: string }> = {
    active: { label: 'Live', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
    paused: { label: 'Paused', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
    closed: { label: 'Closed', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/40' },
    expired: { label: 'Expired', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/40' },
};

export const ListingDetailModal: React.FC<{
    listing: MarketplaceListing; meId: number; canContract: boolean;
    rpcAction: (action: string, payload: Record<string, unknown>) => Promise<any>;
    onClose: () => void;
    onPropose: (payload: Record<string, unknown>) => Promise<void>;
    onDelete: () => Promise<void>;
    onReport: (payload: { reasonCategory: string; details?: string }) => Promise<void>;
    onUpdate: (updates: Record<string, unknown>) => Promise<boolean>;
}> = ({ listing: listingProp, meId, canContract, rpcAction, onClose, onPropose, onDelete, onReport, onUpdate }) => {
    // Re-read the listing on open. The array this modal was opened from is a snapshot: another
    // member may have claimed units since the board loaded, so `remaining` — the number a buyer
    // decides their quantity against — can be stale. Shadows the prop so every reference below
    // sees the fresher copy, and falls back to it silently if the read fails.
    const [fresh, setFresh] = useState<MarketplaceListing | null>(null);
    const listing = fresh ?? listingProp;
    const [showTrader, setShowTrader] = useState(false);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const l = await rpcAction('marketplace:get_listing', { id: listingProp.id });
                if (!cancelled && l) setFresh(l as MarketplaceListing);
            } catch { /* keep the board copy */ }
        })();
        return () => { cancelled = true; };
    }, [rpcAction, listingProp.id]);

    const isOwner = listing.sellerId === meId;
    const isItem = listing.kind === 'item';
    const remaining = listing.quantity != null ? Math.max(0, listing.quantity - listing.quantityClaimed) : null;
    const [showReport, setShowReport] = useState(false);
    const [qty, setQty] = useState('1');
    const [offer, setOffer] = useState(listing.priceUec != null ? String(listing.priceUec) : '');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [eTitle, setETitle] = useState(listing.title);
    const [eDesc, setEDesc] = useState(listing.description || '');
    const [ePrice, setEPrice] = useState(listing.priceUec != null ? String(listing.priceUec) : '');
    const [eLocation, setELocation] = useState(listing.location || '');
    const [eLegs, setELegs] = useState<ConsiderationDraft[]>(() => considerationsToDrafts(listing.considerations));
    // What the PROPOSER is putting up. Locked to the offer side: a proposal is one
    // party's half of the trade, and the server records it that way regardless.
    const [pLegs, setPLegs] = useState<ConsiderationDraft[]>([]);
    const meta = LISTING_TYPE_META[listing.listingType];

    const beginEdit = () => {
        // Seed from the CURRENT copy each time, not from the prop captured at mount.
        setETitle(listing.title);
        setEDesc(listing.description || '');
        setEPrice(listing.priceUec != null ? String(listing.priceUec) : '');
        setELocation(listing.location || '');
        setELegs(considerationsToDrafts(listing.considerations));
        setEditing(true);
    };

    const saveEdit = async () => {
        setBusy(true);
        const ok = await onUpdate({
            title: eTitle.trim(),
            description: eDesc.trim(),
            priceUec: ePrice.trim() === '' ? null : Number(ePrice),
            location: eLocation.trim(),
            // An ARRAY always — including an empty one, which is the explicit clear.
            // Sending null would mean "unchanged" and a seller could never remove the
            // last barter item.
            considerations: draftsToInput(eLegs),
        }).finally(() => setBusy(false));
        if (ok) { setEditing(false); onClose(); }
    };

    const setStatus = async (status: string) => {
        setBusy(true);
        // No client-side moderation check. A listing a moderator closed CAN be selected for
        // resume here and the server refuses it with the reason — which is deliberate: the
        // alternative is projecting moderation_closed_at onto every listing read, where every
        // marketplace:view holder would learn which listings were actioned.
        const ok = await onUpdate({ status }).finally(() => setBusy(false));
        if (ok) onClose();
    };

    const propose = async () => {
        setBusy(true);
        await onPropose({
            listingId: listing.id,
            quantity: isItem ? Number(qty) : null,
            agreedPriceUec: offer ? Number(offer) : null,
            termsNote: note.trim() || undefined,
            considerations: draftsToInput(pLegs),
        }).finally(() => setBusy(false));
    };

    return (
        <>
        <WindowFrame isOpen onClose={onClose} title={listing.title} subtitle="Marketplace" icon={`fa-solid ${meta.icon}`} color="indigo" width="max-w-2xl">
            <div className="p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${meta.chip}`}><i className={`fa-solid ${meta.icon} mr-1`} aria-hidden />{meta.label}</span>
                    {listing.categoryName && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm border bg-slate-700/30 text-slate-300 border-slate-600/40">{listing.categoryName}</span>}
                    <span className="ml-auto text-lg font-black text-lime-400 font-mono">{listing.priceUec != null ? fmtUec(listing.priceUec) : 'Negotiable'}</span>
                </div>
                {(listing.considerations?.length ?? 0) > 0 && (
                    <div className="bg-slate-950/30 border border-slate-800/50 rounded-lg p-3">
                        <ConsiderationList priceUec={null} considerations={listing.considerations} showDisclaimer />
                    </div>
                )}
                <div className="flex flex-wrap gap-4 text-xs text-slate-400">
                    <button type="button" onClick={() => setShowTrader(true)} className="inline-flex items-center gap-1.5 hover:text-indigo-300 transition-colors">
                        {listing.seller?.avatarUrl && <img src={listing.seller.avatarUrl} alt="" className="w-5 h-5 rounded-full" />}
                        {listing.seller?.name || `User #${listing.sellerId}`}
                    </button>
                    {isItem && remaining != null && <span><i className="fa-solid fa-layer-group mr-1 text-slate-500" aria-hidden />{remaining} of {listing.quantity} available</span>}
                    {listing.location && <span><i className="fa-solid fa-location-dot mr-1 text-slate-500" aria-hidden />{listing.location}</span>}
                    {listing.warehouseStockId && <span className="text-cyan-400"><i className="fa-solid fa-boxes-stacked mr-1" aria-hidden />Warehouse-linked</span>}
                </div>
                {listing.description && <p className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-950/30 border border-slate-800/50 rounded-lg p-3">{listing.description}</p>}

                {!isOwner && canContract && (
                    <div className="border-t border-slate-700/50 pt-4 space-y-3">
                        <h4 className="text-xs font-black uppercase tracking-wider text-indigo-300">Propose a Contract</h4>
                        <div className="grid grid-cols-2 gap-3">
                            {isItem && (
                                <Field label="Quantity"><input type="number" min={1} max={remaining ?? undefined} value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} /></Field>
                            )}
                            <Field label="Your Offer (aUEC)"><input type="number" min={0} value={offer} onChange={(e) => setOffer(e.target.value)} className={inputCls} placeholder="Optional" /></Field>
                        </div>
                        <Field label="Note to counterparty (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={250} className={inputCls} placeholder="Terms, timing, handoff details…" /></Field>
                        <ConsiderationBuilder drafts={pLegs} onChange={setPLegs} disabled={busy} sideLocked="offer" />
                        <button onClick={propose} disabled={busy} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider py-2.5 rounded-md disabled:opacity-50">
                            {busy ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-handshake mr-2"></i>Propose Contract</>}
                        </button>
                    </div>
                )}
                {isOwner && (
                    <div className="border-t border-slate-700/50 pt-4 space-y-3">
                        <div className="flex items-center gap-2">
                            <h4 className="text-xs font-black uppercase tracking-wider text-purple-300">Manage Your Listing</h4>
                            <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${OWNER_STATUS_META[listing.status]?.cls || 'bg-slate-700/30 text-slate-300 border-slate-600/40'}`}>
                                {OWNER_STATUS_META[listing.status]?.label || listing.status}
                            </span>
                        </div>

                        {editing ? (
                            <div className="space-y-3">
                                <Field label="Title"><input value={eTitle} onChange={(e) => setETitle(e.target.value)} maxLength={160} className={inputCls} /></Field>
                                <Field label="Description"><textarea rows={3} value={eDesc} onChange={(e) => setEDesc(e.target.value)} maxLength={4000} className={`${inputCls} resize-none`} /></Field>
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="Price (aUEC)" hint="Leave blank for negotiable"><input type="number" min={0} value={ePrice} onChange={(e) => setEPrice(e.target.value)} className={inputCls} /></Field>
                                    <Field label="Location"><input value={eLocation} onChange={(e) => setELocation(e.target.value)} maxLength={160} className={inputCls} /></Field>
                                </div>
                                <ConsiderationBuilder drafts={eLegs} onChange={setELegs} disabled={busy} />
                                <div className="flex gap-2">
                                    <button onClick={saveEdit} disabled={busy || !eTitle.trim()} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase py-2 rounded-md disabled:opacity-50">
                                        {busy ? <i className="fa-solid fa-spinner animate-spin" /> : <><i className="fa-solid fa-check mr-2" />Save Changes</>}
                                    </button>
                                    <button onClick={() => setEditing(false)} disabled={busy} className="px-4 text-xs font-bold uppercase text-slate-400 hover:text-white rounded-md border border-slate-700/60">Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                <button onClick={beginEdit} disabled={busy} className="text-xs font-bold uppercase px-3 py-2 rounded-md bg-slate-700/50 hover:bg-slate-700 text-slate-200 border border-slate-600/50 disabled:opacity-50">
                                    <i className="fa-solid fa-pen mr-2" />Edit
                                </button>
                                {listing.status === 'active' ? (
                                    <button onClick={() => setStatus('paused')} disabled={busy} className="text-xs font-bold uppercase px-3 py-2 rounded-md bg-amber-600/70 hover:bg-amber-500 text-white disabled:opacity-50">
                                        <i className="fa-solid fa-pause mr-2" />Pause
                                    </button>
                                ) : (
                                    <button onClick={() => setStatus('active')} disabled={busy} className="text-xs font-bold uppercase px-3 py-2 rounded-md bg-emerald-600/80 hover:bg-emerald-500 text-white disabled:opacity-50">
                                        <i className="fa-solid fa-play mr-2" />Resume
                                    </button>
                                )}
                                {listing.status !== 'closed' && (
                                    <button onClick={() => setStatus('closed')} disabled={busy} className="text-xs font-bold uppercase px-3 py-2 rounded-md bg-slate-700/50 hover:bg-slate-700 text-slate-200 border border-slate-600/50 disabled:opacity-50">
                                        <i className="fa-solid fa-box-archive mr-2" />Close
                                    </button>
                                )}
                            </div>
                        )}
                        <p className="text-[11px] text-slate-500 italic">
                            Paused and closed listings leave the board but stay in My Listings. Manage incoming contracts from the My Contracts queue.
                        </p>
                    </div>
                )}
            </div>
            <div className="flex justify-end px-5 py-4 border-t border-slate-700/60">
                {isOwner ? (
                    <button onClick={onDelete} className="text-xs font-bold uppercase px-4 py-2 rounded-md bg-red-600/80 hover:bg-red-500 text-white">
                        <i className="fa-solid fa-trash mr-2"></i>Remove Listing
                    </button>
                ) : (
                    <button onClick={() => setShowReport(true)} className="text-xs font-bold uppercase px-4 py-2 rounded-md text-slate-400 hover:text-red-300 border border-slate-700/60 hover:border-red-500/40 transition-colors">
                        <i className="fa-solid fa-flag mr-2"></i>Report
                    </button>
                )}
            </div>
        </WindowFrame>
        {showReport && (
            <ReportModal targetLabel={listing.title} onClose={() => setShowReport(false)}
                onSubmit={async (reasonCategory, details) => { await onReport({ reasonCategory, details: details || undefined }); setShowReport(false); }} />
        )}
        {showTrader && (
            <TraderProfileModal userId={listing.sellerId} fallbackName={listing.seller?.name || `User #${listing.sellerId}`}
                rpcAction={rpcAction} onClose={() => setShowTrader(false)} />
        )}
        </>
    );
};
