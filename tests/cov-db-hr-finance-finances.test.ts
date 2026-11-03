import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/finances.ts — behaviour pins for the treasury data layer.
//
// Complements tests/financeRejectionReason.test.ts (approver-only rejection reasons),
// tests/sec-finances.test.ts (CSV formula injection + export ceiling) and
// tests/financeOverviewAggregate.test.ts (overview aggregate). This file pins what those
// leave open: the exact queries every account / ledger read and write issues, the
// validation that runs BEFORE any write, the fail-closed direction of every error branch,
// the RPC arguments behind approve / reject / reverse / adjust, the id-only realtime
// broadcasts each write emits (Security rule 4), and the export's paging behaviour.

type Call = { method: string; args: unknown[] };
type Q = { table: string; op: string; calls: Call[]; terminal: string };
type Res = { data?: unknown; error?: unknown; count?: number | null };
type Rule = { table: string; op?: string; when?: (q: Q) => boolean; res: Res | ((q: Q) => Res); once?: boolean };

const h = vi.hoisted(() => ({
    queries: [] as Q[],
    rules: [] as Rule[],
    rpcs: [] as Array<{ name: string; args: unknown }>,
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    warns: [] as unknown[][],
    resolve(q: Q): Res {
        const i = this.rules.findIndex(r => r.table === q.table && (!r.op || r.op === q.op) && (!r.when || r.when(q)));
        if (i < 0) return { data: null, error: null };
        const rule = this.rules[i];
        if (rule.once) this.rules.splice(i, 1);
        return typeof rule.res === 'function' ? rule.res(q) : rule.res;
    },
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, error: () => {},
        warn: (...args: unknown[]) => { h.warns.push(args); },
        child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    const WRITE_OPS = ['insert', 'update', 'delete', 'upsert'];
    function builder(table: string) {
        const q: Q = { table, op: 'select', calls: [], terminal: '' };
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'gt', 'gte',
            'lt', 'lte', 'ilike', ...WRITE_OPS]) {
            b[m] = (...args: unknown[]) => {
                q.calls.push({ method: m, args });
                if (WRITE_OPS.includes(m) && q.op === 'select') q.op = m;
                return b;
            };
        }
        const settle = (terminal: string) => {
            q.terminal = terminal;
            h.queries.push(q);
            try { return Promise.resolve(h.resolve(q)); } catch (e) { return Promise.reject(e); }
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('maybeSingle');
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('then').then(res, rej);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (name: string, args?: unknown) => {
                h.rpcs.push({ name, args });
                return Promise.resolve(h.resolve({ table: `rpc:${name}`, op: 'rpc', calls: [{ method: 'rpc', args: [args] }], terminal: 'rpc' }));
            },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); return Promise.resolve(); },
    };
});

import {
    listTreasuryAccounts, createTreasuryAccount, updateTreasuryAccount, getTreasuryAccount,
    listLedgerEntries, getLedgerEntry, submitDeposit, submitWithdrawal,
    approveLedgerEntry, rejectLedgerEntry, reverseLedgerEntry, recordAdjustment,
    getFinancesOverview, exportLedgerCsv, csvEscape, reconcileBalances, ledgerViewerFor,
} from '../lib/db/finances';

// ---- fake-supabase helpers -------------------------------------------------

const on = (table: string, res: Rule['res'], opts: { op?: string; when?: (q: Q) => boolean; once?: boolean } = {}) => {
    h.rules.push({ table, res, ...opts });
};
const onRpc = (name: string, res: Res, once = false) => on(`rpc:${name}`, res, { once });
const queriesOf = (table: string, op?: string) => h.queries.filter(q => q.table === table && (!op || q.op === op));
const argsOf = (q: Q | undefined, method: string) => q?.calls.find(c => c.method === method)?.args;
const allArgs = (q: Q | undefined, method: string) => (q?.calls ?? []).filter(c => c.method === method).map(c => c.args);
const selectOf = (q: Q | undefined) => String(argsOf(q, 'select')?.[0] ?? '');

const ACCOUNT_COLS = 'id, name, type, description, balance_cached, is_active, created_at, updated_at';

const accountRow = (over: Record<string, unknown> = {}) => ({
    id: 3, name: 'General Fund', type: 'general', description: 'main pot', balance_cached: '1500',
    is_active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', ...over,
});

const ledgerRow = (id: string, over: Record<string, unknown> = {}) => ({
    id, account_id: 3, entry_type: 'deposit', amount: '250', status: 'confirmed', memo: 'REF-1',
    counterparty_user_id: 7, counterparty: { id: 7, name: 'Pilot Seven', avatar_url: null, rsi_handle: 'seven' },
    counterparty_text: null, operation_id: null, related_inventory_id: null, related_entry_id: null,
    transfer_group_id: null, created_by_user_id: 7, created_by: { id: 7, name: 'Pilot Seven', avatar_url: 'a.png', rsi_handle: 'seven' },
    approved_by_user_id: 9, approved_by: { id: 9, name: 'Treasurer Nine', avatar_url: null, rsi_handle: null },
    approved_at: '2026-02-02T00:00:00Z', notes: null,
    created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-02T00:00:00Z', ...over,
});

const APPROVER = ledgerViewerFor(['finance:view', 'finance:approve']);

