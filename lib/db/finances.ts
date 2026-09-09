import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { clampListOffset } from '../pgrest.js';
import { log as baseLog } from '../log.js';
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

const log = baseLog.child({ module: 'db.finances' });

const DEFAULT_LEDGER_LIMIT = 200;
/** Rows per page for the paged UI list. */
const MAX_LEDGER_LIMIT = 500;
/** Rows an export may reach — the deliberate, permission-gated bulk path. */
const MAX_LEDGER_EXPORT_LIMIT = 5000;
/** Rows per export round-trip. */
const LEDGER_EXPORT_PAGE = MAX_LEDGER_LIMIT;

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

type LedgerFilterOpts = Omit<ListLedgerOpts, 'limit' | 'offset'>;
type LedgerRow = Parameters<typeof toLedgerEntry>[0];

/**
 * The one ledger page query. Shared by the list path and the CSV export so the
 * two can never drift on WHAT they select or filter, and so no caller can build
 * an unbounded ledger read — limit/offset arrive already clamped.
 */
function ledgerPageQuery(opts: LedgerFilterOpts, limit: number, offset: number) {
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

    // created_at alone is NOT a total order — a transfer writes both legs in one
    // statement, and imports/adjustments share a timestamp — so a window over it
    // is non-repeatable and offset paging can skip or repeat rows. id is the uuid
    // PK, so it breaks every tie: stable and repeatable, but arbitrary, NOT
    // chronological — don't read the second sort key as time.
    q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    if (offset > 0) q = q.range(offset, offset + limit - 1);
    return q;
}

export async function listLedgerEntries(
    opts: ListLedgerOpts = {},
): Promise<LedgerEntry[]> {
    const limit = Math.max(1, Math.min(MAX_LEDGER_LIMIT, opts.limit ?? DEFAULT_LEDGER_LIMIT));
    const offset = clampListOffset(opts.offset);

    const { data, error } = await ledgerPageQuery(opts, limit, offset);
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load ledger' });
    return (data || []).map(r => toLedgerEntry(r as unknown as LedgerRow));
}

/**
 * Single-entry fetch backing the finance:get_entry RPC — the realtime row-slice
 * path: FinancesView splices the returned row in place, and null means EVICT
 * (the entry was deleted/reversed away). So null must mean genuine absence
 * ONLY. EVERY error throws — 42P01 included — so a transient DB blip can never
 * masquerade as "this ledger entry was deleted"; the client's catch does a full
 * refetch instead.
 */
