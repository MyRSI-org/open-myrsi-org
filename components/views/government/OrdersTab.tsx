import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

/**
 * Orders tab — executive-style orders issued by position holders with
 * can_issue_orders. Lifecycle: draft → active → (expired | revoked).
 * Drafts are private to their author; published orders are org-visible.
 * Constitutional / legislative compliance is authored as a rationale field,
 * not algorithmically enforced.
 */

interface Order {
    id: string;
    number: string | null;
    title: string;
    preamble: string | null;
    body: string;
    rationale: string | null;
    status: 'draft' | 'active' | 'expired' | 'revoked';
    effective_at: string | null;
    expires_at: string | null;
    issued_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    created_at: string;
    issuer_user_id: number;
    issuer_position?: { id: number; name: string; icon: string | null } | null;
    issuer?: { id: number; name: string; avatar_url: string; rsi_handle: string } | null;
    revoked_by?: { id: number; name: string; avatar_url: string } | null;
}

interface IssuingPosition { id: number; name: string; icon: string | null; }

const STATUS_STYLES: Record<Order['status'], { label: string; pill: string; dot: string }> = {
    draft:    { label: 'Draft',    pill: 'bg-slate-500/10 text-slate-300 border-slate-500/30', dot: 'bg-slate-500' },
    active:   { label: 'Active',   pill: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', dot: 'bg-emerald-500' },
    expired:  { label: 'Expired',  pill: 'bg-amber-500/10 text-amber-400 border-amber-500/30', dot: 'bg-amber-500' },
    revoked:  { label: 'Revoked',  pill: 'bg-red-500/10 text-red-400 border-red-500/30', dot: 'bg-red-500' },
};

const OrdersTab: React.FC = () => {
    const { currentUser } = useAuth();
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const [orders, setOrders] = useState<Order[]>([]);
    const [myPositions, setMyPositions] = useState<IssuingPosition[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'active' | 'all' | 'drafts'>('active');
    const [selected, setSelected] = useState<Order | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [editing, setEditing] = useState<Order | null>(null);

    // Pure fetch: every setState runs after the awaited RPCs (or in finally), so
    // this is safe to call directly from the mount effect without a synchronous
    // set-in-effect. `loading` already initialises to true, so the spinner shows
    // on mount with no extra render pass.
    const fetchOrders = useCallback(async () => {
        try {
            const [rows, positions] = await Promise.all([
                rpcAction('gov:list_orders', {}),
                rpcAction('gov:get_my_issuing_positions', {}),
            ]);
            setOrders(Array.isArray(rows) ? (rows as Order[]) : []);
            setMyPositions(Array.isArray(positions) ? (positions as IssuingPosition[]) : []);
        } catch (err) {
            console.error('[Orders] Failed to load', err);
        } finally {
            setLoading(false);
        }
    }, [rpcAction]);

    // Imperative reload for handlers (save/revoke/delete): flips the spinner back
    // on before refetching. Invoked from event handlers only, never an effect, so
    // the synchronous setLoading(true) here is not a set-in-effect.
    const load = useCallback(async () => {
        setLoading(true);
        await fetchOrders();
    }, [fetchOrders]);

    // Await the fetch inside an async IIFE so every state update stays on the
    // post-await path the rule recognises (fetchOrders sets state only after the
    // awaited RPCs) — same timing as a bare call.
    useEffect(() => { void (async () => { await fetchOrders(); })(); }, [fetchOrders]);

    const canIssue = myPositions.length > 0;

    const filtered = useMemo(() => {
        if (filter === 'active') return orders.filter(o => o.status === 'active');
        if (filter === 'drafts') return orders.filter(o => o.status === 'draft' && o.issuer_user_id === currentUser?.id);
        return orders;
    }, [orders, filter, currentUser]);

    const counts = useMemo(() => ({
        active: orders.filter(o => o.status === 'active').length,
        drafts: orders.filter(o => o.status === 'draft' && o.issuer_user_id === currentUser?.id).length,
        all: orders.length,
    }), [orders, currentUser]);

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h2 className="text-xl font-bold text-white">Executive Orders</h2>
                    <p className="text-sm text-slate-400 mt-0.5">Binding directives issued by authorized position holders.</p>
                </div>
                {canIssue && (
                    <button onClick={() => setShowCreate(true)}
                        className="px-4 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-900/30 whitespace-nowrap">
                        <i className="fa-solid fa-gavel mr-2"></i>Issue Order
                    </button>
                )}
            </div>

            {/* Filter chips */}
            <div className="flex flex-wrap gap-2">
                <FilterChip active={filter === 'active'} onClick={() => setFilter('active')} label="In Force" count={counts.active} dot="bg-emerald-500" />
                {counts.drafts > 0 && (
                    <FilterChip active={filter === 'drafts'} onClick={() => setFilter('drafts')} label="My Drafts" count={counts.drafts} dot="bg-slate-500" />
                )}
                <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="All" count={counts.all} />
            </div>

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center h-40">
                    <i className="fa-solid fa-circle-notch animate-spin text-indigo-400 text-2xl"></i>
                </div>
            ) : filtered.length === 0 ? (
                <EmptyState canIssue={canIssue} onCreate={() => setShowCreate(true)} filter={filter} />
            ) : (
                <div className="space-y-3">
                    {filtered.map(order => (
                        <OrderCard key={order.id} order={order} onClick={() => setSelected(order)} />
                    ))}
                </div>
            )}

            {/* Modals */}
            {showCreate && canIssue && (
                <OrderEditorModal
                    positions={myPositions}
                    onClose={() => setShowCreate(false)}
                    onSaved={() => { setShowCreate(false); load(); }}
                />
            )}
            {editing && (
                <OrderEditorModal
                    positions={myPositions}
                    editing={editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); load(); }}
                />
            )}
            {selected && (
                <OrderDetailModal
                    order={selected}
                    isAuthor={selected.issuer_user_id === currentUser?.id}
                    onClose={() => setSelected(null)}
                    onEdit={() => { setEditing(selected); setSelected(null); }}
                    onRefresh={load}
                />
            )}
        </div>
    );
};

