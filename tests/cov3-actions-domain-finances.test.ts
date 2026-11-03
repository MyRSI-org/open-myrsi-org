import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Handler-level suite for api/actions/finances.ts (db layer fully mocked).
//
// tests/financeRejectionReason.test.ts runs these handlers against the REAL finance
// module to pin the approver-only rejection reason. This file pins the handler wiring
// itself:
//   * every ledger READ derives its viewer from the SERVER-INJECTED user's
//     permissions via db.ledgerViewerFor — a client-sent flag in the payload buys
//     nothing;
//   * submit_deposit / submit_withdrawal push to finance:approve holders only, with an
//     id-only deep link, and a push failure never fails the submission;
//   * approve/reject notify the submitter only when the action applied, only when the
//     submitter is not the officer acting, and a reject notice never carries the reason;
//   * notification failures are swallowed; db failures propagate.

const spies = vi.hoisted(() => ({
    listTreasuryAccounts: vi.fn(),
    createTreasuryAccount: vi.fn(),
    updateTreasuryAccount: vi.fn(),
    getTreasuryAccount: vi.fn(),
    listLedgerEntries: vi.fn(),
    getLedgerEntry: vi.fn(),
    ledgerViewerFor: vi.fn(),
    submitDeposit: vi.fn(),
    submitWithdrawal: vi.fn(),
    approveLedgerEntry: vi.fn(),
    rejectLedgerEntry: vi.fn(),
    reverseLedgerEntry: vi.fn(),
    recordAdjustment: vi.fn(),
    createNotification: vi.fn(),
    getFinancesOverview: vi.fn(),
    exportLedgerCsv: vi.fn(),
    reconcileBalances: vi.fn(),
    sendPushToPermission: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('../lib/db', () => {
    const { sendPushToPermission: _p, warn: _w, ...dbFns } = spies;
    return dbFns;
});
vi.mock('../lib/push', () => ({ sendPushToPermission: spies.sendPushToPermission }));
// The swallowed-failure paths are observable only through the logger: capture warn.
vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, error: () => {}, warn: spies.warn, child: () => mk(),
    });
    return { log: mk() };
});

import { financesActions } from '../api/actions/finances';

type Handler = (p?: unknown) => Promise<unknown>;
const call = (name: string, p?: unknown) => (financesActions as unknown as Record<string, Handler>)[name](p);

// Viewer tokens the mocked ledgerViewerFor hands back, so a test can see WHICH viewer
// reached the db read.
const APPROVER_VIEWER = { canSeeRejectionReason: true, tag: 'approver' };
const MEMBER_VIEWER = { canSeeRejectionReason: false, tag: 'member' };

const APPROVER = { id: 9, permissions: ['finance:view', 'finance:approve'] };
const MEMBER = { id: 7, permissions: ['finance:view', 'finance:deposit'] };

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
    for (const s of Object.values(spies)) s.mockReset();
    spies.ledgerViewerFor.mockImplementation((perms?: string[] | null) =>
        Array.isArray(perms) && perms.includes('finance:approve') ? APPROVER_VIEWER : MEMBER_VIEWER);
    spies.sendPushToPermission.mockResolvedValue(undefined);
    spies.createNotification.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('accounts', () => {
    it('finance:list_accounts returns the db list', async () => {
        spies.listTreasuryAccounts.mockResolvedValue([{ id: 1, name: 'Ops Fund' }]);
        await expect(call('finance:list_accounts')).resolves.toEqual([{ id: 1, name: 'Ops Fund' }]);
        expect(spies.listTreasuryAccounts).toHaveBeenCalledWith();
    });

    it('finance:create_account forwards only name/type/description (actor fields and extras dropped)', async () => {
        spies.createTreasuryAccount.mockResolvedValue({ id: 2 });
        await expect(call('finance:create_account', {
            name: 'Fuel', type: 'operating', description: 'quantum fuel', userId: 9, user: APPROVER, isActive: false,
        })).resolves.toEqual({ id: 2 });
        expect(spies.createTreasuryAccount).toHaveBeenCalledWith({ name: 'Fuel', type: 'operating', description: 'quantum fuel' });
    });

    it('finance:update_account renames accountId → id and forwards the editable fields', async () => {
        await call('finance:update_account', { accountId: 3, name: 'Fuel 2', type: 'reserve', description: null, isActive: true, userId: 9 });
        expect(spies.updateTreasuryAccount).toHaveBeenCalledWith({ id: 3, name: 'Fuel 2', type: 'reserve', description: null, isActive: true });
    });

    it('finance:archive_account is a soft delete: isActive false and nothing else', async () => {
        await call('finance:archive_account', { accountId: 3, name: 'ignored' });
        expect(spies.updateTreasuryAccount).toHaveBeenCalledWith({ id: 3, isActive: false });
    });

    it('finance:get_account reads the single account slice', async () => {
        spies.getTreasuryAccount.mockResolvedValue({ id: 3, balance: 10 });
        await expect(call('finance:get_account', { accountId: 3 })).resolves.toEqual({ id: 3, balance: 10 });
        expect(spies.getTreasuryAccount).toHaveBeenCalledWith(3);
    });
});