beforeEach(() => {
    h.queries = [];
    h.rules = [];
    h.rpcs = [];
    h.broadcasts = [];
    h.warns = [];
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('listTreasuryAccounts', () => {
    it('selects the explicit account columns, active-first then oldest-first, and maps every row', async () => {
        on('treasury_accounts', { data: [accountRow(), accountRow({ id: 4, type: null, is_active: null, balance_cached: null, description: undefined })], error: null });
        const out = await listTreasuryAccounts();
        const q = queriesOf('treasury_accounts')[0];
        expect(selectOf(q)).toBe(ACCOUNT_COLS);
        expect(allArgs(q, 'order')).toEqual([['is_active', { ascending: false }], ['created_at', { ascending: true }]]);
        expect(out).toEqual([
            { id: 3, name: 'General Fund', type: 'general', description: 'main pot', balanceCached: 1500, isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
            // Missing type → 'general', null is_active → active, null balance → 0, no description → null.
            { id: 4, name: 'General Fund', type: 'general', description: null, balanceCached: 0, isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
        ]);
    });

    it('returns [] when the treasury tables are not migrated yet (42P01)', async () => {
        on('treasury_accounts', { data: null, error: { code: '42P01', message: 'relation does not exist' } });
        expect(await listTreasuryAccounts()).toEqual([]);
    });

    it('throws on any other read error instead of rendering an empty treasury', async () => {
        on('treasury_accounts', { data: null, error: { code: '08006', message: 'connection reset' } });
        await expect(listTreasuryAccounts()).rejects.toThrow('Failed to load treasury accounts');
    });

    it('treats an errorless null payload as no accounts', async () => {
        on('treasury_accounts', { data: null, error: null });
        expect(await listTreasuryAccounts()).toEqual([]);
    });
});

describe('createTreasuryAccount', () => {
    it('rejects a blank or whitespace-only name before touching the database', async () => {
        await expect(createTreasuryAccount({ name: '   ' })).rejects.toThrow('Account name is required.');
        await expect(createTreasuryAccount({ name: undefined as unknown as string })).rejects.toThrow('Account name is required.');
        expect(h.queries).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('inserts the trimmed name with general/null defaults, returns the mapped row, broadcasts the id only', async () => {
        on('treasury_accounts', { data: accountRow({ id: 11, name: 'Ops Fund', description: null }), error: null }, { op: 'insert' });
        const out = await createTreasuryAccount({ name: '  Ops Fund  ' });
        const q = queriesOf('treasury_accounts', 'insert')[0];
        expect(argsOf(q, 'insert')?.[0]).toEqual({ name: 'Ops Fund', type: 'general', description: null });
        expect(selectOf(q)).toBe(ACCOUNT_COLS);
        expect(q.terminal).toBe('single');
        expect(out).toMatchObject({ id: 11, name: 'Ops Fund', type: 'general', description: null, balanceCached: 1500 });
        expect(h.broadcasts).toEqual([{ event: 'finances:account_update', payload: { accountId: 11 } }]);
    });

    it('passes an explicit type and description through', async () => {
        on('treasury_accounts', { data: accountRow({ id: 12, type: 'operations' }), error: null }, { op: 'insert' });
        await createTreasuryAccount({ name: 'Ops', type: 'operations' as never, description: 'for ops' });
        expect(argsOf(queriesOf('treasury_accounts', 'insert')[0], 'insert')?.[0]).toEqual({ name: 'Ops', type: 'operations', description: 'for ops' });
    });

    it('throws on an insert error and on an empty insert result, broadcasting nothing', async () => {
        on('treasury_accounts', { data: null, error: { code: '23505', message: 'dup' } }, { op: 'insert', once: true });
        await expect(createTreasuryAccount({ name: 'Ops' })).rejects.toThrow('Failed to create account');
        on('treasury_accounts', { data: null, error: null }, { op: 'insert', once: true });
        await expect(createTreasuryAccount({ name: 'Ops' })).rejects.toThrow('Account insert returned no row.');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('updateTreasuryAccount', () => {
    it('patches ONLY the supplied fields (name trimmed), always stamps updated_at, scopes to the id', async () => {
        on('treasury_accounts', { data: accountRow({ id: 5, name: 'Renamed', is_active: false }), error: null }, { op: 'update' });
        const out = await updateTreasuryAccount({ id: 5, name: '  Renamed ', type: 'reserve' as never, description: null, isActive: false });
        const q = queriesOf('treasury_accounts', 'update')[0];
        const patch = argsOf(q, 'update')?.[0] as Record<string, unknown>;
        expect(Object.keys(patch).sort()).toEqual(['description', 'is_active', 'name', 'type', 'updated_at']);
        expect(patch).toMatchObject({ name: 'Renamed', type: 'reserve', description: null, is_active: false });
        expect(Number.isNaN(Date.parse(String(patch.updated_at)))).toBe(false);
        expect(allArgs(q, 'eq')).toEqual([['id', 5]]);
        expect(selectOf(q)).toBe(ACCOUNT_COLS);
        expect(out).toMatchObject({ id: 5, name: 'Renamed', isActive: false });
        expect(h.broadcasts).toEqual([{ event: 'finances:account_update', payload: { accountId: 5 } }]);
    });

    it('sends only updated_at when nothing else is supplied', async () => {
        on('treasury_accounts', { data: accountRow({ id: 5 }), error: null }, { op: 'update' });
        await updateTreasuryAccount({ id: 5 });
        expect(Object.keys(argsOf(queriesOf('treasury_accounts', 'update')[0], 'update')?.[0] as object)).toEqual(['updated_at']);
    });

    it('throws on an update error or a missing row, broadcasting nothing', async () => {
        on('treasury_accounts', { data: null, error: { code: '42501', message: 'denied' } }, { op: 'update', once: true });
        await expect(updateTreasuryAccount({ id: 5, name: 'x' })).rejects.toThrow('Failed to update account');
        on('treasury_accounts', { data: null, error: null }, { op: 'update', once: true });
        await expect(updateTreasuryAccount({ id: 5, name: 'x' })).rejects.toThrow('Account update returned no row.');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('getTreasuryAccount (realtime row slice)', () => {
    it('reads one account by id with the explicit columns and maps it', async () => {
        on('treasury_accounts', { data: accountRow({ id: 8 }), error: null });
        const out = await getTreasuryAccount(8);
        const q = queriesOf('treasury_accounts')[0];
        expect(selectOf(q)).toBe(ACCOUNT_COLS);
        expect(allArgs(q, 'eq')).toEqual([['id', 8]]);
        expect(q.terminal).toBe('maybeSingle');
        expect(out?.id).toBe(8);
    });

    it('returns null only on genuine absence and throws on an error', async () => {
        on('treasury_accounts', { data: null, error: null }, { once: true });
        expect(await getTreasuryAccount(8)).toBeNull();
        on('treasury_accounts', { data: null, error: { code: '42P01', message: 'missing' } }, { once: true });
        await expect(getTreasuryAccount(8)).rejects.toThrow('Failed to get account slice');
    });
});

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------

describe('listLedgerEntries — the shared page query', () => {
    it('selects explicit ledger columns + named user embeds, never a wildcard', async () => {
        on('treasury_ledger_entries', { data: [], error: null });
        await listLedgerEntries();
        const sel = selectOf(queriesOf('treasury_ledger_entries')[0]);
        expect(sel).not.toContain('*');
        expect(sel).toContain('counterparty:users!treasury_ledger_entries_counterparty_user_id_fkey(id, name, avatar_url, rsi_handle)');
        expect(sel).toContain('created_by:users!treasury_ledger_entries_created_by_user_id_fkey(id, name, avatar_url, rsi_handle)');
        expect(sel).toContain('approved_by:users!treasury_ledger_entries_approved_by_user_id_fkey(id, name, avatar_url, rsi_handle)');
        // The rejection reason is never in the shared select.
        expect(sel).not.toContain('rejection_reason');
    });

    it('applies every filter, a total order (created_at desc, id desc), the limit, and no range on page one', async () => {
        on('treasury_ledger_entries', { data: [], error: null });
        await listLedgerEntries({
            accountId: 3, entryType: 'withdrawal', status: 'confirmed', counterpartyUserId: 7,
            fromDate: '2026-01-01', toDate: '2026-02-01', limit: 25,
        });
        const q = queriesOf('treasury_ledger_entries')[0];
        expect(allArgs(q, 'eq')).toEqual([
            ['account_id', 3], ['entry_type', 'withdrawal'], ['status', 'confirmed'], ['counterparty_user_id', 7],
        ]);
        expect(argsOf(q, 'gte')).toEqual(['created_at', '2026-01-01']);
        expect(argsOf(q, 'lte')).toEqual(['created_at', '2026-02-01']);
        expect(allArgs(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argsOf(q, 'limit')).toEqual([25]);
        expect(argsOf(q, 'range')).toBeUndefined();
    });

    it("maps status 'open' to pending", async () => {
        on('treasury_ledger_entries', { data: [], error: null });
        await listLedgerEntries({ status: 'open' });
        expect(allArgs(queriesOf('treasury_ledger_entries')[0], 'eq')).toEqual([['status', 'pending']]);
    });

    it('applies no filter for absent/falsy filter values', async () => {
        on('treasury_ledger_entries', { data: [], error: null });
        await listLedgerEntries({ accountId: 0, entryType: undefined, counterpartyUserId: 0, fromDate: '', toDate: '' });
        const q = queriesOf('treasury_ledger_entries')[0];
        expect(allArgs(q, 'eq')).toEqual([]);
        expect(argsOf(q, 'gte')).toBeUndefined();
        expect(argsOf(q, 'lte')).toBeUndefined();
    });

    it('clamps the page size to 1..500 with a default of 200', async () => {
        on('treasury_ledger_entries', { data: [], error: null });
        const limits: unknown[] = [];
        for (const limit of [undefined, 0, -10, 9999, 40]) {
            h.queries = [];
            await listLedgerEntries({ limit });
            limits.push(argsOf(queriesOf('treasury_ledger_entries')[0], 'limit')?.[0]);
        }
        expect(limits).toEqual([200, 1, 1, 500, 40]);
    });

    it('pages with range(offset, offset+limit-1) and clamps a hostile offset', async () => {
        on('treasury_ledger_entries', { data: [], error: null });
        await listLedgerEntries({ limit: 50, offset: 100 });
        expect(argsOf(queriesOf('treasury_ledger_entries')[0], 'range')).toEqual([100, 149]);
        h.queries = [];
        await listLedgerEntries({ limit: 50, offset: 10_000_000 });
        expect(argsOf(queriesOf('treasury_ledger_entries')[0], 'range')).toEqual([100_000, 100_049]);
        for (const offset of [-5, Number.NaN, '20' as unknown as number]) {
            h.queries = [];
            await listLedgerEntries({ limit: 50, offset });
            expect(argsOf(queriesOf('treasury_ledger_entries')[0], 'range')).toBeUndefined();
        }
    });

    it('maps rows (amount → number, embeds → counterparties with fallbacks)', async () => {
        on('treasury_ledger_entries', { data: [ledgerRow('e1')], error: null });
        const [e] = await listLedgerEntries();
        expect(e).toMatchObject({
            id: 'e1', accountId: 3, entryType: 'deposit', amount: 250, status: 'confirmed', memo: 'REF-1',
            counterpartyUserId: 7, createdByUserId: 7, approvedByUserId: 9, notes: null,
            counterparty: { id: 7, name: 'Pilot Seven', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', rsiHandle: 'seven' },
            approvedBy: { id: 9, name: 'Treasurer Nine', rsiHandle: '' },
        });
    });

    it('returns [] before the ledger is migrated (42P01) and throws on any other error', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '42P01', message: 'missing' } }, { once: true });
        expect(await listLedgerEntries()).toEqual([]);
        on('treasury_ledger_entries', { data: null, error: { code: '57014', message: 'timeout' } }, { once: true });
        await expect(listLedgerEntries()).rejects.toThrow('Failed to load ledger');
        on('treasury_ledger_entries', { data: null, error: null }, { once: true });
        expect(await listLedgerEntries()).toEqual([]);
    });
});

describe('getLedgerEntry', () => {
    it('reads a single entry by id through the shared select', async () => {
        on('treasury_ledger_entries', { data: ledgerRow('e9'), error: null });
        const out = await getLedgerEntry('e9');
        const q = queriesOf('treasury_ledger_entries')[0];
        expect(selectOf(q)).toContain('counterparty:users!treasury_ledger_entries_counterparty_user_id_fkey');
        expect(allArgs(q, 'eq')).toEqual([['id', 'e9']]);
        expect(q.terminal).toBe('maybeSingle');
        expect(out?.id).toBe('e9');
    });
});

describe('rejection-reason follow-up read (approver path)', () => {
    it('issues no reason read when the page holds no rejected rows', async () => {
        on('treasury_ledger_entries', { data: [ledgerRow('e1'), ledgerRow('e2', { status: 'pending' })], error: null });
        const out = await listLedgerEntries({}, APPROVER);
        expect(queriesOf('treasury_ledger_entries')).toHaveLength(1);
        expect(out.every(e => !('rejectionReason' in e))).toBe(true);
    });

    it('reads id + rejection_reason only, ordered and bounded, and skips null reasons', async () => {
        on('treasury_ledger_entries', { data: [{ id: 'r1', rejection_reason: 'over budget' }, { id: 'r2', rejection_reason: null }], error: null },
            { when: q => selectOf(q) === 'id, rejection_reason' });
        on('treasury_ledger_entries', { data: [ledgerRow('r1', { status: 'rejected' }), ledgerRow('r2', { status: 'rejected' })], error: null });
        const out = await listLedgerEntries({}, APPROVER);
        const reasonQ = queriesOf('treasury_ledger_entries').find(q => selectOf(q) === 'id, rejection_reason');
        expect(argsOf(reasonQ, 'in')).toEqual(['id', ['r1', 'r2']]);
        expect(argsOf(reasonQ, 'order')).toEqual(['id', { ascending: true }]);
        expect(argsOf(reasonQ, 'limit')).toEqual([2]);
        expect(out[0].rejectionReason).toBe('over budget');
        expect('rejectionReason' in out[1]).toBe(false);
    });

    it('tolerates an errorless null payload from the reason read', async () => {
        on('treasury_ledger_entries', { data: null, error: null }, { when: q => selectOf(q) === 'id, rejection_reason' });
        on('treasury_ledger_entries', { data: [ledgerRow('r1', { status: 'rejected' })], error: null });
        const out = await listLedgerEntries({}, APPROVER);
        expect('rejectionReason' in out[0]).toBe(false);
    });

    it('degrades on PGRST204 as well as 42703, and warns about the missing column only once per process', async () => {
        vi.resetModules();
        const fresh = await import('../lib/db/finances');
        on('treasury_ledger_entries', { data: null, error: { code: 'PGRST204', message: 'column not in schema cache' } }, { when: q => selectOf(q) === 'id, rejection_reason', once: true });
        on('treasury_ledger_entries', { data: null, error: { code: '42703', message: 'undefined column' } }, { when: q => selectOf(q) === 'id, rejection_reason', once: true });
        on('treasury_ledger_entries', { data: [ledgerRow('r1', { status: 'rejected', notes: 'x\n[rejected] inline' })], error: null });
        const first = await fresh.listLedgerEntries({}, APPROVER);
        const second = await fresh.listLedgerEntries({}, APPROVER);
        for (const out of [first, second]) {
            expect('rejectionReason' in out[0]).toBe(false);
            // On such a database the approver keeps the inline reason, as before.
            expect(out[0].notes).toBe('x\n[rejected] inline');
        }
        const columnWarns = h.warns.filter(w => /rejection_reason is missing/.test(String(w[0])));
        expect(columnWarns).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Ledger writes
// ---------------------------------------------------------------------------

describe('submitDeposit', () => {
    it('rejects a non-positive / non-numeric amount and a blank memo before any write', async () => {
        for (const amount of [0, -5, Number.NaN, 'abc' as unknown as number, 0.4]) {
            await expect(submitDeposit(7, { accountId: 3, amount, memo: 'REF' })).rejects.toThrow('Deposit amount must be a positive integer.');
        }
        await expect(submitDeposit(7, { accountId: 3, amount: 10, memo: '   ' })).rejects.toThrow('A memo/reference is required for deposits.');
        await expect(submitDeposit(7, { accountId: 3, amount: 10, memo: undefined as unknown as string })).rejects.toThrow('A memo/reference is required');
        expect(h.queries).toHaveLength(0);
    });

    it('inserts a pending deposit (amount truncated, memo trimmed, counterparty defaulting to the submitter)', async () => {
        on('treasury_ledger_entries', { data: ledgerRow('d1', { status: 'pending', amount: 99 }), error: null }, { op: 'insert' });
        const out = await submitDeposit(7, { accountId: 3, amount: 99.9, memo: '  REF-77 ' });
        const q = queriesOf('treasury_ledger_entries', 'insert')[0];
        expect(argsOf(q, 'insert')?.[0]).toEqual({
            account_id: 3, entry_type: 'deposit', amount: 99, status: 'pending', memo: 'REF-77',
            counterparty_user_id: 7, counterparty_text: null, notes: null, operation_id: null, created_by_user_id: 7,
        });
        expect(selectOf(q)).toContain('approved_by:users!');
        expect(out).toMatchObject({ id: 'd1', status: 'pending', amount: 99 });
        expect(h.broadcasts).toEqual([{ event: 'finances:ledger_update', payload: { entryId: 'd1' } }]);
    });

    it('passes an explicit counterparty, text, notes and operation through', async () => {
        on('treasury_ledger_entries', { data: ledgerRow('d2'), error: null }, { op: 'insert' });
        await submitDeposit(7, { accountId: 3, amount: 5, memo: 'R', counterpartyUserId: 12, counterpartyText: 'alt acct', notes: 'n', operationId: 44 });
        expect(argsOf(queriesOf('treasury_ledger_entries', 'insert')[0], 'insert')?.[0]).toMatchObject({
            counterparty_user_id: 12, counterparty_text: 'alt acct', notes: 'n', operation_id: 44, created_by_user_id: 7,
        });
    });

    it('maps the pending-duplicate unique violation to an actionable message', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '23505', message: 'duplicate key' } }, { op: 'insert' });
        await expect(submitDeposit(7, { accountId: 3, amount: 5, memo: 'R' }))
            .rejects.toThrow('You already have a pending deposit with this memo and amount.');
        expect(h.broadcasts).toHaveLength(0);
    });

    it('throws the generic message on any other error, and on an empty insert', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert', once: true });
        await expect(submitDeposit(7, { accountId: 3, amount: 5, memo: 'R' })).rejects.toThrow('Failed to submit deposit');
        on('treasury_ledger_entries', { data: null, error: null }, { op: 'insert', once: true });
        await expect(submitDeposit(7, { accountId: 3, amount: 5, memo: 'R' })).rejects.toThrow('Deposit insert returned no row.');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('submitWithdrawal', () => {
    it('rejects a non-positive amount and a blank reason before any write', async () => {
        for (const amount of [0, -1, Number.NaN]) {
            await expect(submitWithdrawal(7, { accountId: 3, amount, reason: 'fuel' })).rejects.toThrow('Withdrawal amount must be a positive integer.');
        }
        await expect(submitWithdrawal(7, { accountId: 3, amount: 5, reason: ' ' })).rejects.toThrow('A reason is required for withdrawal requests.');
        await expect(submitWithdrawal(7, { accountId: 3, amount: 5, reason: undefined as unknown as string })).rejects.toThrow('A reason is required');
        expect(h.queries).toHaveLength(0);
    });

    it('stores the amount NEGATIVE, memo null, the trimmed reason as notes, and broadcasts the id', async () => {
        on('treasury_ledger_entries', { data: ledgerRow('w1', { entry_type: 'withdrawal', amount: -300, status: 'pending' }), error: null }, { op: 'insert' });
        const out = await submitWithdrawal(7, { accountId: 3, amount: 300.7, reason: '  fuel run ', counterpartyText: 'in-game' , operationId: 2 });
        expect(argsOf(queriesOf('treasury_ledger_entries', 'insert')[0], 'insert')?.[0]).toEqual({
            account_id: 3, entry_type: 'withdrawal', amount: -300, status: 'pending', memo: null,
            counterparty_user_id: 7, counterparty_text: 'in-game', notes: 'fuel run', operation_id: 2, created_by_user_id: 7,
        });
        expect(out).toMatchObject({ id: 'w1', amount: -300 });
        expect(h.broadcasts).toEqual([{ event: 'finances:ledger_update', payload: { entryId: 'w1' } }]);
    });

    it('throws on an insert error and on an empty insert, broadcasting nothing', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert', once: true });
        await expect(submitWithdrawal(7, { accountId: 3, amount: 5, reason: 'r', counterpartyUserId: 4 })).rejects.toThrow('Failed to submit withdrawal request');
        on('treasury_ledger_entries', { data: null, error: null }, { op: 'insert', once: true });
        await expect(submitWithdrawal(7, { accountId: 3, amount: 5, reason: 'r' })).rejects.toThrow('Withdrawal insert returned no row.');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('approveLedgerEntry', () => {
    it('loads id/status/account_id, invokes finance_approve_entry, and broadcasts entry + account ids', async () => {
        on('treasury_ledger_entries', { data: { id: 'p1', status: 'pending', account_id: 3 }, error: null });
        onRpc('finance_approve_entry', { data: 1, error: null });
        expect(await approveLedgerEntry(9, 'p1')).toBe(true);
        const q = queriesOf('treasury_ledger_entries')[0];
        expect(selectOf(q)).toBe('id, status, account_id');
        expect(allArgs(q, 'eq')).toEqual([['id', 'p1']]);
        expect(h.rpcs).toEqual([{ name: 'finance_approve_entry', args: { p_entry_id: 'p1', p_approver_id: 9 } }]);
        expect(h.broadcasts).toEqual([
            { event: 'finances:ledger_update', payload: { entryId: 'p1' } },
            { event: 'finances:account_update', payload: { accountId: 3 } },
        ]);
    });

    it('returns false WITHOUT calling the RPC when the entry is no longer pending (double-click)', async () => {
        on('treasury_ledger_entries', { data: { id: 'p1', status: 'confirmed', account_id: 3 }, error: null });
        expect(await approveLedgerEntry(9, 'p1')).toBe(false);
        expect(h.rpcs).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('returns false when the idempotent RPC reports zero rows affected (or nothing)', async () => {
        on('treasury_ledger_entries', { data: { id: 'p1', status: 'pending', account_id: 3 }, error: null });
        onRpc('finance_approve_entry', { data: 0, error: null }, true);
        expect(await approveLedgerEntry(9, 'p1')).toBe(false);
        onRpc('finance_approve_entry', { data: null, error: null }, true);
        expect(await approveLedgerEntry(9, 'p1')).toBe(false);
    });

    it('throws on a scope-read error, a missing entry, and an RPC error (no broadcast)', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '08006', message: 'x' } }, { once: true });
        await expect(approveLedgerEntry(9, 'p1')).rejects.toThrow('Failed to load entry');
        on('treasury_ledger_entries', { data: null, error: null }, { once: true });
        await expect(approveLedgerEntry(9, 'p1')).rejects.toThrow('Entry not found.');
        on('treasury_ledger_entries', { data: { id: 'p1', status: 'pending', account_id: 3 }, error: null });
        onRpc('finance_approve_entry', { data: null, error: { code: 'P0001', message: 'locked' } });
        await expect(approveLedgerEntry(9, 'p1')).rejects.toThrow('Failed to approve entry');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('rejectLedgerEntry', () => {
    it('loads id/status, hands the reason to finance_reject_entry, broadcasts the entry id only', async () => {
        on('treasury_ledger_entries', { data: { id: 'p2', status: 'pending' }, error: null });
        onRpc('finance_reject_entry', { data: 1, error: null });
        expect(await rejectLedgerEntry(9, 'p2', 'no receipt')).toBe(true);
        expect(selectOf(queriesOf('treasury_ledger_entries')[0])).toBe('id, status');
        expect(h.rpcs).toEqual([{ name: 'finance_reject_entry', args: { p_entry_id: 'p2', p_approver_id: 9, p_reason: 'no receipt' } }]);
        // A rejection does not move a balance, so there is no account broadcast.
        expect(h.broadcasts).toEqual([{ event: 'finances:ledger_update', payload: { entryId: 'p2' } }]);
    });

    it("sends '' for an absent reason and reports false when nothing was rejected", async () => {
        on('treasury_ledger_entries', { data: { id: 'p2', status: 'pending' }, error: null });
        onRpc('finance_reject_entry', { data: 0, error: null }, true);
        expect(await rejectLedgerEntry(9, 'p2', undefined as unknown as string)).toBe(false);
        expect((h.rpcs[0].args as Record<string, unknown>).p_reason).toBe('');
        onRpc('finance_reject_entry', { data: null, error: null }, true);
        expect(await rejectLedgerEntry(9, 'p2', 'r')).toBe(false);
    });

    it('returns false without the RPC for a non-pending entry; throws on missing/scope error/RPC error', async () => {
        on('treasury_ledger_entries', { data: { id: 'p2', status: 'rejected' }, error: null }, { once: true });
        expect(await rejectLedgerEntry(9, 'p2', 'r')).toBe(false);
        expect(h.rpcs).toHaveLength(0);
        on('treasury_ledger_entries', { data: null, error: null }, { once: true });
        await expect(rejectLedgerEntry(9, 'p2', 'r')).rejects.toThrow('Entry not found.');
        on('treasury_ledger_entries', { data: null, error: { code: 'x', message: 'x' } }, { once: true });
        await expect(rejectLedgerEntry(9, 'p2', 'r')).rejects.toThrow('Failed to load entry');
        on('treasury_ledger_entries', { data: { id: 'p2', status: 'pending' }, error: null });
        onRpc('finance_reject_entry', { data: null, error: { code: 'P0001', message: 'x' } });
        await expect(rejectLedgerEntry(9, 'p2', 'r')).rejects.toThrow('Failed to reject entry');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('reverseLedgerEntry', () => {
    it('reverses a confirmed entry, broadcasting BOTH changed ledger ids and the account id', async () => {
        on('treasury_ledger_entries', { data: { id: 'c1', status: 'confirmed', account_id: 4 }, error: null });
        onRpc('finance_reverse_entry', { data: 'adj-1', error: null });
        expect(await reverseLedgerEntry(9, 'c1', 'entered twice')).toBe('adj-1');
        expect(selectOf(queriesOf('treasury_ledger_entries')[0])).toBe('id, status, account_id');
        expect(h.rpcs).toEqual([{ name: 'finance_reverse_entry', args: { p_entry_id: 'c1', p_actor_id: 9, p_reason: 'entered twice' } }]);
        expect(h.broadcasts).toEqual([
            { event: 'finances:ledger_update', payload: { entryIds: ['c1', 'adj-1'] } },
            { event: 'finances:account_update', payload: { accountId: 4 } },
        ]);
    });

    it('refuses anything that is not confirmed, before the RPC', async () => {
        for (const status of ['pending', 'rejected', 'reversed']) {
            on('treasury_ledger_entries', { data: { id: 'c1', status, account_id: 4 }, error: null }, { once: true });
            await expect(reverseLedgerEntry(9, 'c1', 'r')).rejects.toThrow('Only confirmed entries may be reversed.');
        }
        expect(h.rpcs).toHaveLength(0);
    });

    it("sends '' for an absent reason; throws on missing / scope error / RPC error", async () => {
        on('treasury_ledger_entries', { data: { id: 'c1', status: 'confirmed', account_id: 4 }, error: null }, { once: true });
        onRpc('finance_reverse_entry', { data: 'adj-2', error: null }, true);
        await reverseLedgerEntry(9, 'c1', '');
        expect((h.rpcs[0].args as Record<string, unknown>).p_reason).toBe('');
        h.broadcasts = [];
        on('treasury_ledger_entries', { data: null, error: null }, { once: true });
        await expect(reverseLedgerEntry(9, 'c1', 'r')).rejects.toThrow('Entry not found.');
        on('treasury_ledger_entries', { data: null, error: { code: 'x', message: 'x' } }, { once: true });
        await expect(reverseLedgerEntry(9, 'c1', 'r')).rejects.toThrow('Failed to load entry');
        on('treasury_ledger_entries', { data: { id: 'c1', status: 'confirmed', account_id: 4 }, error: null });
        onRpc('finance_reverse_entry', { data: null, error: { code: 'P0001', message: 'x' } });
        await expect(reverseLedgerEntry(9, 'c1', 'r')).rejects.toThrow('Failed to reverse entry');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('recordAdjustment', () => {
    it('rejects a zero / non-numeric amount and a blank reason before any write', async () => {
        for (const amount of [0, 0.3, Number.NaN, Infinity]) {
            await expect(recordAdjustment(9, { accountId: 3, amount, reason: 'seed' })).rejects.toThrow('Adjustment amount must be a non-zero integer.');
        }
        await expect(recordAdjustment(9, { accountId: 3, amount: 10, reason: '' })).rejects.toThrow('A reason is required for adjustments.');
        await expect(recordAdjustment(9, { accountId: 3, amount: 10, reason: undefined as unknown as string })).rejects.toThrow('A reason is required');
        expect(h.queries).toHaveLength(0);
        expect(h.rpcs).toHaveLength(0);
    });

    it('inserts pending, approves through the locked RPC, re-reads the entry, then broadcasts', async () => {
        on('treasury_ledger_entries', { data: { id: 'a1' }, error: null }, { op: 'insert' });
        onRpc('finance_approve_entry', { data: 1, error: null });
        on('treasury_ledger_entries', { data: ledgerRow('a1', { entry_type: 'adjustment', amount: -40, status: 'confirmed', notes: 'seed\n[rejected] stale' }), error: null });
        const out = await recordAdjustment(9, { accountId: 3, amount: -40.8, reason: '  seed  ' });

        const ins = queriesOf('treasury_ledger_entries', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual({
            account_id: 3, entry_type: 'adjustment', amount: -40, status: 'pending', notes: 'seed',
            counterparty_text: null, created_by_user_id: 9,
        });
        expect(selectOf(ins)).toBe('id');
        expect(h.rpcs).toEqual([{ name: 'finance_approve_entry', args: { p_entry_id: 'a1', p_approver_id: 9 } }]);
        const reread = queriesOf('treasury_ledger_entries', 'select')[0];
        expect(allArgs(reread, 'eq')).toEqual([['id', 'a1']]);
        // The re-read goes through the default (non-approver) viewer: any legacy tail is cut.
        expect(out).toMatchObject({ id: 'a1', amount: -40, status: 'confirmed', notes: 'seed' });
        expect(h.broadcasts).toEqual([
            { event: 'finances:ledger_update', payload: { entryId: 'a1' } },
            { event: 'finances:account_update', payload: { accountId: 3 } },
        ]);
    });

    it('passes counterpartyText through', async () => {
        on('treasury_ledger_entries', { data: { id: 'a2' }, error: null }, { op: 'insert' });
        on('treasury_ledger_entries', { data: ledgerRow('a2'), error: null });
        await recordAdjustment(9, { accountId: 3, amount: 5, reason: 'r', counterpartyText: 'payout to X' });
        expect((argsOf(queriesOf('treasury_ledger_entries', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).counterparty_text).toBe('payout to X');
    });

    it('stops at an insert error / empty insert without approving anything', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert', once: true });
        await expect(recordAdjustment(9, { accountId: 3, amount: 5, reason: 'r' })).rejects.toThrow('Failed to create adjustment');
        on('treasury_ledger_entries', { data: null, error: null }, { op: 'insert', once: true });
        await expect(recordAdjustment(9, { accountId: 3, amount: 5, reason: 'r' })).rejects.toThrow('Adjustment insert returned no row.');
        expect(h.rpcs).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('throws when the approve RPC fails, and when the entry vanished after creation — no broadcasts', async () => {
        on('treasury_ledger_entries', { data: { id: 'a3' }, error: null }, { op: 'insert' });
        onRpc('finance_approve_entry', { data: null, error: { code: 'P0001', message: 'x' } }, true);
        await expect(recordAdjustment(9, { accountId: 3, amount: 5, reason: 'r' })).rejects.toThrow('Failed to apply adjustment');
        on('treasury_ledger_entries', { data: null, error: null }, { op: 'select' });
        await expect(recordAdjustment(9, { accountId: 3, amount: 5, reason: 'r' })).rejects.toThrow('Adjustment disappeared after creation.');
        expect(h.broadcasts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

describe('getFinancesOverview', () => {
    it('combines accounts, the SQL aggregate (nulls read as 0) and the 10 most recent entries', async () => {
        on('treasury_accounts', { data: [accountRow()], error: null });
        on('treasury_ledger_entries', { data: [ledgerRow('e1')], error: null });
        onRpc('finance_overview_stats', { data: [{ total_balance: '900', pending_deposits_count: null, pending_deposits_amount: undefined, pending_withdrawals_count: 2, pending_withdrawals_amount: '75', thirty_day_net: null }], error: null });
        const out = await getFinancesOverview();
        expect(out).toMatchObject({
            totalBalance: 900, pendingDepositsCount: 0, pendingDepositsAmount: 0,
            pendingWithdrawalsCount: 2, pendingWithdrawalsAmount: 75, thirtyDayNet: 0,
        });
        expect(out.accounts.map(a => a.id)).toEqual([3]);
        expect(out.recentEntries.map(e => e.id)).toEqual(['e1']);
        expect(argsOf(queriesOf('treasury_ledger_entries')[0], 'limit')).toEqual([10]);
        expect(h.rpcs.map(r => r.name)).toEqual(['finance_overview_stats']);
    });

    it('throws on an aggregate error rather than rendering a zero treasury', async () => {
        onRpc('finance_overview_stats', { data: null, error: { code: '42883', message: 'function missing' } });
        await expect(getFinancesOverview()).rejects.toThrow('Failed to load finance overview');
    });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('csvEscape — boundary values', () => {
    it('renders null/undefined as empty and stringifies numbers', () => {
        expect(csvEscape(null)).toBe('');
        expect(csvEscape(undefined)).toBe('');
        expect(csvEscape(42)).toBe('42');
        // A negative number would be formula-like; it is neutralised like any other leading '-'.
        expect(csvEscape(-42)).toBe("'-42");
    });

    it('neutralises a formula AND quote-wraps when the cell also contains a delimiter', () => {
        expect(csvEscape('=SUM(A1,A2)')).toBe(`"'=SUM(A1,A2)"`);
        expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    });
});

describe('exportLedgerCsv', () => {
    const HEADER = 'created_at,account_id,entry_type,amount,status,memo,counterparty_name,counterparty_text,created_by,approved_by,approved_at,notes,entry_id';

    /** Serves `rows` honouring limit/range, but never more than `maxPerResponse` (PostgREST db-max-rows). */
    const serveLedger = (rows: Array<Record<string, unknown>>, maxPerResponse = Infinity) => {
        on('treasury_ledger_entries', (q) => {
            const range = argsOf(q, 'range') as [number, number] | undefined;
            const limit = Number(argsOf(q, 'limit')?.[0] ?? rows.length);
            const start = range ? range[0] : 0;
            const count = Math.min(limit, maxPerResponse);
            return { data: rows.slice(start, start + count), error: null };
        });
    };

    it('writes only the header when the ledger is not migrated (42P01)', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '42P01', message: 'missing' } });
        expect(await exportLedgerCsv()).toBe(HEADER);
    });

    it('writes only the header when the first page comes back empty (errorless null)', async () => {
        on('treasury_ledger_entries', { data: null, error: null });
        expect(await exportLedgerCsv()).toBe(HEADER);
        expect(queriesOf('treasury_ledger_entries')).toHaveLength(1);
    });

    it('throws on any other read error rather than producing a silently partial file', async () => {
        on('treasury_ledger_entries', { data: null, error: { code: '57014', message: 'timeout' } });
        await expect(exportLedgerCsv()).rejects.toThrow('Failed to load ledger for export');
    });

    it('advances by rows RECEIVED when the server short-pages, and re-applies the filters on every page', async () => {
        const rows = Array.from({ length: 5 }, (_, i) => ledgerRow(`e${i}`, { created_at: `2026-02-0${i + 1}T00:00:00Z` }));
        serveLedger(rows, 2);
        const lines = (await exportLedgerCsv({ accountId: 3, status: 'confirmed' })).split('\n');
        expect(lines).toHaveLength(6);
        expect(lines.slice(1).map(l => l.split(',')[12])).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
        const pages = queriesOf('treasury_ledger_entries');
        // Page one has no range; the rest start exactly where the received rows ended.
        expect(pages.map(q => argsOf(q, 'range'))).toEqual([undefined, [2, 501], [4, 503], [5, 504]]);
        expect(pages.every(q => allArgs(q, 'eq').some(a => a[0] === 'account_id' && a[1] === 3))).toBe(true);
        expect(pages.every(q => allArgs(q, 'eq').some(a => a[0] === 'status' && a[1] === 'confirmed'))).toBe(true);
    });

    it('renders names from the embeds, falling back to the creator id and blanks', async () => {
        serveLedger([
            ledgerRow('e1', { counterparty_text: 'alt', notes: 'hello' }),
            ledgerRow('e2', { counterparty: null, created_by: null, approved_by: null, approved_at: null, memo: null }),
        ]);
        const [header, first, second] = (await exportLedgerCsv()).split('\n');
        expect(header).toBe(HEADER);
        expect(first).toBe('2026-02-01T00:00:00Z,3,deposit,250,confirmed,REF-1,Pilot Seven,alt,Pilot Seven,Treasurer Nine,2026-02-02T00:00:00Z,hello,e1');
        expect(second).toBe('2026-02-01T00:00:00Z,3,deposit,250,confirmed,,,,7,,,,e2');
    });

    it('an exactly-full export (rows == limit) carries NO truncation notice', async () => {
        serveLedger([ledgerRow('e1'), ledgerRow('e2'), ledgerRow('e3')]);
        const lines = (await exportLedgerCsv({ limit: 3 })).split('\n');
        expect(lines).toHaveLength(4);
        expect(lines.join('\n')).not.toContain('TRUNCATED');
        // It asked for one row past the ceiling to tell "full" from "more".
        expect(argsOf(queriesOf('treasury_ledger_entries')[0], 'limit')).toEqual([4]);
        expect(h.warns).toHaveLength(0);
    });

    it('a truncated export names the cutoff, logs a warning, and says "unknown" when the oldest row has no timestamp', async () => {
        serveLedger([ledgerRow('e1'), ledgerRow('e2', { created_at: null }), ledgerRow('e3')]);
        const lines = (await exportLedgerCsv({ limit: 2 })).split('\n');
        expect(lines).toHaveLength(4);
        expect(lines[3]).toContain('only the 2 most recent matching entries (ceiling 2)');
        expect(lines[3]).toContain('Entries older than unknown are NOT included');
        expect(h.warns.some(w => /row ceiling/.test(String(w[0])) && (w[1] as Record<string, unknown>).exported === 2)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconcileBalances', () => {
    it('maps the drift rows from finance_reconcile_balances, coercing numerics', async () => {
        onRpc('finance_reconcile_balances', { data: [{ account_id: 3, cached: '100', computed: '120', delta: '20' }], error: null });
        expect(await reconcileBalances()).toEqual([{ accountId: 3, cached: 100, computed: 120, delta: 20 }]);
        expect(h.rpcs).toEqual([{ name: 'finance_reconcile_balances', args: undefined }]);
    });

    it('returns [] before migration (42P01) or on an empty answer, and throws on any other error', async () => {
        onRpc('finance_reconcile_balances', { data: null, error: { code: '42P01', message: 'missing' } }, true);
        expect(await reconcileBalances()).toEqual([]);
        onRpc('finance_reconcile_balances', { data: null, error: null }, true);
        expect(await reconcileBalances()).toEqual([]);
        onRpc('finance_reconcile_balances', { data: null, error: { code: '42883', message: 'x' } }, true);
        await expect(reconcileBalances()).rejects.toThrow('Failed to reconcile balances');
    });
});
