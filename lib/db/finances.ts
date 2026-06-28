import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { clampListOffset } from '../pgrest.js';
import { toTreasuryAccount, toLedgerEntry } from './mappers.js';
import type { Tables } from './rows.js';
import type {
    TreasuryAccount,
    LedgerEntry,
    LedgerEntryType,
    LedgerEntryStatus,
    FinancesOverview,
} from '../../types.js';

// Join selector used by ledger queries — pulls the counterparty + creator +
// approver user rows inline so the UI can render names/avatars without a
// follow-up lookup.
const LEDGER_SELECT = `
    id, account_id, entry_type, amount, status, memo, counterparty_user_id,
    counterparty_text, operation_id, related_inventory_id, related_entry_id,
    transfer_group_id, created_by_user_id, approved_by_user_id, approved_at,
    notes, created_at, updated_at,
    counterparty:users!treasury_ledger_entries_counterparty_user_id_fkey(id, name, avatar_url, rsi_handle),
    created_by:users!treasury_ledger_entries_created_by_user_id_fkey(id, name, avatar_url, rsi_handle),
    approved_by:users!treasury_ledger_entries_approved_by_user_id_fkey(id, name, avatar_url, rsi_handle)
`;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function listTreasuryAccounts(): Promise<TreasuryAccount[]> {
    const { data, error } = await supabase.from('treasury_accounts')
        .select('id, name, type, description, balance_cached, is_active, created_at, updated_at')

        .order('is_active', { ascending: false })
        .order('created_at', { ascending: true });
    if (error && error.code === '42P01') return []; // Migration not yet run
    handleSupabaseError({ error, message: 'Failed to load treasury accounts' });
    return (data || []).map(toTreasuryAccount);
}

export interface CreateAccountInput {
    name: string;
    type?: TreasuryAccount['type'];
    description?: string | null;
}

export async function createTreasuryAccount(
    input: CreateAccountInput,
): Promise<TreasuryAccount> {
    const name = (input.name || '').trim();
    if (!name) throw new Error('Account name is required.');

    const { data, error } = await supabase.from('treasury_accounts')
        .insert({
            name,
            type: input.type || 'general',
            description: input.description ?? null,
        })
        .select('id, name, type, description, balance_cached, is_active, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to create account' });
    if (!data) throw new Error('Account insert returned no row.');
    broadcastToOrg('finances:account_update', { accountId: data.id });
    return toTreasuryAccount(data);
}

export interface UpdateAccountInput {
    id: number;
    name?: string;
    type?: TreasuryAccount['type'];
    description?: string | null;
    isActive?: boolean;
}

export async function updateTreasuryAccount(
    input: UpdateAccountInput,
): Promise<TreasuryAccount> {
    const patch: Partial<Tables<'treasury_accounts'>> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.type !== undefined) patch.type = input.type;
    if (input.description !== undefined) patch.description = input.description;
    if (input.isActive !== undefined) patch.is_active = input.isActive;

    const { data, error } = await supabase.from('treasury_accounts')
        .update(patch)
        .eq('id', input.id)

        .select('id, name, type, description, balance_cached, is_active, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to update account' });
    if (!data) throw new Error('Account update returned no row.');
    broadcastToOrg('finances:account_update', { accountId: input.id });
    return toTreasuryAccount(data);
}

/**
 * Single-account fetch backing the finance:get_account RPC — the realtime
 * row-slice path: finances:account_update broadcasts carry the accountId and
 * FinancesView splices just that row instead of re-listing all accounts.
 * Returns null when absent (deleted → removed client-side). THROWS on query
 * errors so a transient DB blip can never masquerade as "account deleted".
 */