describe('ledger reads take their viewer from the injected user only', () => {
    it('finance:list_ledger forwards the filters and the approver viewer for an approver', async () => {
        spies.listLedgerEntries.mockResolvedValue({ entries: [], total: 0 });
        await call('finance:list_ledger', {
            user: APPROVER, accountId: 1, entryType: 'withdrawal', status: 'open', counterpartyUserId: 7,
            fromDate: '2026-10-01', toDate: '2026-10-31', limit: 50, offset: 100,
        });
        expect(spies.ledgerViewerFor).toHaveBeenCalledWith(APPROVER.permissions);
        expect(spies.listLedgerEntries).toHaveBeenCalledWith({
            accountId: 1, entryType: 'withdrawal', status: 'open', counterpartyUserId: 7,
            fromDate: '2026-10-01', toDate: '2026-10-31', limit: 50, offset: 100,
        }, APPROVER_VIEWER);
    });

    it('finance:list_ledger: a member gets the member viewer even if the payload claims approver rights', async () => {
        await call('finance:list_ledger', { user: MEMBER, canSeeRejectionReason: true, permissions: ['finance:approve'] });
        expect(spies.ledgerViewerFor).toHaveBeenCalledWith(MEMBER.permissions);
        expect(spies.listLedgerEntries.mock.calls[0][1]).toBe(MEMBER_VIEWER);
        // The forged fields never reach the filter object either.
        expect(spies.listLedgerEntries.mock.calls[0][0]).not.toHaveProperty('canSeeRejectionReason');
        expect(spies.listLedgerEntries.mock.calls[0][0]).not.toHaveProperty('permissions');
    });

    it('finance:list_ledger with no user resolves the viewer from undefined (fails closed in ledgerViewerFor)', async () => {
        await call('finance:list_ledger', {});
        expect(spies.ledgerViewerFor).toHaveBeenCalledWith(undefined);
        expect(spies.listLedgerEntries.mock.calls[0][1]).toBe(MEMBER_VIEWER);
    });

    it('finance:get_entry passes the entry id and the caller viewer', async () => {
        spies.getLedgerEntry.mockResolvedValue({ id: 'e1' });
        await expect(call('finance:get_entry', { user: APPROVER, entryId: 'e1' })).resolves.toEqual({ id: 'e1' });
        expect(spies.getLedgerEntry).toHaveBeenCalledWith('e1', APPROVER_VIEWER);
    });

    it('finance:get_overview passes the caller viewer, and a payload-less call fails closed', async () => {
        spies.getFinancesOverview.mockResolvedValue({ totalBalance: 1 });
        await expect(call('finance:get_overview', { user: APPROVER })).resolves.toEqual({ totalBalance: 1 });
        expect(spies.getFinancesOverview).toHaveBeenLastCalledWith(APPROVER_VIEWER);
        await call('finance:get_overview');
        expect(spies.ledgerViewerFor).toHaveBeenLastCalledWith(undefined);
        expect(spies.getFinancesOverview).toHaveBeenLastCalledWith(MEMBER_VIEWER);
    });

    it('finance:export_csv returns the csv with a UTC-dated filename and the caller viewer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        // 23:30 UTC on Nov 2 is already Nov 3 in AEST — the filename must use the UTC date.
        vi.setSystemTime(new Date('2026-11-02T23:30:00.000Z'));
        spies.exportLedgerCsv.mockResolvedValue('id,amount\ne1,5\n');
        const opts = { user: MEMBER, accountId: 1, status: 'approved' };
        await expect(call('finance:export_csv', opts)).resolves.toEqual({ csv: 'id,amount\ne1,5\n', filename: 'ledger-2026-11-02.csv' });
        expect(spies.exportLedgerCsv).toHaveBeenCalledWith(opts, MEMBER_VIEWER);
        expect(spies.ledgerViewerFor).toHaveBeenCalledWith(MEMBER.permissions);
    });

    it('finance:reconcile runs the reconciliation', async () => {
        spies.reconcileBalances.mockResolvedValue({ fixed: 0 });
        await expect(call('finance:reconcile')).resolves.toEqual({ fixed: 0 });
        expect(spies.reconcileBalances).toHaveBeenCalledWith();
    });
});

