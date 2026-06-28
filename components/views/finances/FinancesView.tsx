import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useAuth } from '../../../contexts/AuthContext';

import { mergeRowSlice, byCreatedAtDesc } from '../../../lib/sliceMerge';
import HeroShell from '../../shared/ui/HeroShell';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import type { TreasuryAccount, LedgerEntry, FinancesOverview } from '../../../types';
import FinancesOverviewTab from './FinancesOverviewTab';
import FinancesLedgerTab from './FinancesLedgerTab';
import FinancesRequestsTab from './FinancesRequestsTab';
import FinancesAccountsTab from './FinancesAccountsTab';
import SubmitDepositModal from './SubmitDepositModal';
import SubmitWithdrawalModal from './SubmitWithdrawalModal';
import RecordAdjustmentModal from './RecordAdjustmentModal';
import CreateAccountModal from './CreateAccountModal';
import { useNotification } from '../../../contexts/NotificationContext';

type Tab = 'overview' | 'ledger' | 'requests' | 'accounts';

const TABS: readonly { key: Tab; label: string; icon: string; permission?: string }[] = [
    { key: 'overview', label: 'Overview', icon: 'fa-gauge-high' },
    { key: 'ledger',   label: 'Ledger',   icon: 'fa-scroll' },
    { key: 'requests', label: 'Requests', icon: 'fa-inbox', permission: 'finance:approve' },
    { key: 'accounts', label: 'Accounts', icon: 'fa-vault', permission: 'finance:manage' },
];

