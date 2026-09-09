import React, { useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useFormatDate } from '../../../contexts/AuthContext';
import type { WarehouseMovement, WarehouseMovementReason } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';

const REASON_LABEL: Record<WarehouseMovementReason, string> = {
    initial: 'Initial',
    adjust: 'Adjust',
    restock: 'Restock',
    withdraw_sale: 'Withdraw · Sale',
    withdraw_craft: 'Withdraw · Craft',
    withdraw_transport: 'Withdraw · Transport',
    withdraw_other: 'Withdraw · Other',
    transfer_in: 'Transfer In',
    transfer_out: 'Transfer Out',
    loss: 'Loss',
    destruction: 'Destruction',
};

const REASON_TONE: Record<WarehouseMovementReason, string> = {
    initial: 'text-slate-300',
    adjust: 'text-slate-300',
    restock: 'text-emerald-300',
    withdraw_sale: 'text-amber-300',
    withdraw_craft: 'text-amber-300',
    withdraw_transport: 'text-amber-300',
    withdraw_other: 'text-amber-300',
    transfer_in: 'text-cyan-300',
    transfer_out: 'text-cyan-300',
    loss: 'text-rose-300',
    destruction: 'text-rose-300',
};

interface Props {
    movements: WarehouseMovement[];
    isLoading: boolean;
    onRefresh: () => void;
}

export default function WhMovementsTab({ movements, isLoading, onRefresh }: Props) {
    const { rpcAction } = useData();
    const { addToast } = useNotification();
    const fmt = useFormatDate();
    const [reasonFilter, setReasonFilter] = useState<'all' | WarehouseMovementReason>('all');
    const [stockFilter, setStockFilter] = useState<'all' | number>('all');

    // Stock dropdown options come from the movements themselves now — every
    // movement carries its own embedded stock summary, so we just dedupe.
    const stockOptions = useMemo(() => {
        const seen = new Map<number, { id: number; label: string }>();
        for (const m of movements) {
            if (!m.stock || seen.has(m.stock.id)) continue;
            const cat = m.stock.catalog;
            const label = `${cat?.name || 'Stock'}${cat?.qualityLabel ? ` · ${cat.qualityLabel}` : ''} @ ${m.stock.location?.name || '?'}`;
            seen.set(m.stock.id, { id: m.stock.id, label });
        }
        return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
    }, [movements]);

    const filtered = useMemo(() => {
        return movements.filter((m) => {
            if (reasonFilter !== 'all' && m.reason !== reasonFilter) return false;
            if (stockFilter !== 'all' && m.stockId !== stockFilter) return false;
            return true;
        });
    }, [movements, reasonFilter, stockFilter]);

    const exportCsv = async () => {
        try {
            const res = await rpcAction('warehouse:export_csv', {});
            const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = res.filename || 'warehouse.csv';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            addToast('Export failed', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value as any)}
                    className="bg-slate-900 border border-white/10 rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-300">
                    <option value="all">All reasons</option>
                    {(Object.keys(REASON_LABEL) as WarehouseMovementReason[]).map((r) => (
                        <option key={r} value={r}>{REASON_LABEL[r]}</option>
                    ))}
                </select>

                <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                    className="bg-slate-900 border border-white/10 rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-300">
                    <option value="all">All stock</option>
                    {stockOptions.map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                </select>

                <div className="flex-1" />
                <button onClick={onRefresh}
                    className="inline-flex items-center gap-2 bg-slate-900 border border-white/10 hover:border-cyan-500/40 text-slate-300 hover:text-cyan-200 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition">
                    <i className="fa-solid fa-arrows-rotate" /> Refresh
                </button>
                <button onClick={exportCsv}
                    className="inline-flex items-center gap-2 bg-slate-900 border border-white/10 hover:border-cyan-500/40 text-slate-300 hover:text-cyan-200 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition">
                    <i className="fa-solid fa-file-csv" /> Export CSV
                </button>
            </div>

            {isLoading ? (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 p-10 text-center text-slate-500 text-sm">
                    <i className="fa-solid fa-spinner fa-spin mr-2" />Loading movements…
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 p-10 text-center text-slate-500 text-sm">
                    No movements match the current filters.
                </div>
            ) : (
                <div className="rounded-xl border border-white/5 bg-slate-900/30 overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/5 text-[10px] font-mono uppercase tracking-widest text-slate-500">
                                <th className="text-left px-4 py-2">When</th>
                                <th className="text-left px-4 py-2">Commodity</th>
                                <th className="text-left px-4 py-2">Reason</th>
                                <th className="text-right px-4 py-2">Delta</th>
                                <th className="text-left px-4 py-2">Actor</th>
                                <th className="text-left px-4 py-2">Source</th>
                                <th className="text-left px-4 py-2">Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((m) => {
                                const s = m.stock;
                                const cat = s?.catalog;
                                return (
                                    <tr key={m.id} className="border-b border-white/5 last:border-b-0 hover:bg-slate-800/30">
                                        <td className="px-4 py-2 text-[11px] font-mono text-slate-400 whitespace-nowrap">
                                            {fmt(m.createdAt)}
                                        </td>
                                        <td className="px-4 py-2 text-xs">
                                            <span className="text-white">{cat?.name || 'Stock'}</span>
                                            {cat?.qualityLabel && <span className="text-slate-500 font-mono"> · {cat.qualityLabel}</span>}
                                            {s?.location?.name && <span className="text-slate-500"> @ {s.location.name}</span>}
                                        </td>
                                        <td className={`px-4 py-2 text-[11px] font-bold uppercase tracking-widest ${REASON_TONE[m.reason]}`}>
                                            {REASON_LABEL[m.reason]}
                                        </td>
                                        <td className={`px-4 py-2 text-right font-mono font-bold ${m.delta > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                            {m.delta > 0 ? `+${m.delta}` : m.delta}
                                        </td>
                                        <td className="px-4 py-2 text-xs text-slate-400">
                                            {m.actor?.name || '—'}
                                        </td>
                                        <td className="px-4 py-2 text-[11px]">
                                            {m.relatedRequestId ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 font-mono uppercase tracking-widest">
                                                    <i className="fa-solid fa-file-pen text-[9px]" /> Request
                                                </span>
                                            ) : m.fromContract ? (
                                                // The BOOLEAN is what every ledger viewer gets. relatedContractId is
                                                // present only for a party to that contract (scoped in db.toMovement),
                                                // so the title attribute shows an id when there is one and nothing
                                                // when there is not — this is presentation, never the boundary.
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-indigo-300 bg-indigo-500/10 border border-indigo-500/30 font-mono uppercase tracking-widest"
                                                    title={m.relatedContractId ? `Contract ${m.relatedContractId}` : 'A marketplace contract you are not a party to'}>
                                                    <i className="fa-solid fa-handshake text-[9px]" /> Contract
                                                </span>
                                            ) : (
                                                <span className="text-slate-600">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2 text-xs text-slate-500 truncate max-w-xs" title={m.notes || ''}>
                                            {m.notes || '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