describe('finance:submit_deposit', () => {
    const payload = {
        userId: 7, accountId: 1, amount: 750, memo: 'salvage run',
        counterpartyUserId: 12, counterpartyText: null, notes: 'RMC sold', operationId: 44,
    };

    it('submits for the actor, pushes to finance:approve holders with an id-only deep link, and returns the entry', async () => {
        spies.submitDeposit.mockResolvedValue({ id: 'e-dep', amount: 750 });
        await expect(call('finance:submit_deposit', payload)).resolves.toEqual({ id: 'e-dep', amount: 750 });
        expect(spies.submitDeposit).toHaveBeenCalledWith(7, {
            accountId: 1, amount: 750, memo: 'salvage run', counterpartyUserId: 12, counterpartyText: null, notes: 'RMC sold', operationId: 44,
        });
        expect(spies.sendPushToPermission).toHaveBeenCalledTimes(1);
        expect(spies.sendPushToPermission).toHaveBeenCalledWith('finance:approve', {
            title: 'Deposit pending review',
            body: `${(750).toLocaleString()} aUEC awaiting confirmation · memo: salvage run`,
            tag: 'finance-deposit-e-dep',
            data: { view: 'finances', tab: 'requests', entryId: 'e-dep' },
        });
    });

    it('a push failure never fails the submission, and is logged with the entry id', async () => {
        spies.submitDeposit.mockResolvedValue({ id: 'e-dep' });
        const pushErr = new Error('push down');
        spies.sendPushToPermission.mockRejectedValue(pushErr);
        await expect(call('finance:submit_deposit', payload)).resolves.toEqual({ id: 'e-dep' });
        await flush();
        expect(spies.warn).toHaveBeenCalledWith('deposit push failed', { entryId: 'e-dep', err: pushErr });
    });

    it('a db failure propagates and nothing is pushed', async () => {
        spies.submitDeposit.mockRejectedValue(new Error('Amount must be positive'));
        await expect(call('finance:submit_deposit', payload)).rejects.toThrow('Amount must be positive');
        expect(spies.sendPushToPermission).not.toHaveBeenCalled();
    });
});

describe('finance:submit_withdrawal', () => {
    const reason = 'Hull repair for the Carrack after the Pyro run, plus restock of medical supplies';
    const payload = { userId: 7, accountId: 1, amount: 900, reason, counterpartyUserId: null, counterpartyText: 'Port Olisar', operationId: null };

    it('submits for the actor and pushes a 60-character reason preview to finance:approve holders', async () => {
        spies.submitWithdrawal.mockResolvedValue({ id: 'e-wd' });
        await expect(call('finance:submit_withdrawal', payload)).resolves.toEqual({ id: 'e-wd' });
        expect(spies.submitWithdrawal).toHaveBeenCalledWith(7, {
            accountId: 1, amount: 900, reason, counterpartyUserId: null, counterpartyText: 'Port Olisar', operationId: null,
        });
        expect(spies.sendPushToPermission).toHaveBeenCalledWith('finance:approve', {
            title: 'Withdrawal request',
            body: `${(900).toLocaleString()} aUEC requested · ${reason.slice(0, 60)}`,
            tag: 'finance-withdrawal-e-wd',
            data: { view: 'finances', tab: 'requests', entryId: 'e-wd' },
        });
        const body = (spies.sendPushToPermission.mock.calls[0][1] as { body: string }).body;
        expect(body).not.toContain('medical supplies');
    });

    it('a push failure never fails the submission, and is logged with the entry id', async () => {
        spies.submitWithdrawal.mockResolvedValue({ id: 'e-wd' });
        const pushErr = new Error('push down');
        spies.sendPushToPermission.mockRejectedValue(pushErr);
        await expect(call('finance:submit_withdrawal', payload)).resolves.toEqual({ id: 'e-wd' });
        await flush();
        expect(spies.warn).toHaveBeenCalledWith('withdrawal push failed', { entryId: 'e-wd', err: pushErr });
    });

    it('a db failure propagates and nothing is pushed', async () => {
        spies.submitWithdrawal.mockRejectedValue(new Error('Insufficient funds'));
        await expect(call('finance:submit_withdrawal', payload)).rejects.toThrow('Insufficient funds');
        expect(spies.sendPushToPermission).not.toHaveBeenCalled();
    });
});

