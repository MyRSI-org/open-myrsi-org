import * as db from '../../lib/db.js';
import { sendPushToPermission } from '../../lib/push.js';
import { log as baseLog } from '../../lib/log.js';
import type {
    LedgerEntryType,
    LedgerEntryStatus,
    TreasuryAccountType,
} from '../../types.js';

const log = baseLog.child({ module: 'actions.finances' });

// ---------------------------------------------------------------------------
// Payload shapes. Every handler receives the request body with the actor-id
// fields (userId) injected server-side by services.ts.
// Account ids are integers; ledger entry ids are UUID strings.
// ---------------------------------------------------------------------------

interface CreateAccountPayload {
    name: string;
    type?: TreasuryAccountType;
    description?: string | null;
}

interface UpdateAccountPayload {
    accountId: number;
    name?: string;
    type?: TreasuryAccountType;
    description?: string | null;
    isActive?: boolean;
}

interface ArchiveAccountPayload {
    accountId: number;
}

interface ListLedgerPayload {
    accountId?: number;
    entryType?: LedgerEntryType;
    status?: LedgerEntryStatus | 'open';
    counterpartyUserId?: number;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
}

interface GetEntryPayload {
    entryId: string;
}

interface SubmitDepositPayload {
    userId: number;
    accountId: number;
    amount: number;
    memo: string;
    counterpartyUserId?: number | null;
    counterpartyText?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

interface SubmitWithdrawalPayload {
    userId: number;
    accountId: number;
    amount: number;
    reason: string;
    counterpartyUserId?: number | null;
    counterpartyText?: string | null;
    operationId?: number | null;
}

interface ApproveEntryPayload {
    userId: number;
    entryId: string;
}

interface RejectEntryPayload {
    userId: number;
    entryId: string;
    reason?: string;
}

interface ReverseEntryPayload {
    userId: number;
    entryId: string;
    reason?: string;
}

interface RecordAdjustmentPayload {
    userId: number;
    accountId: number;
    amount: number;
    reason: string;
    counterpartyText?: string | null;
}

// finance:export_csv spreads its filter fields into the ledger-filter opts.
type ExportCsvPayload = ListLedgerPayload;

/**
 * Finances RPC action handlers. Permission checks are enforced in services.ts
 * before these handlers are dispatched.
 */
export const financesActions = {
    // --- ACCOUNTS ---
    'finance:list_accounts': async () =>
        db.listTreasuryAccounts(),

    'finance:create_account': async ({ name, type, description }: CreateAccountPayload) =>
        db.createTreasuryAccount({ name, type, description }),

    'finance:update_account': async ({ accountId, name, type, description, isActive }: UpdateAccountPayload) =>
        db.updateTreasuryAccount({ id: accountId, name, type, description, isActive }),

    'finance:archive_account': async ({ accountId }: ArchiveAccountPayload) =>
        db.updateTreasuryAccount({ id: accountId, isActive: false }),

    // Realtime row-slice fetch: finances:account_update broadcasts carry the
    // accountId; FinancesView splices just that row instead of re-listing.
    'finance:get_account': async ({ accountId }: ArchiveAccountPayload) =>
        db.getTreasuryAccount(accountId),

    // --- LEDGER ---
    'finance:list_ledger': async ({ accountId, entryType, status, counterpartyUserId, fromDate, toDate, limit, offset }: ListLedgerPayload) =>
        db.listLedgerEntries({
            accountId, entryType, status, counterpartyUserId, fromDate, toDate, limit, offset,
        }),

    'finance:get_entry': async ({ entryId }: GetEntryPayload) =>
        db.getLedgerEntry(entryId),

    'finance:submit_deposit': async ({
        userId, accountId, amount, memo, counterpartyUserId, counterpartyText, notes, operationId,
    }: SubmitDepositPayload) => {
        const entry = await db.submitDeposit(userId, {
            accountId, amount, memo, counterpartyUserId, counterpartyText, notes, operationId,
        });
        // Fire-and-forget — never block the caller on push failure.
        sendPushToPermission('finance:approve', {
            title: 'Deposit pending review',
            body: `${amount.toLocaleString()} aUEC awaiting confirmation · memo: ${memo}`,
            tag: `finance-deposit-${entry.id}`,
            data: { view: 'finances', tab: 'requests', entryId: entry.id },
        }).catch((err) => log.warn('deposit push failed', { entryId: entry.id, err }));
        return entry;
    },

    'finance:submit_withdrawal': async ({
        userId, accountId, amount, reason, counterpartyUserId, counterpartyText, operationId,
    }: SubmitWithdrawalPayload) => {
        const entry = await db.submitWithdrawal(userId, {
            accountId, amount, reason, counterpartyUserId, counterpartyText, operationId,
        });
        sendPushToPermission('finance:approve', {
            title: 'Withdrawal request',
            body: `${amount.toLocaleString()} aUEC requested · ${reason.slice(0, 60)}`,
            tag: `finance-withdrawal-${entry.id}`,
            data: { view: 'finances', tab: 'requests', entryId: entry.id },
        }).catch((err) => log.warn('withdrawal push failed', { entryId: entry.id, err }));
        return entry;
    },

    'finance:approve_entry': async ({ userId, entryId }: ApproveEntryPayload) => {
        const ok = await db.approveLedgerEntry(userId, entryId);
        if (ok) {
            const entry = await db.getLedgerEntry(entryId);
            if (entry && entry.createdByUserId !== userId) {
                // The amount stays: this is the recipient's OWN transaction, and the
                // durable row is the record they came for.
                await db.createNotification(entry.createdByUserId, {
                    type: 'finance_confirmed',
                    title: 'Your entry was confirmed',
                    body: `${entry.entryType === 'deposit' ? 'Deposit' : 'Withdrawal'} of ${Math.abs(entry.amount).toLocaleString()} aUEC confirmed.`,
                    link: 'finances',
                    metadata: { entryId },
                }).catch((err) => log.warn('approve notify failed', { entryId, err }));
            }
        }
        return { applied: ok };
    },

    'finance:reject_entry': async ({ userId, entryId, reason }: RejectEntryPayload) => {
        const ok = await db.rejectLedgerEntry(userId, entryId, reason || '');
        if (ok) {
            const entry = await db.getLedgerEntry(entryId);
            if (entry && entry.createdByUserId !== userId) {
                // THE REASON IS DROPPED, deliberately. It is officer-authored free text
                // about a member's finances, and it was riding into an OS notification tray
                // — a surface with no permission gate, that renders on a lock screen, and
                // that the durable row would now make permanent. The submitter reads it
                // in-app on the permission-gated ledger, which is where it belongs.
                await db.createNotification(entry.createdByUserId, {
                    type: 'finance_rejected',
                    title: 'Your entry was rejected',
                    body: 'Your submitted entry was rejected — open the ledger for details.',
                    link: 'finances',
                    metadata: { entryId },
                }).catch((err) => log.warn('reject notify failed', { entryId, err }));
            }
        }
        return { applied: ok };
    },

    'finance:reverse_entry': async ({ userId, entryId, reason }: ReverseEntryPayload) => {
        const newId = await db.reverseLedgerEntry(userId, entryId, reason || '');
        return { reversalEntryId: newId };
    },

    'finance:record_adjustment': async ({ userId, accountId, amount, reason, counterpartyText }: RecordAdjustmentPayload) =>
        db.recordAdjustment(userId, { accountId, amount, reason, counterpartyText }),

    // --- OVERVIEW / EXPORT ---
    'finance:get_overview': async () =>
        db.getFinancesOverview(),

    'finance:export_csv': async (opts: ExportCsvPayload) => {
        const csv = await db.exportLedgerCsv(opts);
        return { csv, filename: `ledger-${new Date().toISOString().slice(0, 10)}.csv` };
    },

    'finance:reconcile': async () => db.reconcileBalances(),
};
