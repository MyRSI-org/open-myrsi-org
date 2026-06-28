import React, { useMemo, useState } from 'react';
import { HydratedOperation, OperationStatus, OperationPayoutMode, OperationCostCategory } from '../../../../types';
import PieChart from '../../../charts/PieChart';
import { useFormatDate } from '../../../../contexts/AuthContext';
import { useOperations } from '../../../../contexts/OperationsContext';
import { computePayouts, PayoutRow } from '../../../../lib/operations/payouts';
import { useNotification } from '../../../../contexts/NotificationContext';

interface OpLedgerTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    onOpenAddUec: () => void;
    onOpenAddCost: () => void;
}

const COST_CATEGORY_LABEL: Record<OperationCostCategory, { label: string; icon: string }> = {
    fuel:         { label: 'Fuel',        icon: 'fa-gas-pump' },
    repairs:      { label: 'Repairs',     icon: 'fa-wrench' },
    supplies:     { label: 'Supplies',    icon: 'fa-boxes-stacked' },
    consumables:  { label: 'Consumables', icon: 'fa-bottle-water' },
    crew:         { label: 'Crew',        icon: 'fa-users' },
    other:        { label: 'Other',       icon: 'fa-ellipsis' },
};

type TxFilter = 'all' | 'deposits' | 'costs';