export async function getTreasuryAccount(accountId: number): Promise<TreasuryAccount | null> {
    const { data, error } = await supabase.from('treasury_accounts')
        .select('id, name, type, description, balance_cached, is_active, created_at, updated_at')
        .eq('id', accountId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get account slice' });
    return data ? toTreasuryAccount(data) : null;
}

// ---------------------------------------------------------------------------
// Ledger queries
// ---------------------------------------------------------------------------

export interface ListLedgerOpts {
    accountId?: number;
    entryType?: LedgerEntryType;
    status?: LedgerEntryStatus | 'open'; // 'open' = pending only
    counterpartyUserId?: number;
    fromDate?: string;   // ISO
    toDate?: string;     // ISO
    limit?: number;
    offset?: number;
}

export async function listLedgerEntries(
    opts: ListLedgerOpts = {},
): Promise<LedgerEntry[]> {
    let q = supabase.from('treasury_ledger_entries')
        .select(LEDGER_SELECT)
        ;

    if (opts.accountId) q = q.eq('account_id', opts.accountId);
    if (opts.entryType) q = q.eq('entry_type', opts.entryType);
    if (opts.status === 'open') q = q.eq('status', 'pending');
    else if (opts.status) q = q.eq('status', opts.status);
    if (opts.counterpartyUserId) q = q.eq('counterparty_user_id', opts.counterpartyUserId);
    if (opts.fromDate) q = q.gte('created_at', opts.fromDate);
    if (opts.toDate) q = q.lte('created_at', opts.toDate);

    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    q = q.order('created_at', { ascending: false }).limit(limit);
    const offset = clampListOffset(opts.offset);
    if (offset) q = q.range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load ledger' });
    return (data || []).map(r => toLedgerEntry(r as unknown as Parameters<typeof toLedgerEntry>[0]));
}

export async function getLedgerEntry(
    entryId: string,
): Promise<LedgerEntry | null> {
    const { data, error } = await supabase.from('treasury_ledger_entries')
        .select(LEDGER_SELECT)
        .eq('id', entryId)
        
        .maybeSingle();
    if (error && error.code === '42P01') return null;
    handleSupabaseError({ error, message: 'Failed to load ledger entry' });
    return data ? toLedgerEntry(data as unknown as Parameters<typeof toLedgerEntry>[0]) : null;
}

// ---------------------------------------------------------------------------
// Ledger writes
// ---------------------------------------------------------------------------

export interface SubmitDepositInput {
    accountId: number;
    amount: number;   // positive integer
    memo: string;     // required for dedup + verification
    counterpartyUserId?: number | null;
    counterpartyText?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

/**
 * Member submits a deposit claim. Row is status='pending' until an approver
 * confirms (matching the memo against the org alt-account in-game).
 * Returns the new entry. Partial unique index on (account_id, memo, amount)
 * prevents an accidental duplicate while one is still pending.
 */
export async function submitDeposit(
    createdByUserId: number,
    input: SubmitDepositInput,
): Promise<LedgerEntry> {
    const amount = Math.trunc(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Deposit amount must be a positive integer.');
    }
    const memo = (input.memo || '').trim();
    if (!memo) throw new Error('A memo/reference is required for deposits.');

    const { data, error } = await supabase.from('treasury_ledger_entries')
        .insert({
            account_id: input.accountId,
            entry_type: 'deposit',
            amount,
            status: 'pending',
            memo,
            counterparty_user_id: input.counterpartyUserId ?? createdByUserId,
            counterparty_text: input.counterpartyText ?? null,
            notes: input.notes ?? null,
            operation_id: input.operationId ?? null,
            created_by_user_id: createdByUserId,
        })
        .select(LEDGER_SELECT)
        .single();

    if (error && error.code === '23505') {
        throw new Error('You already have a pending deposit with this memo and amount. Wait for it to be reviewed or use a different reference.');
    }
    handleSupabaseError({ error, message: 'Failed to submit deposit' });
    if (!data) throw new Error('Deposit insert returned no row.');
    broadcastToOrg('finances:ledger_update', { entryId: data.id });
    return toLedgerEntry(data as unknown as Parameters<typeof toLedgerEntry>[0]);
}

export interface SubmitWithdrawalInput {
    accountId: number;
    amount: number;   // positive integer; will be stored as negative
    reason: string;
    counterpartyUserId?: number | null;
    counterpartyText?: string | null;
    operationId?: number | null;
}

/**
 * Member (or officer) requests a withdrawal. Row is stored with negative
 * amount and status='pending' until an approver with `finance:approve`
 * executes the transfer in-game and confirms.
 */
export async function submitWithdrawal(
    createdByUserId: number,
    input: SubmitWithdrawalInput,
): Promise<LedgerEntry> {
    const magnitude = Math.trunc(Number(input.amount));
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
        throw new Error('Withdrawal amount must be a positive integer.');
    }
    const reason = (input.reason || '').trim();
    if (!reason) throw new Error('A reason is required for withdrawal requests.');

    const { data, error } = await supabase.from('treasury_ledger_entries')
        .insert({
            account_id: input.accountId,
            entry_type: 'withdrawal',
            amount: -magnitude,
            status: 'pending',
            memo: null,
            counterparty_user_id: input.counterpartyUserId ?? createdByUserId,
            counterparty_text: input.counterpartyText ?? null,
            notes: reason,
            operation_id: input.operationId ?? null,
            created_by_user_id: createdByUserId,
        })
        .select(LEDGER_SELECT)
        .single();
    handleSupabaseError({ error, message: 'Failed to submit withdrawal request' });
    if (!data) throw new Error('Withdrawal insert returned no row.');
    broadcastToOrg('finances:ledger_update', { entryId: data.id });
    return toLedgerEntry(data as unknown as Parameters<typeof toLedgerEntry>[0]);
}

/**
 * Officer confirms a pending entry. Atomic via PL/pgSQL finance_approve_entry:
 * row-locks the account, conditional UPDATE idempotency-gates the status flip,
 * applies the delta. Returns true on success, false if the entry was already
 * processed (double-click, stale UI).
 */
export async function approveLedgerEntry(
    approverUserId: number,
    entryId: string,
): Promise<boolean> {
    // Verify the entry exists and is still pending before invoking the
    // PL/pgSQL approve function (which is idempotent on its own).
    // account_id rides the scope select so the balance-companion broadcast
    // below can carry it (clients then refetch ONE account, not the list).
    const { data: row, error: scopeErr } = await supabase.from('treasury_ledger_entries')
        .select('id, status, account_id')
        .eq('id', entryId)

        .maybeSingle();
    handleSupabaseError({ error: scopeErr, message: 'Failed to load entry' });
    if (!row) throw new Error('Entry not found.');
    if (row.status !== 'pending') return false;

    const { data, error } = await supabase.rpc('finance_approve_entry', {
        p_entry_id: entryId,
        p_approver_id: approverUserId,
    });
    handleSupabaseError({ error, message: 'Failed to approve entry' });
    const affected = Number(data ?? 0);
    broadcastToOrg('finances:ledger_update', { entryId });
    broadcastToOrg('finances:account_update', { accountId: row.account_id });
    return affected > 0;
}

export async function rejectLedgerEntry(
    approverUserId: number,
    entryId: string,
    reason: string,
): Promise<boolean> {
    const { data: row, error: scopeErr } = await supabase.from('treasury_ledger_entries')
        .select('id, status')
        .eq('id', entryId)
        
        .maybeSingle();
    handleSupabaseError({ error: scopeErr, message: 'Failed to load entry' });
    if (!row) throw new Error('Entry not found.');
    if (row.status !== 'pending') return false;

    const { data, error } = await supabase.rpc('finance_reject_entry', {
        p_entry_id: entryId,
        p_approver_id: approverUserId,
        p_reason: reason || '',
    });
    handleSupabaseError({ error, message: 'Failed to reject entry' });
    broadcastToOrg('finances:ledger_update', { entryId });
    return Number(data ?? 0) > 0;
}

/**
 * Reverse a previously-confirmed entry. Creates a compensating adjustment
 * row (opposite sign, immediately confirmed) and flips the original to
 * 'reversed'. Tenant scope enforced before invoking the PL/pgSQL function.
 * Returns the new adjustment entry's id.
 */
export async function reverseLedgerEntry(
    actorUserId: number,
    entryId: string,
    reason: string,
): Promise<string> {
    const { data: row, error: scopeErr } = await supabase.from('treasury_ledger_entries')
        .select('id, status, account_id')
        .eq('id', entryId)

        .maybeSingle();
    handleSupabaseError({ error: scopeErr, message: 'Failed to load entry' });
    if (!row) throw new Error('Entry not found.');
    if (row.status !== 'confirmed') throw new Error('Only confirmed entries may be reversed.');

    const { data, error } = await supabase.rpc('finance_reverse_entry', {
        p_entry_id: entryId,
        p_actor_id: actorUserId,
        p_reason: reason || '',
    });
    handleSupabaseError({ error, message: 'Failed to reverse entry' });
    // TWO ledger rows changed: the original (flipped to 'reversed') and the
    // new compensating adjustment returned by the proc — carry both ids.
    broadcastToOrg('finances:ledger_update', { entryIds: [entryId, String(data)] });
    broadcastToOrg('finances:account_update', { accountId: row.account_id });
    return String(data);
}

export interface AdjustmentInput {
    accountId: number;
    amount: number;    // signed
    reason: string;
    counterpartyText?: string | null;
}

/**
 * Officer-written direct entry that skips the pending/confirm flow. Used
 * for corrections, one-off payouts, or seeding initial balances on an
 * existing real-world account. Applied immediately via the same approve
 * function path to keep balance_cached in lockstep.
 */
export async function recordAdjustment(
    actorUserId: number,
    input: AdjustmentInput,
): Promise<LedgerEntry> {
    const amount = Math.trunc(Number(input.amount));
    if (!Number.isFinite(amount) || amount === 0) {
        throw new Error('Adjustment amount must be a non-zero integer.');
    }
    const reason = (input.reason || '').trim();
    if (!reason) throw new Error('A reason is required for adjustments.');

    // Insert as pending then approve, so the balance mutation happens
    // inside the same locked-transaction path as normal deposits.
    const { data: pending, error: insErr } = await supabase.from('treasury_ledger_entries')
        .insert({
            account_id: input.accountId,
            entry_type: 'adjustment',
            amount,
            status: 'pending',
            notes: reason,
            counterparty_text: input.counterpartyText ?? null,
            created_by_user_id: actorUserId,
        })
        .select('id')
        .single();
    handleSupabaseError({ error: insErr, message: 'Failed to create adjustment' });
    if (!pending) throw new Error('Adjustment insert returned no row.');

    const { error: approveErr } = await supabase.rpc('finance_approve_entry', {
        p_entry_id: pending.id,
        p_approver_id: actorUserId,
    });
    handleSupabaseError({ error: approveErr, message: 'Failed to apply adjustment' });

    const final = await getLedgerEntry(pending.id);
    if (!final) throw new Error('Adjustment disappeared after creation.');
    broadcastToOrg('finances:ledger_update', { entryId: pending.id });
    broadcastToOrg('finances:account_update', { accountId: input.accountId });
    return final;
}

// ---------------------------------------------------------------------------
// Overview — powers the first tab
// ---------------------------------------------------------------------------

export async function getFinancesOverview(): Promise<FinancesOverview> {
    const accounts = await listTreasuryAccounts();
    const totalBalance = accounts
        .filter((a) => a.isActive)
        .reduce((sum, a) => sum + a.balanceCached, 0);

    // Pending aggregates in a single query for efficiency
    const { data: pendingRows, error: pErr } = await supabase.from('treasury_ledger_entries')
        .select('entry_type, amount')
        
        .eq('status', 'pending');
    if (pErr && pErr.code !== '42P01') handleSupabaseError({ error: pErr, message: 'Failed to load pending totals' });

    let pendingDepositsCount = 0;
    let pendingDepositsAmount = 0;
    let pendingWithdrawalsCount = 0;
    let pendingWithdrawalsAmount = 0;
    for (const r of pendingRows || []) {
        const amt = Math.abs(Number(r.amount));
        if (r.entry_type === 'deposit') {
            pendingDepositsCount += 1;
            pendingDepositsAmount += amt;
        } else if (r.entry_type === 'withdrawal') {
            pendingWithdrawalsCount += 1;
            pendingWithdrawalsAmount += amt;
        }
    }

    // 30-day net (confirmed only)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentConfirmed } = await supabase.from('treasury_ledger_entries')
        .select('amount')
        
        .eq('status', 'confirmed')
        .gte('created_at', thirtyDaysAgo);
    const thirtyDayNet = (recentConfirmed || []).reduce((s: number, r: { amount: number }) => s + Number(r.amount), 0);

    const recentEntries = await listLedgerEntries({ limit: 10 });

    return {
        accounts,
        totalBalance,
        pendingDepositsCount,
        pendingDepositsAmount,
        pendingWithdrawalsCount,
        pendingWithdrawalsAmount,
        thirtyDayNet,
        recentEntries,
    };
}

// ---------------------------------------------------------------------------
// CSV export — returns string payload; no file storage involved.
// ---------------------------------------------------------------------------

export interface ExportLedgerOpts extends ListLedgerOpts {
    // Same filter shape as listLedgerEntries; exports up to 5000 rows.
}

/**
 * CSV cell escaper with spreadsheet formula-injection neutralization.
 * Exported so the regression test can pin the behaviour directly.
 *
 * Two concerns, applied in order:
 *  1. Formula injection (OWASP CSV-injection): a cell beginning with = + - @
 *     (or a leading TAB/CR that some apps strip before evaluating the next
 *     char) is auto-evaluated as a formula by Excel/LibreOffice/Sheets.
 *     memo/counterparty_text/notes are attacker-controlled and stored verbatim
 *     (submitDeposit/submitWithdrawal/recordAdjustment), so neutralize at the
 *     output boundary by prefixing a single quote — apps then render the cell
 *     as literal text and never execute it.
 *  2. Quote-wrapping: preserve the existing RFC-4180 escaping for cells that
 *     contain a delimiter/quote/newline.
 */
export function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    let str = String(value);
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
}

