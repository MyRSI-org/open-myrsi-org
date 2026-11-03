import React from 'react';
import type { LedgerEntry, TreasuryAccount, LedgerEntryStatus, LedgerEntryType } from '../../../types';
import { ACCENTS, AccentKey } from '../../shared/ui/accents';
import { useFormatDate } from '../../../contexts/AuthContext';
import { formatRelativeTime } from '../../../lib/time';

const TYPE_ACCENT: Record<LedgerEntryType, AccentKey> = {
    deposit: 'emerald',
    withdrawal: 'rose',
    transfer: 'sky',
    payout: 'amber',
    adjustment: 'slate',
};

const TYPE_ICON: Record<LedgerEntryType, string> = {
    deposit: 'fa-arrow-down-to-bracket',
    withdrawal: 'fa-arrow-up-from-bracket',
    transfer: 'fa-right-left',
    payout: 'fa-hand-holding-dollar',
    adjustment: 'fa-wrench',
};

const STATUS_STYLE: Record<LedgerEntryStatus, string> = {
    pending:   'bg-amber-500/10 text-amber-300 border-amber-500/30',
    confirmed: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    rejected:  'bg-rose-500/10 text-rose-300 border-rose-500/30',
    reversed:  'bg-slate-500/10 text-slate-300 border-slate-500/30',
};

interface Props {
    entry: LedgerEntry;
    accounts?: TreasuryAccount[];
    onApprove?: () => void;
    onReject?: () => void;
    onReverse?: () => void;
    dense?: boolean;
}

export default function LedgerRow({ entry, accounts, onApprove, onReject, onReverse, dense }: Props) {
    const fmt = useFormatDate();
    const formatRelative = (iso: string): string => formatRelativeTime(iso, fmt.prefs);
    const accent = TYPE_ACCENT[entry.entryType];
    const a = ACCENTS[accent];
    const account = accounts?.find((acc) => acc.id === entry.accountId);

    const who = entry.counterparty?.name
        || entry.counterpartyText
        || entry.createdBy?.name
        || 'Unknown';
    const magnitude = Math.abs(entry.amount);
    const sign = entry.amount > 0 ? '+' : entry.amount < 0 ? '−' : '';
    const reversed = entry.status === 'reversed';

    return (
        <div className={`relative rounded-lg border ${a.border} bg-slate-900/40 flex items-stretch overflow-hidden ${reversed ? 'opacity-50' : ''}`}>
            <div className={`w-1 shrink-0 ${a.dot}`} aria-hidden />
            <div className={`flex-1 min-w-0 ${dense ? 'px-3 py-2.5' : 'px-4 py-3'} flex flex-col sm:flex-row sm:items-center gap-3`}>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`w-9 h-9 rounded-lg ${a.bg} flex items-center justify-center shrink-0`}>
                        <i className={`fa-solid ${TYPE_ICON[entry.entryType]} ${a.text}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${a.text}`}>{entry.entryType}</span>
                            <span className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-sm border ${STATUS_STYLE[entry.status]}`}>
                                {entry.status}
                            </span>
                            {account && (
                                <span className="text-[10px] font-mono text-slate-500 truncate">· {account.name}</span>
                            )}
                        </div>
                        <div className="text-sm text-white mt-0.5 truncate">
                            <span className="font-bold">{who}</span>
                            {entry.memo && <span className="text-slate-400"> · memo: <span className="font-mono text-amber-200/80">{entry.memo}</span></span>}
                        </div>
                        {entry.notes && <div className="text-[11px] text-slate-500 mt-0.5 truncate">{entry.notes}</div>}
                        {/* Approver-only: the server includes rejectionReason solely for finance:approve holders. */}
                        {entry.rejectionReason && (
                            <div className="text-[11px] text-rose-300/80 mt-0.5 truncate" title={entry.rejectionReason}>
                                <span className="font-bold uppercase tracking-widest text-[10px]">Rejected:</span> {entry.rejectionReason}
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-4 justify-between sm:justify-end shrink-0">
                    <div className="text-right">
                        <div className={`text-base font-black font-mono ${entry.amount > 0 ? 'text-emerald-300' : entry.amount < 0 ? 'text-rose-300' : 'text-slate-300'}`}>
                            {sign}{magnitude.toLocaleString()} <span className="text-[10px] text-slate-500 font-normal">aUEC</span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">{formatRelative(entry.createdAt)}</div>
                    </div>
                    {(onApprove || onReject || onReverse) && (
                        <div className="flex items-center gap-1.5">
                            {onApprove && (
                                <button
                                    onClick={onApprove}
                                    className="px-2.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 rounded-sm border border-emerald-500/40 text-[10px] font-bold uppercase tracking-widest"
                                >
                                    Confirm
                                </button>
                            )}
                            {onReject && (
                                <button
                                    onClick={onReject}
                                    className="px-2.5 py-1.5 bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 rounded-sm border border-rose-500/40 text-[10px] font-bold uppercase tracking-widest"
                                >
                                    Reject
                                </button>
                            )}
                            {onReverse && (
                                <button
                                    onClick={onReverse}
                                    className="px-2.5 py-1.5 bg-slate-700/40 hover:bg-slate-700/60 text-slate-300 rounded-sm border border-slate-600/50 text-[10px] font-bold uppercase tracking-widest"
                                >
                                    Reverse
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