export default function FinancesView() {
    const { rpcAction } = useData();
    const { hasPermission, currentUser } = useAuth();
    const { addToast } = useNotification();

    const [tab, setTab] = useState<Tab>('overview');
    const [overview, setOverview] = useState<FinancesOverview | null>(null);
    const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
    const [entries, setEntries] = useState<LedgerEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

    const [depositOpen, setDepositOpen] = useState(false);
    const [withdrawOpen, setWithdrawOpen] = useState(false);
    const [adjustmentOpen, setAdjustmentOpen] = useState(false);
    const [createAccountOpen, setCreateAccountOpen] = useState(false);

    const canView     = hasPermission('finance:view');
    const canDeposit  = hasPermission('finance:deposit');
    const canWithdraw = hasPermission('finance:withdraw_request');
    const canApprove  = hasPermission('finance:approve');
    const canManage   = hasPermission('finance:manage');

    const visibleTabs = useMemo(() => TABS.filter((t) => !t.permission || hasPermission(t.permission)), [hasPermission]);

    // Pure fetch: guards on canView, then every setState runs after the awaited
    // RPCs (or in finally). No synchronous setIsLoading(true) here, so this is
    // safe to run directly from the mount effect. isLoading already initialises
    // to true, so the spinner shows on mount with no extra render pass.
    const fetchFinances = useCallback(async () => {
        if (!canView) return;
        try {
            const [ov, accs, led] = await Promise.all([
                rpcAction('finance:get_overview', {}),
                rpcAction('finance:list_accounts', {}),
                rpcAction('finance:list_ledger', { limit: 200 }),
            ]);
            setOverview(ov);
            setAccounts(accs || []);
            setEntries(led || []);
        } catch (err: any) {
            addToast('Failed to load finances', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', {
                description: err?.message || 'Check your permissions or reload the page.',
            });
        } finally {
            setIsLoading(false);
        }
    }, [rpcAction, canView, addToast]);

    // Imperative refresh for handlers (modal submits, tab refresh, realtime
    // fallback): flips the spinner back on before refetching. Called from event
    // handlers / other effects callbacks only, so the synchronous setIsLoading(true)
    // here is not a set-in-effect. Guard order matches the original: when the
    // viewer can't read finances we bail before touching the loading flag.
    const refresh = useCallback(async () => {
        if (!canView) return;
        setIsLoading(true);
        await fetchFinances();
    }, [canView, fetchFinances]);

    // Mount-time data fetch. Awaiting fetchFinances inside an async IIFE keeps
    // every state update on the post-await path the rule recognises (no
    // synchronous set-in-effect) — same timing as a bare call.
    useEffect(() => { void (async () => { await fetchFinances(); })(); }, [fetchFinances]);

    // The overview tab is an aggregate (balances + pending counts + 30-day
    // net) — recompute-only; refreshed alongside every row splice below.
    const refreshOverview = useCallback(async () => {
        if (!canView) return;
        try {
            setOverview(await rpcAction('finance:get_overview', {}));
        } catch {
            // Non-fatal: the next full refresh self-heals the aggregate.
        }
    }, [rpcAction, canView]);

    // Listen for `finances:*` broadcasts fired by the db layer on every mutation;
    // keeps the UI live without postgres_changes (which would need RLS open to all
    // authenticated users). When an emit carries entryId(s)/accountId we fetch and
    // splice ONLY the changed row(s) plus the overview aggregate (null = row gone →
    // removed); id-less payloads and slice-fetch errors fall back to a full refresh.
    // Accepted race (no generation guard here): a local mutation's own refresh() can
    // resolve after the splice and briefly re-apply the old list; self-heals on the
    // next broadcast.
    useEffect(() => {
        const onLedgerUpdate = async (payload: { payload?: { entryId?: string; entryIds?: string[] } }) => {
            const p = payload.payload ?? {};
            const ids = Array.isArray(p.entryIds)
                ? p.entryIds.filter((s): s is string => typeof s === 'string')
                : (typeof p.entryId === 'string' && p.entryId ? [p.entryId] : []);
            if (ids.length === 0) { void refresh(); return; }
            try {
                const fetched: (LedgerEntry | null)[] = await Promise.all(
                    ids.map((entryId) => rpcAction('finance:get_entry', { entryId })),
                );
                setEntries(prev => {
                    let next = prev;
                    fetched.forEach((entry, i) => {
                        next = mergeRowSlice(next, entry ?? null, ids[i], byCreatedAtDesc);
                    });
                    return next;
                });
                void refreshOverview();
            } catch (err) {
                console.error('finance entry slice failed; falling back to full refresh:', err);
                void refresh();
            }
        };
        const onAccountUpdate = async (payload: { payload?: { accountId?: number } }) => {
            const accountId = payload.payload?.accountId;
            if (typeof accountId !== 'number') { void refresh(); return; }
            try {
                const account: TreasuryAccount | null = await rpcAction('finance:get_account', { accountId });
                setAccounts(prev => mergeRowSlice(prev, account ?? null, accountId));
                void refreshOverview();
            } catch (err) {
                console.error('finance account slice failed; falling back to full refresh:', err);
                void refresh();
            }
        };
        // Don't wire handlers when the viewer can't read finances — the locked
        // view otherwise fires a denied RPC on every org mutation.
        if (!canView) return;
        // The finances:* broadcasts arrive via DataCore's single PRIVATE
        // 'db-changes' channel and are relayed as window CustomEvents (handler
        // attachment is finance:view-gated there). Never subscribe to the
        // 'db-changes' topic from a view: supabase-js dedupes channels by topic,
        // so a view-owned channel object IS DataCore's channel and removeChannel()
        // on unmount would kill all org realtime app-wide.
        const ledger = (e: Event) => { void onLedgerUpdate({ payload: (e as CustomEvent).detail }); };
        const account = (e: Event) => { void onAccountUpdate({ payload: (e as CustomEvent).detail }); };
        const reset = () => { void refresh(); }; // post-admin-reset: module is empty — full refresh
        window.addEventListener('app:realtime:finances:ledger_update', ledger);
        window.addEventListener('app:realtime:finances:account_update', account);
        window.addEventListener('app:realtime:finance:reset', reset);
        return () => {
            window.removeEventListener('app:realtime:finances:ledger_update', ledger);
            window.removeEventListener('app:realtime:finances:account_update', account);
            window.removeEventListener('app:realtime:finance:reset', reset);
        };
    }, [refresh, refreshOverview, rpcAction, canView]);

    // Effective ledger filter: until the user explicitly picks an account
    // (selectedAccountId !== null), default to the first active account (or the
    // first account). Derived during render instead of via a set-state effect so
    // there's no extra render pass; once the user selects, that choice wins.
    const effectiveSelectedAccountId = useMemo(() => {
        if (selectedAccountId !== null) return selectedAccountId;
        if (accounts.length === 0) return null;
        return (accounts.find((a) => a.isActive) || accounts[0]).id;
    }, [selectedAccountId, accounts]);

    if (!canView) {
        return (
            <div className="p-8">
                <EmptyState
                    icon="fa-lock"
                    accent="amber"
                    heading="You don't have access to Finances"
                    description="Ask an admin to grant you the finance:view permission."
                />
            </div>
        );
    }

    const firstRun = !isLoading && accounts.length === 0;

    return (
        <div className="h-full flex flex-col overflow-hidden bg-slate-950 text-white animate-fade-in">
            <HeroShell
                chipLabel="MODULE · FINANCES"
                chipIcon="fa-vault"
                chipAccent="amber"
                title="Org Treasury"
                subtitle="Track your org's in-game bank alt-account. Deposits are claimed by members, confirmed by officers against the real alt. Every deposit, withdrawal, adjustment and reversal is audited."
                actions={<>
                    {canManage && accounts.length > 0 && (
                        <HeroActionButton onClick={() => setAdjustmentOpen(true)} accent="slate" icon="fa-wrench">
                            Adjustment
                        </HeroActionButton>
                    )}
                    {canWithdraw && accounts.length > 0 && (
                        <HeroActionButton onClick={() => setWithdrawOpen(true)} accent="rose" icon="fa-minus">
                            Withdraw
                        </HeroActionButton>
                    )}
                    {canDeposit && accounts.length > 0 && (
                        <HeroActionButton onClick={() => setDepositOpen(true)} accent="emerald" icon="fa-plus">
                            Deposit
                        </HeroActionButton>
                    )}
                </>}
                tabs={!firstRun ? visibleTabs.map((t) => {
                    const active = tab === t.key;
                    return (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap flex items-center gap-2 ${
                                active ? 'border-amber-400 text-amber-300' : 'border-transparent text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            <i className={`fa-solid ${t.icon}`} /> {t.label}
                            {t.key === 'requests' && overview && (overview.pendingDepositsCount + overview.pendingWithdrawalsCount) > 0 && (
                                <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-bold px-1.5">
                                    {overview.pendingDepositsCount + overview.pendingWithdrawalsCount}
                                </span>
                            )}
                        </button>
                    );
                }) : undefined}
            />

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
                {isLoading && (
                    <div className="flex items-center justify-center py-20">
                        <i className="fa-solid fa-circle-notch fa-spin text-amber-400 text-3xl" aria-hidden />
                    </div>
                )}

                {!isLoading && firstRun && (
                    <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-10">
                        <EmptyState
                            icon="fa-vault"
                            accent="amber"
                            heading="Create your first treasury account"
                            description="Most orgs use one 'General' account tied to their in-game ORGNAME_BANK alt. You can add reserve or project accounts later."
                            action={canManage ? (
                                <button
                                    onClick={() => setCreateAccountOpen(true)}
                                    className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white px-5 py-2.5 rounded-lg font-bold uppercase tracking-widest text-xs transition-all"
                                >
                                    <i className="fa-solid fa-plus" /> Create Account
                                </button>
                            ) : (
                                <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">
                                    Ask an admin with finance:manage to create the first account.
                                </p>
                            )}
                        />
                    </div>
                )}

                {!isLoading && !firstRun && tab === 'overview' && overview && (
                    <FinancesOverviewTab
                        overview={overview}
                        accounts={accounts}
                        onOpenLedger={() => setTab('ledger')}
                        onOpenRequests={() => setTab('requests')}
                    />
                )}
                {!isLoading && !firstRun && tab === 'ledger' && (
                    <FinancesLedgerTab
                        accounts={accounts}
                        selectedAccountId={effectiveSelectedAccountId}
                        onSelectAccount={setSelectedAccountId}
                        entries={entries}
                        canManage={canManage}
                        onRefresh={refresh}
                    />
                )}
                {!isLoading && !firstRun && tab === 'requests' && canApprove && (
                    <FinancesRequestsTab entries={entries} onRefresh={refresh} />
                )}
                {!isLoading && !firstRun && tab === 'accounts' && canManage && (
                    <FinancesAccountsTab
                        accounts={accounts}
                        onCreate={() => setCreateAccountOpen(true)}
                        onRefresh={refresh}
                    />
                )}
                </div>
            </div>

            {depositOpen && (
                <SubmitDepositModal
                    accounts={accounts.filter((a) => a.isActive)}
                    onClose={() => setDepositOpen(false)}
                    onSubmitted={() => { setDepositOpen(false); refresh(); }}
                />
            )}
            {withdrawOpen && (
                <SubmitWithdrawalModal
                    accounts={accounts.filter((a) => a.isActive)}
                    onClose={() => setWithdrawOpen(false)}
                    onSubmitted={() => { setWithdrawOpen(false); refresh(); }}
                />
            )}
            {adjustmentOpen && (
                <RecordAdjustmentModal
                    accounts={accounts.filter((a) => a.isActive)}
                    onClose={() => setAdjustmentOpen(false)}
                    onSubmitted={() => { setAdjustmentOpen(false); refresh(); }}
                />
            )}
            {createAccountOpen && (
                <CreateAccountModal
                    onClose={() => setCreateAccountOpen(false)}
                    onSubmitted={() => { setCreateAccountOpen(false); refresh(); }}
                />
            )}
        </div>
    );
}
