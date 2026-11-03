import { describe, it, expect, vi, beforeEach } from 'vitest';

// FINANCES — an officer's REJECTION REASON is APPROVER-ONLY.
//
// finance_reject_entry used to append '\n[rejected] <reason>' into
// treasury_ledger_entries.notes, and finance:view (the gate on every ledger read, a
// member default) renders notes in the ledger tab and the CSV export — so every member
// read officer-authored free text about another member's finances. The reason now has
// its own column (schema.sql §3.10, pinned by tests/sec-schema-rls.test.ts) and every
// read path returns it only to a finance:approve holder.
//
// What this file pins, on every ledger read path (list, detail/slice, CSV export,
// overview) and through the RPC handlers:
//   * a non-approver never receives the reason — not the field, not a '[rejected]'
//     tail in notes (the legacy shape a not-yet-migrated database still carries), and
//     the rejection_reason column is never even selected for them;
//   * an approver does receive it, and on a database without the column the read
//     degrades to "no field" instead of failing;
//   * the approver decision comes from the server-injected user record, never from a
//     client-settable payload field.

const MARKER = '\n[rejected] ';

const h = vi.hoisted(() => ({
    /** Rows the base LEDGER_SELECT read returns. */
    rows: [] as Array<Record<string, unknown>>,
    /** rejection_reason by entry id, served to the follow-up reason read. */
    reasons: {} as Record<string, string | null>,
    /** Error the reason read returns instead of data (e.g. a 42703 on an old database). */
    reasonError: null as null | { code?: string; message: string },
    /** Every query's chained-call log, in settle order. */
    queries: [] as Array<Array<{ method: string; args: unknown[] }>>,
    /** Every supabase.rpc call, by name. */
    rpcs: [] as Array<{ name: string; args: unknown }>,
    /** Every createNotification(recipient, notification) the handlers made. */
    notifications: [] as Array<{ userId: number; n: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    const builder = () => {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        const self = (m: string) => (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'range']) b[m] = self(m);
        const settle = (single: boolean) => {
            h.queries.push(calls);
            const sel = String(calls.find(c => c.method === 'select')?.args[0] ?? '');
            if (/rejection_reason/.test(sel)) {
                if (h.reasonError) return { data: null, error: h.reasonError };
                const ids = (calls.find(c => c.method === 'in')?.args[1] ?? []) as string[];
                return { data: ids.filter(id => id in h.reasons).map(id => ({ id, rejection_reason: h.reasons[id] })), error: null };
            }
            const idEq = calls.find(c => c.method === 'eq' && c.args[0] === 'id');
            const matched = idEq ? h.rows.filter(r => r.id === idEq.args[1]) : h.rows;
            if (single) return { data: matched[0] ?? null, error: null };
            const limitCall = calls.find(c => c.method === 'limit');
            return { data: limitCall ? matched.slice(0, Number(limitCall.args[0])) : matched, error: null };
        };
        b.maybeSingle = () => Promise.resolve(settle(true));
        b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(settle(false)).then(resolve, reject);
        return b;
    };
    return {
        supabase: {
            from: () => builder(),
            rpc: async (name: string, args: unknown) => {
                h.rpcs.push({ name, args });
                // finance_reject_entry returns the number of rows it rejected.
                if (name === 'finance_reject_entry') return { data: 1, error: null };
                return { data: [{
                    total_balance: 0, pending_deposits_count: 0, pending_deposits_amount: 0,
                    pending_withdrawals_count: 0, pending_withdrawals_amount: 0, thirty_day_net: 0,
                }],
                error: null };
            },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

// The RPC handlers import the lib/db barrel; serve them the REAL finance module (over
// the mocked common above) so the handler→db wiring is exercised end to end.
vi.mock('../lib/db', async () => ({
    ...(await import('../lib/db/finances')),
    createNotification: async (userId: number, n: Record<string, unknown>) => { h.notifications.push({ userId, n }); },
}));
vi.mock('../lib/push', () => ({ sendPushToPermission: async () => {} }));

import {
    ledgerViewerFor, stripLegacyRejectionSuffix, redactLedgerEntryForViewer,
    listLedgerEntries, getLedgerEntry, exportLedgerCsv, getFinancesOverview,
} from '../lib/db/finances';
import { financesActions } from '../api/actions/finances';
import type { LedgerEntry } from '../types';

const APPROVER = ledgerViewerFor(['finance:view', 'finance:approve']);
const MEMBER = ledgerViewerFor(['finance:view', 'finance:deposit', 'finance:withdraw_request']);

const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, account_id: 1, entry_type: 'withdrawal', amount: -100, status: 'rejected',
    memo: null, counterparty_user_id: 7, counterparty: null, counterparty_text: null,
    operation_id: null, related_inventory_id: null, related_entry_id: null, transfer_group_id: null,
    created_by_user_id: 7, created_by: null, approved_by_user_id: 9, approved_by: null,
    approved_at: '2026-06-02T00:00:00Z', notes: 'fuel for the Carrack',
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-02T00:00:00Z',
    ...over,
});

const SECRET = 'member is suspected of skimming';

/** Asserts nothing in `value` carries the reason: no key, no marker, no reason text. */
function expectNoReason(value: unknown) {
    const json = JSON.stringify(value);
    expect(json).not.toContain('rejectionReason');
    expect(json).not.toContain('[rejected]');
    expect(json).not.toContain(SECRET);
}

/** True when any settled query selected the rejection_reason column. */
const reasonColumnQueried = () =>
    h.queries.some(q => q.some(c => c.method === 'select' && /rejection_reason/.test(String(c.args[0]))));

beforeEach(() => {
    h.rows = [];
    h.reasons = {};
    h.reasonError = null;
    h.queries = [];
    h.rpcs = [];
    h.notifications = [];
});

describe('ledgerViewerFor — the approver decision', () => {
    it('is exactly finance:approve, the permission that gates finance:reject_entry', () => {
        expect(ledgerViewerFor(['finance:approve']).canSeeRejectionReason).toBe(true);
        expect(ledgerViewerFor(['finance:view']).canSeeRejectionReason).toBe(false);
        // finance:manage does not imply approve in the dispatcher either.
        expect(ledgerViewerFor(['finance:view', 'finance:manage', 'finance:admin']).canSeeRejectionReason).toBe(false);
    });

    it('fails closed on a missing or malformed permission list', () => {
        expect(ledgerViewerFor(undefined).canSeeRejectionReason).toBe(false);
        expect(ledgerViewerFor(null).canSeeRejectionReason).toBe(false);
        expect(ledgerViewerFor([]).canSeeRejectionReason).toBe(false);
    });
});

describe('stripLegacyRejectionSuffix — the not-yet-migrated notes shape', () => {
    it('cuts the appended tail and keeps the submitter\'s own text', () => {
        expect(stripLegacyRejectionSuffix(`fuel for the Carrack${MARKER}${SECRET}`)).toBe('fuel for the Carrack');
    });

    it('turns a note that was only the tail into null (finance_reject_entry wrote it onto NULL notes)', () => {
        expect(stripLegacyRejectionSuffix(`${MARKER}${SECRET}`)).toBeNull();
        expect(stripLegacyRejectionSuffix(`[rejected] ${SECRET}`)).toBeNull();
    });

    it('cuts from the FIRST marker, so a reason containing a marker cannot survive', () => {
        expect(stripLegacyRejectionSuffix(`a${MARKER}b${MARKER}${SECRET}`)).toBe('a');
    });

    it('leaves ordinary notes (and empty / null) exactly as they were', () => {
        expect(stripLegacyRejectionSuffix('paid back [rejected] earlier claim')).toBe('paid back [rejected] earlier claim');
        expect(stripLegacyRejectionSuffix('')).toBe('');
        expect(stripLegacyRejectionSuffix(null)).toBeNull();
    });
});

describe('redactLedgerEntryForViewer', () => {
    const entry = {
        id: 'e1', notes: `x${MARKER}${SECRET}`, rejectionReason: SECRET,
    } as unknown as LedgerEntry;

    it('drops the field AND the inline tail for a non-approver', () => {
        const out = redactLedgerEntryForViewer(entry, MEMBER);
        expect('rejectionReason' in out).toBe(false);
        expect(out.notes).toBe('x');
        // Does not mutate the shared object.
        expect(entry.rejectionReason).toBe(SECRET);
    });

    it('returns the entry untouched for an approver', () => {
        expect(redactLedgerEntryForViewer(entry, APPROVER)).toBe(entry);
    });
});

describe('listLedgerEntries', () => {
    it('non-approver (and the default viewer): no reason field, no legacy tail, column never selected', async () => {
        h.rows = [row('e1', { notes: `fuel${MARKER}${SECRET}` }), row('e2', { notes: `${MARKER}${SECRET}` })];
        h.reasons = { e1: SECRET, e2: SECRET };
        for (const out of [await listLedgerEntries({}, MEMBER), await listLedgerEntries()]) {
            expectNoReason(out);
            expect(out.map(e => e.notes)).toEqual(['fuel', null]);
        }
        expect(reasonColumnQueried(), 'a non-approver read must not select rejection_reason').toBe(false);
    });

    it('approver: receives the reason from the column, for rejected rows only', async () => {
        h.rows = [row('e1'), row('e2', { status: 'confirmed' })];
        h.reasons = { e1: SECRET, e2: 'should never be asked for' };
        const out = await listLedgerEntries({}, APPROVER);
        expect(out[0].rejectionReason).toBe(SECRET);
        expect(out[0].notes).toBe('fuel for the Carrack');
        expect('rejectionReason' in out[1]).toBe(false);
        const reasonRead = h.queries.find(q => q.some(c => c.method === 'select' && /rejection_reason/.test(String(c.args[0]))));
        expect(reasonRead?.find(c => c.method === 'in')?.args[1]).toEqual(['e1']);
    });

    it('approver on a database without the column: degrades to no field, keeps the inline reason, does not throw', async () => {
        h.rows = [row('e1', { notes: `fuel${MARKER}${SECRET}` })];
        h.reasonError = { code: '42703', message: 'column treasury_ledger_entries.rejection_reason does not exist' };
        const out = await listLedgerEntries({}, APPROVER);
        expect('rejectionReason' in out[0]).toBe(false);
        expect(out[0].notes).toBe(`fuel${MARKER}${SECRET}`);
    });

    it('approver: any other reason-read fault throws rather than reading as "no reason given"', async () => {
        h.rows = [row('e1')];
        h.reasonError = { code: '08006', message: 'connection reset' };
        await expect(listLedgerEntries({}, APPROVER)).rejects.toThrow(/rejection reasons/);
    });

    it('approver: chunks the reason lookup so a full page cannot build an oversized URL', async () => {
        h.rows = Array.from({ length: 250 }, (_, i) => row(`e${i}`));
        h.reasons = Object.fromEntries(h.rows.map(r => [r.id as string, SECRET]));
        const out = await listLedgerEntries({ limit: 500 }, APPROVER);
        expect(out.every(e => e.rejectionReason === SECRET)).toBe(true);
        const chunks = h.queries
            .filter(q => q.some(c => c.method === 'select' && /rejection_reason/.test(String(c.args[0]))))
            .map(q => (q.find(c => c.method === 'in')?.args[1] as string[]).length);
        expect(chunks).toEqual([100, 100, 50]);
    });
});

describe('getLedgerEntry (detail + realtime slice)', () => {
    it('non-approver: redacted, including the legacy tail', async () => {
        h.rows = [row('e1', { notes: `fuel${MARKER}${SECRET}` })];
        h.reasons = { e1: SECRET };
        const out = await getLedgerEntry('e1', MEMBER);
        expectNoReason(out);
        expect(out?.notes).toBe('fuel');
        expectNoReason(await getLedgerEntry('e1'));
        expect(reasonColumnQueried()).toBe(false);
    });

    it('approver: carries the reason', async () => {
        h.rows = [row('e1')];
        h.reasons = { e1: SECRET };
        expect((await getLedgerEntry('e1', APPROVER))?.rejectionReason).toBe(SECRET);
    });

    it('still returns null for an absent entry', async () => {
        expect(await getLedgerEntry('missing', APPROVER)).toBeNull();
    });
});

describe('exportLedgerCsv', () => {
    it('non-approver: no rejection_reason column, no reason text, no legacy tail anywhere in the file', async () => {
        h.rows = [row('e1', { notes: `fuel${MARKER}${SECRET}` }), row('e2')];
        h.reasons = { e1: SECRET, e2: SECRET };
        for (const csv of [await exportLedgerCsv({}, MEMBER), await exportLedgerCsv()]) {
            expect(csv.split('\n')[0]).not.toContain('rejection_reason');
            expect(csv).not.toContain('[rejected]');
            expect(csv).not.toContain(SECRET);
            expect(csv).toContain(',fuel,');
        }
        expect(reasonColumnQueried()).toBe(false);
    });

    it('approver: gets a rejection_reason column, LAST, with the reason in it', async () => {
        h.rows = [row('e1')];
        h.reasons = { e1: SECRET };
        const [header, line] = (await exportLedgerCsv({}, APPROVER)).split('\n');
        const cols = header.split(',');
        expect(cols[cols.length - 1]).toBe('rejection_reason');
        expect(cols[cols.length - 2]).toBe('entry_id');
        expect(line.endsWith(`,e1,${SECRET}`)).toBe(true);
    });
});

describe('getFinancesOverview — recent entries', () => {
    it('redacts for a non-approver and carries the reason for an approver', async () => {
        h.rows = [row('e1', { notes: `fuel${MARKER}${SECRET}` })];
        h.reasons = { e1: SECRET };
        expectNoReason((await getFinancesOverview(MEMBER)).recentEntries);
        expectNoReason((await getFinancesOverview()).recentEntries);
        expect((await getFinancesOverview(APPROVER)).recentEntries[0].rejectionReason).toBe(SECRET);
    });
});

describe('RPC handlers decide from the injected user record', () => {
    const member = { permissions: ['finance:view'] };
    const approver = { permissions: ['finance:view', 'finance:approve'] };

    beforeEach(() => {
        h.rows = [row('e1', { notes: `fuel${MARKER}${SECRET}` })];
        h.reasons = { e1: SECRET };
    });

    it('finance:list_ledger', async () => {
        expectNoReason(await financesActions['finance:list_ledger']({ user: member }));
        const out = await financesActions['finance:list_ledger']({ user: approver });
        expect(out[0].rejectionReason).toBe(SECRET);
    });

    it('finance:get_entry', async () => {
        expectNoReason(await financesActions['finance:get_entry']({ user: member, entryId: 'e1' }));
        expect((await financesActions['finance:get_entry']({ user: approver, entryId: 'e1' }))?.rejectionReason).toBe(SECRET);
    });

    it('finance:get_overview (including a payload-less call)', async () => {
        expectNoReason(await financesActions['finance:get_overview']({ user: member }));
        expectNoReason(await financesActions['finance:get_overview']());
        expect((await financesActions['finance:get_overview']({ user: approver })).recentEntries[0].rejectionReason).toBe(SECRET);
    });

    it('finance:export_csv — and a client-sent flag in the payload buys nothing', async () => {
        // The export hands its whole payload through as filter opts, which is why the
        // viewer is a separate argument: these fields must be inert.
        const forged = {
            user: member, canSeeRejectionReason: true, includeRejectionReason: true, viewer: { canSeeRejectionReason: true },
        } as unknown as Parameters<typeof financesActions['finance:export_csv']>[0];
        const { csv } = await financesActions['finance:export_csv'](forged);
        expect(csv).not.toContain('rejection_reason');
        expect(csv).not.toContain(SECRET);
        expect(csv).not.toContain('[rejected]');
        expect((await financesActions['finance:export_csv']({ user: approver })).csv).toContain(SECRET);
    });
});

// The rejection NOTIFICATION. The reason never rode into it (an OS tray is not
// permission-gated), and since the ledger now shows the reason only to approvers the copy
// can no longer send the submitter to "the ledger for details": a non-approver submitter
// would find no reason there. It points them at a finance officer instead.
describe('finance:reject_entry — the submitter notification', () => {
    const REJECT_COPY = 'Your submitted entry was rejected. Contact a finance officer for details.';
    const reject = (userId: number) =>
        financesActions['finance:reject_entry']({ userId, entryId: 'e1', reason: SECRET });

    beforeEach(() => {
        h.rows = [row('e1', { status: 'pending', created_by_user_id: 7 })];
        h.reasons = { e1: SECRET };
    });

    it('tells the submitter to contact a finance officer, and never carries the reason', async () => {
        expect(await reject(9)).toEqual({ applied: true });
        // The reason did reach the database — it is the notification that must not carry it.
        expect(h.rpcs.find(r => r.name === 'finance_reject_entry')?.args).toMatchObject({ p_reason: SECRET });
        expect(h.notifications).toHaveLength(1);
        const [{ userId, n }] = h.notifications;
        expect(userId).toBe(7);
        expect(n.type).toBe('finance_rejected');
        expect(n.title).toBe('Your entry was rejected');
        expect(n.body).toBe(REJECT_COPY);
        expect(n.metadata).toEqual({ entryId: 'e1' });
        expectNoReason(n);
    });

    it('no longer points the submitter at the ledger, where a non-approver sees no reason', async () => {
        await reject(9);
        expect(String(h.notifications[0]?.n.body)).not.toMatch(/ledger/i);
    });

    it('an officer rejecting their own entry is not notified', async () => {
        await reject(7);
        expect(h.notifications).toHaveLength(0);
    });
});