describe('finance:approve_entry', () => {
    it('applied: notifies the submitter with the absolute amount and an id-only metadata', async () => {
        spies.approveLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue({ id: 'e1', createdByUserId: 7, entryType: 'withdrawal', amount: -900 });
        await expect(call('finance:approve_entry', { userId: 9, entryId: 'e1' })).resolves.toEqual({ applied: true });
        expect(spies.approveLedgerEntry).toHaveBeenCalledWith(9, 'e1');
        // The submitter-facing read takes the default (non-approver) viewer.
        expect(spies.getLedgerEntry).toHaveBeenCalledWith('e1');
        expect(spies.createNotification).toHaveBeenCalledWith(7, {
            type: 'finance_confirmed',
            title: 'Your entry was confirmed',
            body: `Withdrawal of ${(900).toLocaleString()} aUEC confirmed.`,
            link: 'finances',
            metadata: { entryId: 'e1' },
        });
    });

    it('a deposit reads "Deposit" in the notice', async () => {
        spies.approveLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue({ id: 'e2', createdByUserId: 7, entryType: 'deposit', amount: 500 });
        await call('finance:approve_entry', { userId: 9, entryId: 'e2' });
        expect((spies.createNotification.mock.calls[0][1] as { body: string }).body).toBe(`Deposit of ${(500).toLocaleString()} aUEC confirmed.`);
    });

    it('not applied: no re-read, no notification', async () => {
        spies.approveLedgerEntry.mockResolvedValue(false);
        await expect(call('finance:approve_entry', { userId: 9, entryId: 'e1' })).resolves.toEqual({ applied: false });
        expect(spies.getLedgerEntry).not.toHaveBeenCalled();
        expect(spies.createNotification).not.toHaveBeenCalled();
    });

    it('an officer approving their own entry is not notified', async () => {
        spies.approveLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue({ id: 'e1', createdByUserId: 9, entryType: 'deposit', amount: 5 });
        await call('finance:approve_entry', { userId: 9, entryId: 'e1' });
        expect(spies.createNotification).not.toHaveBeenCalled();
    });

    it('an entry that vanished between approve and re-read is not notified', async () => {
        spies.approveLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue(null);
        await expect(call('finance:approve_entry', { userId: 9, entryId: 'e1' })).resolves.toEqual({ applied: true });
        expect(spies.createNotification).not.toHaveBeenCalled();
    });

    it('a notification failure is swallowed: the approval still reports applied', async () => {
        spies.approveLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue({ id: 'e1', createdByUserId: 7, entryType: 'deposit', amount: 5 });
        const notifyErr = new Error('notifications table down');
        spies.createNotification.mockRejectedValue(notifyErr);
        await expect(call('finance:approve_entry', { userId: 9, entryId: 'e1' })).resolves.toEqual({ applied: true });
        expect(spies.warn).toHaveBeenCalledWith('approve notify failed', { entryId: 'e1', err: notifyErr });
    });

    it('an approve failure propagates', async () => {
        spies.approveLedgerEntry.mockRejectedValue(new Error('Entry is not pending'));
        await expect(call('finance:approve_entry', { userId: 9, entryId: 'e1' })).rejects.toThrow('Entry is not pending');
    });
});