// Order card

const OrderCard: React.FC<{ order: Order; onClick: () => void }> = ({ order, onClick }) => {
    const fmt = useFormatDate();
    const s = STATUS_STYLES[order.status];
    return (
        <button onClick={onClick}
            className="w-full text-left bg-slate-900/60 hover:bg-slate-800/60 border border-slate-800 hover:border-indigo-500/40 rounded-xl p-5 transition-all duration-200 group">
            <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                    <i className="fa-solid fa-gavel text-indigo-400"></i>
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-widest border ${s.pill}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`}></span>{s.label}
                        </span>
                        {order.number && (
                            <span className="text-[10px] text-slate-500 font-mono">{order.number}</span>
                        )}
                    </div>
                    <h3 className="font-bold text-white text-base leading-snug group-hover:text-indigo-200 transition-colors">
                        {order.title}
                    </h3>
                    {order.preamble && (
                        <p className="text-xs text-slate-400 mt-1 line-clamp-2 italic">{order.preamble}</p>
                    )}
                    <div className="flex items-center gap-3 mt-3 text-[11px] text-slate-500">
                        {order.issuer && (
                            <span className="flex items-center gap-1.5">
                                {order.issuer.avatar_url && <img src={order.issuer.avatar_url} className="w-4 h-4 rounded-full" alt="" />}
                                <span className="text-slate-300">{order.issuer.name}</span>
                            </span>
                        )}
                        {order.issuer_position && (
                            <>
                                <span className="text-slate-700">·</span>
                                <span className="italic">{order.issuer_position.name}</span>
                            </>
                        )}
                        {order.issued_at && (
                            <>
                                <span className="text-slate-700">·</span>
                                <span>Issued {fmt.date(order.issued_at)}</span>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </button>
    );
};

// Empty state

const EmptyState: React.FC<{ canIssue: boolean; onCreate: () => void; filter: string }> = ({ canIssue, onCreate, filter }) => (
    <div className="bg-slate-900/30 border border-dashed border-slate-700 rounded-xl p-12 text-center">
        <i className="fa-solid fa-gavel text-4xl text-slate-600 mb-4"></i>
        <h3 className="text-lg font-bold text-white mb-2">
            {filter === 'active' ? 'No Active Orders' : filter === 'drafts' ? 'No Drafts' : 'No Orders Yet'}
        </h3>
        <p className="text-sm text-slate-400 max-w-md mx-auto">
            {canIssue
                ? 'As a position holder authorized to issue orders, you can draft and publish executive directives here.'
                : 'Only position holders granted Issue Orders authority can author new orders.'}
        </p>
        {canIssue && (
            <button onClick={onCreate}
                className="mt-4 px-5 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg bg-indigo-600 hover:bg-indigo-500">
                <i className="fa-solid fa-plus mr-2"></i>Draft an Order
            </button>
        )}
    </div>
);

// Editor modal (create + edit drafts)

const OrderEditorModal: React.FC<{
    positions: IssuingPosition[];
    editing?: Order;
    onClose: () => void;
    onSaved: () => void;
}> = ({ positions, editing, onClose, onSaved }) => {
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const [positionId, setPositionId] = useState<number>(
        editing?.issuer_position?.id || positions[0]?.id || 0
    );
    const [orderNumber, setOrderNumber] = useState(editing?.number || '');
    const [title, setTitle] = useState(editing?.title || '');
    const [preamble, setPreamble] = useState(editing?.preamble || '');
    const [body, setBody] = useState(editing?.body || '');
    const [rationale, setRationale] = useState(editing?.rationale || '');
    const [expiresAt, setExpiresAt] = useState<string>(editing?.expires_at ? editing.expires_at.slice(0, 10) : '');
    const [saving, setSaving] = useState(false);

    const canSubmit = title.trim().length >= 3 && body.trim().length >= 10 && positionId > 0;

    const submit = async (status: 'draft' | 'active') => {
        if (!canSubmit) return;
        setSaving(true);
        try {
            const payload: any = {
                issuerPositionId: positionId,
                number: orderNumber.trim() || null,
                title: title.trim(),
                preamble: preamble.trim() || null,
                body: body.trim(),
                rationale: rationale.trim() || null,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                status,
            };
            if (editing) {
                await rpcAction('gov:update_order', { orderId: editing.id, patch: payload });
            } else {
                await rpcAction('gov:create_order', { input: payload });
            }
            addToast(status === 'active' ? 'Order Issued' : 'Draft Saved',
                <i className={`fa-solid ${status === 'active' ? 'fa-gavel' : 'fa-floppy-disk'}`}></i>,
                'bg-indigo-500/10 text-indigo-300 border-indigo-500/50');
            onSaved();
        } catch (err: any) {
            addToast('Save Failed', <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        } finally {
            setSaving(false);
        }
    };

    return (
        <WindowFrame
            isOpen={true}
            onClose={onClose}
            title={editing ? 'Edit Draft Order' : 'New Executive Order'}
            subtitle="Executive Authority"
            icon="fa-solid fa-gavel"
            color="indigo"
            width="max-w-3xl"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    <p className="text-xs text-slate-400 italic">Orders bind the organization until revoked or expired. Document compliance in the rationale.</p>
                    {/* Position */}
                    <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Issuing Position</label>
                        <select value={positionId} onChange={e => setPositionId(Number(e.target.value))} disabled={!!editing}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 outline-hidden">
                            {positions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>

                    {/* Number + Title */}
                    <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3">
                        <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Number (Optional)</label>
                            <input value={orderNumber} onChange={e => setOrderNumber(e.target.value.slice(0, 40))}
                                placeholder="e.g. EO-2026-04"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-hidden" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Title</label>
                            <input value={title} onChange={e => setTitle(e.target.value.slice(0, 180))}
                                placeholder="Order title"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 outline-hidden" />
                        </div>
                    </div>

                    {/* Preamble */}
                    <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Preamble (Optional)</label>
                        <textarea value={preamble} onChange={e => setPreamble(e.target.value.slice(0, 600))} rows={2}
                            placeholder='"Whereas the organization faces…"'
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm italic focus:ring-2 focus:ring-indigo-500 outline-hidden" />
                    </div>

                    {/* Body */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Operative Body</label>
                            <span className="text-[10px] text-slate-500">{body.length} chars</span>
                        </div>
                        <textarea value={body} onChange={e => setBody(e.target.value.slice(0, 10000))} rows={10}
                            placeholder="The binding directive. Be clear and specific."
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 outline-hidden" />
                    </div>

                    {/* Rationale */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rationale (Compliance)</label>
                            <span className="text-[10px] text-slate-500">{rationale.length} chars</span>
                        </div>
                        <textarea value={rationale} onChange={e => setRationale(e.target.value.slice(0, 2000))} rows={4}
                            placeholder="Cite the constitutional and/or legislative basis. This is a public explanation of lawfulness — essential for accountability."
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 outline-hidden" />
                        <p className="text-[11px] text-slate-500 mt-2 italic">Compliance is documented here, not algorithmically enforced. A poorly-reasoned order can be revoked.</p>
                    </div>

                    {/* Expiry */}
                    <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Expiry Date (Optional)</label>
                        <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)}
                            className="w-full md:w-60 bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-indigo-500 outline-hidden" />
                        <p className="text-[11px] text-slate-500 mt-1">Leave blank for indefinite. Expired orders are automatically marked inactive.</p>
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 shrink-0 flex items-center justify-end gap-2">
                    <button onClick={onClose}
                        className="px-5 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white">
                        Cancel
                    </button>
                    <button onClick={() => submit('draft')} disabled={!canSubmit || saving}
                        className="px-5 py-2 text-xs font-bold uppercase tracking-widest text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed">
                        {saving ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Draft'}
                    </button>
                    <button onClick={() => submit('active')} disabled={!canSubmit || saving}
                        className="px-6 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-900/30 disabled:bg-slate-700 disabled:cursor-not-allowed">
                        {saving ? <i className="fa-solid fa-spinner animate-spin"></i> : (editing?.status === 'active' ? 'Save' : 'Issue Order')}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
};

// Detail modal (read + revoke)

const OrderDetailModal: React.FC<{
    order: Order;
    isAuthor: boolean;
    onClose: () => void;
    onEdit: () => void;
    onRefresh: () => void;
}> = ({ order, isAuthor, onClose, onEdit, onRefresh }) => {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const fmt = useFormatDate();
    const s = STATUS_STYLES[order.status];
    const [revoking, setRevoking] = useState(false);
    const [showRevoke, setShowRevoke] = useState(false);
    const [revokeReason, setRevokeReason] = useState('');

    const canEdit = isAuthor && order.status === 'draft';
    const canRevoke = isAuthor && order.status === 'active';
    const canDelete = isAuthor && order.status === 'draft';

    const handleDelete = async () => {
        const ok = await confirm({
            title: 'Delete Draft?',
            message: 'Discard this draft permanently.',
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await rpcAction('gov:delete_order', { orderId: order.id });
            addToast('Draft Deleted', <i className="fa-solid fa-trash"></i>, 'bg-slate-500/10 text-slate-400 border-slate-500/50');
            onRefresh();
            onClose();
        } catch (err: any) {
            addToast('Delete Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        }
    };

    const handleRevoke = async () => {
        setRevoking(true);
        try {
            await rpcAction('gov:revoke_order', { orderId: order.id, reason: revokeReason.trim() || null });
            addToast('Order Revoked', <i className="fa-solid fa-ban"></i>, 'bg-red-500/10 text-red-400 border-red-500/50');
            onRefresh();
            onClose();
        } catch (err: any) {
            addToast('Revoke Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        } finally {
            setRevoking(false);
        }
    };

    return (
        <WindowFrame
            isOpen={true}
            onClose={onClose}
            title={order.title}
            subtitle={order.issuer_position ? `By ${order.issuer_position.name}` : 'Executive Order'}
            icon="fa-solid fa-gavel"
            color="indigo"
            width="max-w-3xl"
        >
            <div className="flex flex-col h-full">
                {/* Masthead */}
                <div className="relative overflow-hidden p-6 border-b border-slate-800 bg-linear-to-br from-indigo-500/10 to-transparent">
                    <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-indigo-500/10 blur-2xl"></div>
                    <div className="relative">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-widest border ${s.pill}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`}></span>{s.label}
                            </span>
                            {order.number && (
                                <span className="text-[10px] text-slate-500 font-mono bg-slate-800/50 px-2 py-0.5 rounded-sm">{order.number}</span>
                            )}
                        </div>
                        {order.preamble && (
                            <p className="text-sm text-slate-300 italic mt-3 leading-relaxed border-l-2 border-indigo-500/40 pl-3">
                                {order.preamble}
                            </p>
                        )}
                    </div>
                </div>

                {/* Body */}
                <div className="p-6 space-y-5">
                    <div>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Operative Text</p>
                        <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{order.body}</p>
                    </div>

                    {order.rationale && (
                        <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4">
                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Rationale &amp; Compliance</p>
                            <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{order.rationale}</p>
                        </div>
                    )}

                    {/* Meta grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-4 border-t border-slate-800">
                        {order.issued_at && <MetaCell label="Issued" value={fmt.date(order.issued_at)} />}
                        {order.effective_at && <MetaCell label="Effective" value={fmt.date(order.effective_at)} />}
                        {order.expires_at && <MetaCell label="Expires" value={fmt.date(order.expires_at)} />}
                        {order.revoked_at && <MetaCell label="Revoked" value={fmt.date(order.revoked_at)} />}
                    </div>

                    {/* Issuer */}
                    {order.issuer && (
                        <div className="flex items-center gap-3 pt-4 border-t border-slate-800">
                            {order.issuer.avatar_url && <img src={order.issuer.avatar_url} className="w-10 h-10 rounded-full" alt="" />}
                            <div>
                                <p className="text-xs text-slate-500">Issued by</p>
                                <p className="text-sm font-bold text-white">{order.issuer.name}</p>
                                {order.issuer.rsi_handle && <p className="text-[10px] text-slate-500">@{order.issuer.rsi_handle}</p>}
                            </div>
                        </div>
                    )}

                    {/* Revocation */}
                    {order.status === 'revoked' && (
                        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4">
                            <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-2">Revocation</p>
                            {order.revoked_reason && (
                                <p className="text-sm text-slate-300 whitespace-pre-wrap mb-2">{order.revoked_reason}</p>
                            )}
                            {order.revoked_by && (
                                <p className="text-xs text-slate-500">
                                    By {order.revoked_by.name} on {order.revoked_at && fmt.date(order.revoked_at)}
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {/* Revoke inline form */}
                {showRevoke && (
                    <div className="p-6 border-t border-slate-800 bg-red-500/5">
                        <label className="block text-[10px] font-bold text-red-400 uppercase tracking-widest mb-2">Revocation Reason (Optional)</label>
                        <textarea value={revokeReason} onChange={e => setRevokeReason(e.target.value.slice(0, 500))} rows={3}
                            placeholder="Explain why this order is being rescinded."
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-2 focus:ring-red-500 outline-hidden" />
                        <div className="flex items-center justify-end gap-2 mt-3">
                            <button onClick={() => setShowRevoke(false)}
                                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white">
                                Cancel
                            </button>
                            <button onClick={handleRevoke} disabled={revoking}
                                className="px-5 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg bg-red-600 hover:bg-red-500">
                                {revoking ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Confirm Revocation'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 shrink-0 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        {canDelete && (
                            <button onClick={handleDelete}
                                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg">
                                <i className="fa-solid fa-trash mr-2"></i>Delete Draft
                            </button>
                        )}
                        {canRevoke && !showRevoke && (
                            <button onClick={() => setShowRevoke(true)}
                                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg">
                                <i className="fa-solid fa-ban mr-2"></i>Revoke Order
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={onClose}
                            className="px-5 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white">
                            Close
                        </button>
                        {canEdit && (
                            <button onClick={onEdit}
                                className="px-5 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg bg-indigo-600 hover:bg-indigo-500">
                                <i className="fa-solid fa-pen mr-2"></i>Edit
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

function MetaCell({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">{label}</p>
            <p className="text-sm text-white font-medium">{value}</p>
        </div>
    );
}

function FilterChip({ active, onClick, label, count, dot }: { active: boolean; onClick: () => void; label: string; count?: number; dot?: string }) {
    return (
        <button onClick={onClick}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-colors ${
                active
                    ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/30'
                    : 'bg-slate-800/60 text-slate-400 border border-slate-700 hover:border-slate-600'
            }`}>
            {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>}
            <span>{label}</span>
            {count != null && <span className="text-[10px] opacity-70">{count}</span>}
        </button>
    );
}

export default OrdersTab;