const OpLedgerTab: React.FC<OpLedgerTabProps> = ({ operation, canManage, onOpenAddUec, onOpenAddCost }) => {
    const fmt = useFormatDate();
    const { setOperationPayoutMode, setOperationPayoutSplits, toggleParticipantPayoutPaid } = useOperations();
    const { addToast } = useNotification();
    // No such field exists on the UI context; consumers fall through to their `|| []` fallback.
    const allUsers: any = undefined;

    const concluded = operation.status === OperationStatus.Concluded;
    const editable = canManage && !concluded;

    const totalPool = operation.totalUec || 0;
    const totalCosts = operation.totalCosts || 0;
    const netPool = totalPool - totalCosts;

    const payouts: PayoutRow[] = useMemo(() => computePayouts(operation, netPool), [operation, netPool]);
    const pieData = payouts.map(r => ({ name: r.name, value: r.amount }));

    const isCustom = operation.payoutMode === 'custom';

    // Seed the editable draft from current participants. draftSplits is form
    // state (the user types percentages into it), so it cannot be derived during
    // render — that would clobber in-progress edits. It is (re-)seeded only when
    // the seed key changes: op id, custom-vs-not mode, or the participant *count*
    // (NOT individual participant data, so a realtime share update on an
    // unrelated participant does not clobber the user's typed edits — this
    // preserves the old exhaustive-deps exclusion).
    const computeSeedSplits = (): Record<number, string> => {
        if (!isCustom) return {};
        const seed: Record<number, string> = {};
        operation.participants.forEach(p => {
            const v = typeof p.payoutSharePercent === 'number'
                ? p.payoutSharePercent
                : 100 / Math.max(1, operation.participants.length);
            seed[p.userId] = v.toFixed(2);
        });
        return seed;
    };

    const splitsSeedKey = `${operation.id}|${isCustom ? '1' : '0'}|${operation.participants.length}`;
    // Lazy-init to the mount seed so the first render matches the old mount effect.
    const [draftSplits, setDraftSplits] = useState<Record<number, string>>(computeSeedSplits);
    const [savingSplits, setSavingSplits] = useState(false);

    // Re-seed during render when the key changes (the React-documented "adjust
    // state during render" pattern; React re-renders before paint, so this is
    // equivalent to the old effect-reset without firing the set-state-in-effect rule).
    const [prevSplitsSeedKey, setPrevSplitsSeedKey] = useState(splitsSeedKey);
    if (splitsSeedKey !== prevSplitsSeedKey) {
        setPrevSplitsSeedKey(splitsSeedKey);
        setDraftSplits(computeSeedSplits());
    }

    const draftSum = Object.values(draftSplits).reduce((s, v) => s + (Number(v) || 0), 0);
    const draftValid = draftSum >= 99.9 && draftSum <= 100.1;

    const handleResetEven = () => {
        const n = operation.participants.length;
        if (n === 0) return;
        const each = (100 / n).toFixed(2);
        const seed: Record<number, string> = {};
        operation.participants.forEach(p => { seed[p.userId] = each; });
        setDraftSplits(seed);
    };

    const handleSaveSplits = async () => {
        if (!draftValid) {
            addToast('Validation Error', <i className="fa-solid fa-triangle-exclamation"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50',
                { description: `Splits must total 100% (currently ${draftSum.toFixed(2)}%).` });
            return;
        }
        setSavingSplits(true);
        try {
            const splits = Object.entries(draftSplits).map(([uid, v]) => ({ userId: Number(uid), percent: Number(v) || 0 }));
            await setOperationPayoutSplits(operation.id, splits);
            addToast('Splits Saved', <i className="fa-solid fa-check"></i>, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
        } catch (err: any) {
            addToast('Save Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Failed to save splits.' });
        } finally {
            setSavingSplits(false);
        }
    };

    const handleModeChange = async (mode: OperationPayoutMode) => {
        try {
            await setOperationPayoutMode(operation.id, mode);
        } catch (err: any) {
            addToast('Failed to Change Mode', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        }
    };

    const handleTogglePaid = async (userId: number, currentlyPaid: boolean) => {
        try {
            await toggleParticipantPayoutPaid(operation.id, userId, !currentlyPaid);
        } catch (err: any) {
            addToast('Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message });
        }
    };

    const [txFilter, setTxFilter] = useState<TxFilter>('all');
    const txEntries = useMemo(() => {
        const all = (operation.log || []).filter(l => l.entryType === 'UEC_DEPOSIT' || l.entryType === 'UEC_COST');
        const filtered = txFilter === 'deposits' ? all.filter(l => l.entryType === 'UEC_DEPOSIT')
            : txFilter === 'costs' ? all.filter(l => l.entryType === 'UEC_COST')
            : all;
        return filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [operation.log, txFilter]);

    const paidCount = operation.participants.filter(p => p.payoutPaidAt).length;
    const totalCount = operation.participants.length;

    const userById = useMemo(() => {
        const m = new Map<number, any>();
        (allUsers || []).forEach((u: any) => m.set(u.id, u));
        return m;
    }, [allUsers]);

    return (
        <div className="p-4 md:p-6 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <i className="fa-solid fa-coins text-slate-500"></i> Financial Ledger
                </h3>
                {editable && (
                    <div className="flex items-center gap-2">
                        <button onClick={onOpenAddUec} className="text-[10px] font-bold bg-emerald-500/10 text-emerald-300 px-3 py-1.5 rounded-sm border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors uppercase tracking-wider">
                            <i className="fa-solid fa-plus mr-1"></i> Deposit
                        </button>
                        <button onClick={onOpenAddCost} className="text-[10px] font-bold bg-red-500/10 text-red-300 px-3 py-1.5 rounded-sm border border-red-500/30 hover:bg-red-500/20 transition-colors uppercase tracking-wider">
                            <i className="fa-solid fa-minus mr-1"></i> Cost
                        </button>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricTile label="Total Pool" value={totalPool} suffix="aUEC" tone="emerald" icon="fa-arrow-trend-up" />
                <MetricTile label="Total Costs" value={totalCosts} suffix="aUEC" tone="red" icon="fa-arrow-trend-down" />
                <MetricTile label="Net" value={netPool} suffix="aUEC" tone={netPool >= 0 ? 'emerald' : 'red'} icon="fa-equals" />
                <MetricTile label="Paid Out" value={`${paidCount} / ${totalCount}`} tone="sky" icon="fa-check-double" />
            </div>

            <div className="bg-slate-900/40 border border-slate-700/50 rounded-xl">
                <div className="px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <i className="fa-solid fa-chart-pie text-sky-400/70 text-sm"></i>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Estimated Payouts</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Mode</span>
                        <select
                            value={operation.payoutMode}
                            onChange={e => handleModeChange(e.target.value as OperationPayoutMode)}
                            disabled={!editable}
                            className="bg-slate-950/60 border border-slate-700 text-[10px] uppercase tracking-wider font-bold text-slate-200 rounded-sm px-2 py-1 focus:outline-hidden focus:border-sky-500/40 disabled:opacity-50"
                        >
                            <option value="equal">Equal</option>
                            <option value="weighted">Time-Weighted</option>
                            <option value="custom">Custom</option>
                        </select>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-5 p-5">
                    <div className="md:col-span-2 space-y-2 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
                        {operation.participants.length === 0 ? (
                            <p className="text-xs text-slate-500 italic text-center py-6">No participants on the roster.</p>
                        ) : (
                            <div className="space-y-1.5">
                                <div className="grid grid-cols-12 gap-2 px-3 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                                    <div className="col-span-5">Participant</div>
                                    <div className="col-span-2 text-right">Share</div>
                                    <div className="col-span-3 text-right">Amount</div>
                                    <div className="col-span-2 text-right">Paid</div>
                                </div>
                                {operation.participants.map(p => {
                                    const row = payouts.find(r => r.userId === p.userId);
                                    const sharePercent = row?.sharePercent ?? 0;
                                    const amount = row?.amount ?? 0;
                                    const isPaid = !!p.payoutPaidAt;
                                    const paidByUser = p.payoutPaidBy ? userById.get(p.payoutPaidBy) : undefined;
                                    return (
                                        <div key={p.userId} className="grid grid-cols-12 gap-2 items-center px-3 py-2 bg-slate-950/40 border border-slate-800/60 rounded-lg">
                                            <div className="col-span-5 flex items-center gap-2 min-w-0">
                                                {p.user?.avatarUrl && <img src={p.user.avatarUrl} alt="" className="w-6 h-6 rounded-full shrink-0 object-cover" />}
                                                <span className="text-sm font-bold text-slate-200 truncate">{p.user?.name || 'Unknown'}</span>
                                            </div>
                                            <div className="col-span-2 text-right">
                                                {isCustom && editable ? (
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        min={0}
                                                        max={100}
                                                        value={draftSplits[p.userId] ?? ''}
                                                        onChange={e => setDraftSplits(prev => ({ ...prev, [p.userId]: e.target.value }))}
                                                        className="w-16 bg-slate-900/60 border border-slate-700 rounded-sm px-1.5 py-0.5 text-right text-xs font-mono text-white focus:outline-hidden focus:border-sky-500/40"
                                                    />
                                                ) : (
                                                    <span className="text-xs font-mono text-slate-300">{sharePercent.toFixed(1)}%</span>
                                                )}
                                            </div>
                                            <div className="col-span-3 text-right">
                                                <span className={`text-sm font-mono font-black ${amount >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                                                    {amount.toLocaleString()}
                                                </span>
                                            </div>
                                            <div className="col-span-2 text-right flex items-center justify-end gap-2">
                                                {isPaid && p.payoutPaidAt && (
                                                    <span className="text-[9px] text-slate-500" title={`Paid ${fmt(p.payoutPaidAt)}${paidByUser ? ` by ${paidByUser.name}` : ''}`}>
                                                        {fmt.date(p.payoutPaidAt)}
                                                    </span>
                                                )}
                                                <input
                                                    type="checkbox"
                                                    checked={isPaid}
                                                    onChange={() => handleTogglePaid(p.userId, isPaid)}
                                                    disabled={!editable}
                                                    className="w-4 h-4 accent-emerald-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                                                    title={concluded ? 'Operation concluded — payout record locked' : (isPaid ? 'Mark as unpaid' : 'Mark as paid')}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}

                                {isCustom && editable && (
                                    <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
                                        <span className={`text-[10px] font-mono uppercase tracking-widest ${draftValid ? 'text-emerald-300' : 'text-amber-300'}`}>
                                            Sum: {draftSum.toFixed(2)}% {!draftValid && '(must total 100%)'}
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <button onClick={handleResetEven} className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm bg-slate-800/60 border border-slate-700 text-slate-300 hover:bg-slate-800">
                                                Reset to Even
                                            </button>
                                            <button onClick={handleSaveSplits} disabled={!draftValid || savingSplits} className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm bg-sky-500/15 border border-sky-500/40 text-sky-200 hover:bg-sky-500/25 disabled:opacity-50">
                                                {savingSplits ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Splits'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="hidden md:block h-[280px] relative">
                        <PieChart data={pieData} title="Distribution" icon={<i className="fa-solid fa-chart-pie"></i>} unit="aUEC" />
                    </div>
                </div>
            </div>

            <div className="bg-slate-900/40 border border-slate-700/50 rounded-xl">
                <div className="px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <i className="fa-solid fa-receipt text-sky-400/70 text-sm"></i>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Transaction Log</span>
                    </div>
                    <div className="flex items-center gap-1 bg-slate-950/60 border border-slate-800 rounded-sm p-0.5">
                        {(['all', 'deposits', 'costs'] as TxFilter[]).map(f => (
                            <button key={f} onClick={() => setTxFilter(f)}
                                className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-wider rounded transition-colors ${
                                    txFilter === f ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-300'
                                }`}>
                                {f === 'all' ? 'All' : f === 'deposits' ? 'Deposits' : 'Costs'}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="p-3 max-h-[360px] overflow-y-auto custom-scrollbar space-y-1.5">
                    {txEntries.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-10 text-slate-600 italic opacity-60">
                            <i className="fa-solid fa-money-bill-wave text-2xl mb-2"></i>
                            <p className="text-xs">No transactions recorded.</p>
                        </div>
                    ) : (
                        txEntries.map(log => {
                            const isCost = log.entryType === 'UEC_COST';
                            const cat = log.costCategory ? COST_CATEGORY_LABEL[log.costCategory] : null;
                            const reasonText = isCost
                                ? (log.costDescription || (log.logEntry || '').split('. ').slice(-1)[0] || '')
                                : ((log.logEntry || '').split('Reason: ')[1] || 'Deposit');
                            return (
                                <div key={log.id} className="flex items-start gap-3 p-3 bg-slate-950/40 border border-slate-800/60 rounded-lg">
                                    <div className={`w-9 h-9 flex items-center justify-center rounded-sm shrink-0 ${isCost ? 'bg-red-500/10 text-red-300 border border-red-500/30' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'}`}>
                                        <i className={`fa-solid ${isCost ? 'fa-minus' : 'fa-plus'}`}></i>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`text-sm font-mono font-black ${isCost ? 'text-red-300' : 'text-emerald-300'}`}>
                                                {isCost ? '−' : '+'}{(log.uecAmount ?? 0).toLocaleString()}
                                            </span>
                                            {cat && (
                                                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-red-200 bg-red-500/10 border border-red-500/30 px-1.5 py-0.5 rounded-sm">
                                                    <i className={`fa-solid ${cat.icon} text-[8px]`}></i> {cat.label}
                                                </span>
                                            )}
                                        </div>
                                        {reasonText && <p className="text-xs text-slate-400 mt-0.5 wrap-break-word">{reasonText}</p>}
                                    </div>
                                    <span className="text-[9px] text-slate-500 font-mono whitespace-nowrap shrink-0">{fmt(log.createdAt)}</span>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};

const MetricTile: React.FC<{ label: string; value: number | string; suffix?: string; tone: 'emerald' | 'red' | 'sky'; icon: string }> = ({ label, value, suffix, tone, icon }) => {
    const palette = {
        emerald: { text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
        red:     { text: 'text-red-300',     bg: 'bg-red-500/10',     border: 'border-red-500/30' },
        sky:     { text: 'text-sky-300',     bg: 'bg-sky-500/10',     border: 'border-sky-500/30' },
    }[tone];
    return (
        <div className={`rounded-xl border ${palette.border} ${palette.bg} px-4 py-3 flex items-start gap-3`}>
            <div className={`h-8 w-8 rounded-lg border ${palette.border} flex items-center justify-center shrink-0`}>
                <i className={`fa-solid ${icon} ${palette.text} text-sm`}></i>
            </div>
            <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
                <p className={`text-lg font-black font-mono leading-tight ${palette.text}`}>
                    {typeof value === 'number' ? value.toLocaleString() : value}
                    {suffix && <span className="text-[10px] text-slate-500 ml-1">{suffix}</span>}
                </p>
            </div>
        </div>
    );
};

export default OpLedgerTab;