export async function exportLedgerCsv(
    opts: ExportLedgerOpts = {},
): Promise<string> {
    const rows = await listLedgerEntries({ ...opts, limit: 5000 });
    const header = [
        'created_at', 'account_id', 'entry_type', 'amount', 'status',
        'memo', 'counterparty_name', 'counterparty_text',
        'created_by', 'approved_by', 'approved_at', 'notes', 'entry_id',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
        lines.push([
            r.createdAt,
            r.accountId,
            r.entryType,
            r.amount,
            r.status,
            r.memo,
            r.counterparty?.name ?? '',
            r.counterpartyText,
            r.createdBy?.name ?? r.createdByUserId,
            r.approvedBy?.name ?? '',
            r.approvedAt,
            r.notes,
            r.id,
        ].map(csvEscape).join(','));
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reconciliation — on-demand drift detector. Safe to call nightly.
// ---------------------------------------------------------------------------

export interface BalanceDrift {
    accountId: number;
    cached: number;
    computed: number;
    delta: number;
}

export async function reconcileBalances(): Promise<BalanceDrift[]> {
    const { data, error } = await supabase.rpc('finance_reconcile_balances');
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to reconcile balances' });
    return (data || []).map((row: { account_id: number; cached: number; computed: number; delta: number }) => ({
        accountId: row.account_id,
        cached: Number(row.cached),
        computed: Number(row.computed),
        delta: Number(row.delta),
    }));
}