describe('finance:reject_entry', () => {
    const REASON = 'member is suspected of skimming';

    it('applied: rejects with the reason, notifies the submitter with a generic notice that never carries it', async () => {
        spies.rejectLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue({ id: 'e1', createdByUserId: 7, entryType: 'withdrawal', amount: -900 });
        await expect(call('finance:reject_entry', { userId: 9, entryId: 'e1', reason: REASON })).resolves.toEqual({ applied: true });
        expect(spies.rejectLedgerEntry).toHaveBeenCalledWith(9, 'e1', REASON);
        expect(spies.createNotification).toHaveBeenCalledWith(7, {
            type: 'finance_rejected',
            title: 'Your entry was rejected',
            body: 'Your submitted entry was rejected. Contact a finance officer for details.',
            link: 'finances',
            metadata: { entryId: 'e1' },
        });
        expect(JSON.stringify(spies.createNotification.mock.calls)).not.toContain('skimming');
    });

    it('a missing reason is passed as an empty string', async () => {
        spies.rejectLedgerEntry.mockResolvedValue(false);
        await call('finance:reject_entry', { userId: 9, entryId: 'e1' });
        expect(spies.rejectLedgerEntry).toHaveBeenCalledWith(9, 'e1', '');
    });

    it('not applied: no re-read, no notification', async () => {
        spies.rejectLedgerEntry.mockResolvedValue(false);
        await expect(call('finance:reject_entry', { userId: 9, entryId: 'e1', reason: REASON })).resolves.toEqual({ applied: false });
        expect(spies.getLedgerEntry).not.toHaveBeenCalled();
        expect(spies.createNotification).not.toHaveBeenCalled();
    });

    it('a vanished entry or the officer\'s own entry is not notified', async () => {
        spies.rejectLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'e1', createdByUserId: 9 });
        await call('finance:reject_entry', { userId: 9, entryId: 'e1', reason: REASON });
        await call('finance:reject_entry', { userId: 9, entryId: 'e1', reason: REASON });
        expect(spies.createNotification).not.toHaveBeenCalled();
    });

    it('a notification failure is swallowed: the rejection still reports applied', async () => {
        spies.rejectLedgerEntry.mockResolvedValue(true);
        spies.getLedgerEntry.mockResolvedValue({ id: 'e1', createdByUserId: 7 });
        const notifyErr = new Error('notifications table down');
        spies.createNotification.mockRejectedValue(notifyErr);
        await expect(call('finance:reject_entry', { userId: 9, entryId: 'e1', reason: REASON })).resolves.toEqual({ applied: true });
        // The failure log carries the entry id, never the officer's reason.
        expect(spies.warn).toHaveBeenCalledWith('reject notify failed', { entryId: 'e1', err: notifyErr });
        expect(JSON.stringify(spies.warn.mock.calls)).not.toContain('skimming');
    });
});

describe('reversal and adjustment', () => {
    it('finance:reverse_entry returns the new reversal id and defaults the reason to ""', async () => {
        spies.reverseLedgerEntry.mockResolvedValue('e-rev');
        await expect(call('finance:reverse_entry', { userId: 9, entryId: 'e1', reason: 'duplicate' })).resolves.toEqual({ reversalEntryId: 'e-rev' });
        expect(spies.reverseLedgerEntry).toHaveBeenCalledWith(9, 'e1', 'duplicate');
        await call('finance:reverse_entry', { userId: 9, entryId: 'e2' });
        expect(spies.reverseLedgerEntry).toHaveBeenLastCalledWith(9, 'e2', '');
    });

    it('finance:reverse_entry propagates a db refusal', async () => {
        spies.reverseLedgerEntry.mockRejectedValue(new Error('Entry already reversed'));
        await expect(call('finance:reverse_entry', { userId: 9, entryId: 'e1' })).rejects.toThrow('Entry already reversed');
    });

    it('finance:record_adjustment forwards the actor and only the adjustment fields', async () => {
        spies.recordAdjustment.mockResolvedValue({ id: 'e-adj' });
        await expect(call('finance:record_adjustment', {
            userId: 9, accountId: 1, amount: -25, reason: 'rounding', counterpartyText: null, user: APPROVER,
        })).resolves.toEqual({ id: 'e-adj' });
        expect(spies.recordAdjustment).toHaveBeenCalledWith(9, { accountId: 1, amount: -25, reason: 'rounding', counterpartyText: null });
    });
});