export async function getLedgerEntry(
    entryId: string,
): Promise<LedgerEntry | null> {
    const { data, error } = await supabase.from('treasury_ledger_entries')
        .select(LEDGER_SELECT)
        .eq('id', entryId)

        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to load ledger entry' });
    return data ? toLedgerEntry(data as unknown as LedgerRow) : null;
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

/**
 * The overview numbers come from ONE SQL aggregate, not from summing rows in Node.
 *
 * This is a correctness fix, not a performance one. Both former reads pulled whole result
 * sets across the wire and added them up here — and PostgREST enforces `db-max-rows`
 * SERVER-SIDE, returning a SHORT page with NO error. A busy org's balance was therefore
 * silently wrong with nothing anywhere to notice it, which is exactly what
 * tests/uncappableReadContracts.test.ts names about this function: "a short read is a wrong
 * balance presented as fact". That contract could never have caught it either — it asserts
 * the absence of a `.limit()`, and not having one does not make a read complete.
 *
 * The 30-day read also discarded its error outright (`const { data: recentConfirmed } = …`),
 * so any fault rendered the net as a confident 0.
 */
export async function getFinancesOverview(): Promise<FinancesOverview> {
    const [accounts, statsResult, recentEntries] = await Promise.all([
        listTreasuryAccounts(),
        supabase.rpc('finance_overview_stats'),
        listLedgerEntries({ limit: 10 }),
    ]);

    handleSupabaseError({ error: statsResult.error, message: 'Failed to load finance overview' });

    // THROW on a missing row rather than defaulting to {}. The sibling aggregates use
    // `(data && data[0]) || {}`, which in finance would render a fabricated ZERO TREASURY
    // from an empty-but-errorless RPC — a wrong balance presented as fact, which is the one
    // outcome this whole function is written to avoid. For quartermaster that shape produces a
    // wrong count; here it produces a wrong BALANCE.
    const row = (statsResult.data as Array<Record<string, unknown>> | null)?.[0];
    if (!row) throw new Error('Failed to load finance overview: the aggregate returned no row.');

    const n = (v: unknown): number => Number(v ?? 0);
    return {
        accounts,
        totalBalance: n(row.total_balance),
        pendingDepositsCount: n(row.pending_deposits_count),
        pendingDepositsAmount: n(row.pending_deposits_amount),
        pendingWithdrawalsCount: n(row.pending_withdrawals_count),
        pendingWithdrawalsAmount: n(row.pending_withdrawals_amount),
        thirtyDayNet: n(row.thirty_day_net),
        recentEntries,
    };
}

// ---------------------------------------------------------------------------
// CSV export — returns string payload; no file storage involved.
// ---------------------------------------------------------------------------

export interface ExportLedgerOpts extends ListLedgerOpts {
    // Same filter shape as listLedgerEntries, with two differences:
    //  - `limit` is a ceiling on the whole file (clamped to
    //    MAX_LEDGER_EXPORT_LIMIT); absent or non-positive means the full window.
    //  - `offset` is IGNORED. An export always starts at the newest matching
    //    entry so a stale client offset cannot silently behead the file.
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

/**
 * Ledger CSV. This used to delegate to listLedgerEntries with limit 5000, which
 * that function silently clamped to 500: an "audit export" of a 3000-entry
 * ledger was quietly the newest 500 rows, in a file with nothing saying so, and
 * the client toasted "Export ready" either way. It now pages to its own ceiling
 * and, when it does hit that ceiling, says so IN THE FILE — a server log the
 * auditor never sees does not fix "a partial export that looks complete".
 */
export async function exportLedgerCsv(
    opts: ExportLedgerOpts = {},
): Promise<string> {
    const requested = Math.trunc(Number(opts.limit));
    // Absent / non-numeric / non-positive means "the whole window", not a 1-row
    // file — the caller asked for an export, not for nothing.
    const ceiling = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_LEDGER_EXPORT_LIMIT)
        : MAX_LEDGER_EXPORT_LIMIT;

    const rows: LedgerRow[] = [];
    let truncated = false;
    let offset = 0;
    for (;;) {
        // Ask for ONE row past the ceiling so "exactly full" is distinguishable
        // from "there was more".
        const want = Math.min(LEDGER_EXPORT_PAGE, ceiling + 1 - rows.length);
        const { data, error } = await ledgerPageQuery(opts, want, offset);
        if (error && error.code === '42P01') break; // migration not run — nothing to export
        handleSupabaseError({ error, message: 'Failed to load ledger for export' });
        const page = (data || []) as unknown as LedgerRow[];
        if (page.length === 0) break;
        rows.push(...page);
        // Advance by rows RECEIVED, not requested: PostgREST enforces its own
        // server-side max-rows and returns a SHORT page with no error, so a short
        // page must not be mistaken for the end of the ledger.
        offset += page.length;
        if (rows.length > ceiling) { rows.splice(ceiling); truncated = true; break; }
    }
    const entries = rows.map(r => toLedgerEntry(r));

    const header = [
        'created_at', 'account_id', 'entry_type', 'amount', 'status',
        'memo', 'counterparty_name', 'counterparty_text',
        'created_by', 'approved_by', 'approved_at', 'notes', 'entry_id',
    ];
    const lines = [header.join(',')];
    for (const r of entries) {
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

    if (truncated) {
        const oldestIncluded = entries[entries.length - 1]?.createdAt ?? 'unknown';
        log.warn('ledger CSV export hit its row ceiling — the file is a partial (newest-first) window', { ceiling, exported: entries.length });
        // Full-width so the file stays rectangular through a spreadsheet import,
        // and LAST so rows 1..N remain a clean, parseable ledger.
        const notice = new Array(header.length).fill('');
        notice[0] = `** TRUNCATED — this export contains only the ${entries.length} most recent matching entries (ceiling ${ceiling}). Entries older than ${oldestIncluded} are NOT included. Re-export with a narrower fromDate/toDate range to obtain the remainder. **`;
        lines.push(notice.map(csvEscape).join(','));
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
