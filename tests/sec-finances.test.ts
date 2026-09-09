import { describe, it, expect, vi, beforeEach } from 'vitest';

// FINANCES — CSV export integrity. Two independent contracts:
//
// 1. Formula-injection neutralization. exportLedgerCsv emits attacker-controlled
//    memo / counterparty_text / notes (stored verbatim by submitDeposit /
//    submitWithdrawal / recordAdjustment) into a downloadable CSV. A cell
//    beginning with = + - @ (or a leading TAB/CR) is auto-evaluated as a formula
//    by Excel / LibreOffice / Sheets, so an officer who merely opens the export
//    executes the attacker's payload. csvEscape must neutralize the trigger by
//    prefixing a single quote (literal-text marker) while preserving the
//    existing RFC-4180 quote-wrapping for delimiter-bearing cells.
//
// 2. Completeness. The export used to delegate to listLedgerEntries with
//    limit 5000, which that function silently clamped to 500 — an "audit export"
//    of a 3000-entry ledger was quietly the newest 500 rows with nothing in the
//    file saying so, and the client toasted "Export ready" regardless. It now
//    pages (advancing by rows RECEIVED, so PostgREST's own server-side max-rows
//    cannot shorten it either) and, when it does reach its ceiling, says so in
//    the file.

const h = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
    /** When true every page returns `rows` — a ledger that never runs out. */
    infinite: false,
    pageCalls: 0,
    /** Chained-method log per settled query, in call order. */
    queries: [] as Array<Array<{ method: string; args: unknown[] }>>,
}));

vi.mock('../lib/db/common', () => {
    const builder = () => {
        // Thenable query builder that HONOURS .limit()/.range(), so `h.rows` is a
        // real ledger the caller has to page through rather than one magic page —
        // without that the 500-row clamp this suite exists to catch is invisible.
        // h.infinite serves the same window every time, modelling a ledger deeper
        // than the export ceiling.
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        const self = (m: string) => (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'range']) b[m] = self(m);
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown, reject: (e: unknown) => unknown) => {
            h.queries.push(calls);
            h.pageCalls++;
            const limitCall = calls.find(c => c.method === 'limit');
            const rangeCall = calls.find(c => c.method === 'range');
            const limit = limitCall ? Number(limitCall.args[0]) : h.rows.length;
            const from = !h.infinite && rangeCall ? Number(rangeCall.args[0]) : 0;
            const page = h.rows.slice(from, from + limit);
            return Promise.resolve({ data: page, error: null }).then(resolve, reject);
        };
        return b;
    };
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import { csvEscape, exportLedgerCsv } from '../lib/db/finances';

beforeEach(() => { h.rows = []; h.infinite = false; h.pageCalls = 0; h.queries = []; });

/** Minimal ledger row in the shape LEDGER_SELECT returns. */
const ledgerRow = (n: number) => ({
    id: `e${n}`, account_id: 1, entry_type: 'deposit', amount: n, status: 'confirmed',
    memo: `entry ${n}`, counterparty_user_id: null, counterparty: null, counterparty_text: null,
    operation_id: null, related_inventory_id: null, related_entry_id: null, transfer_group_id: null,
    created_by_user_id: 7, created_by: null, approved_by_user_id: null, approved_by: null,
    approved_at: null, notes: null,
    // Descending, so row 0 is the newest.
    created_at: new Date(Date.UTC(2026, 0, 1) - n * 86_400_000).toISOString(),
    updated_at: '2026-06-01T00:00:00Z',
});

describe('csvEscape — formula-injection neutralization', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
        it(`prefixes a literal-text quote for a cell starting with ${JSON.stringify(lead)}`, () => {
            // Output may additionally be RFC-4180 quote-wrapped (e.g. for \r), so
            // accept an optional leading double-quote before the apostrophe.
            expect(csvEscape(lead + 'cmd|calc')).toMatch(/^"?'/);
        });
    }

    it('neutralizes the classic =HYPERLINK / =cmd payload so it is not formula-evaluated', () => {
        const payload = '=HYPERLINK("http://evil","click")';
        const out = csvEscape(payload);
        // The cell no longer begins with a char a spreadsheet auto-evaluates.
        expect(out.startsWith('=')).toBe(false);
        // Quote-wrapped (it contains quotes) AND carries the leading apostrophe.
        expect(out).toBe('"\'' + payload.replace(/"/g, '""') + '"');
    });

    it('preserves RFC-4180 quote-wrapping for delimiter-bearing values (no spurious change)', () => {
        expect(csvEscape('a,b')).toBe('"a,b"');
        expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
        expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    });

    it('leaves benign values untouched', () => {
        expect(csvEscape('Treasury deposit')).toBe('Treasury deposit');
        expect(csvEscape(1234)).toBe('1234');
        expect(csvEscape(null)).toBe('');
        expect(csvEscape(undefined)).toBe('');
    });
});

describe('exportLedgerCsv — output-side neutralization end to end', () => {
    it('neutralizes a formula-bearing memo / counterparty_text / notes in the exported CSV', async () => {
        h.rows = [{
            id: 'e1', account_id: 1, entry_type: 'deposit', amount: 100, status: 'confirmed',
            memo: '=cmd|"/c calc"!A1',
            counterparty_user_id: null, counterparty: null,
            counterparty_text: '+SUM(1+1)',
            operation_id: null, related_inventory_id: null, related_entry_id: null,
            transfer_group_id: null,
            created_by_user_id: 7, created_by: null,
            approved_by_user_id: null, approved_by: null, approved_at: null,
            notes: '-2-3', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
        }];

        const csv = await exportLedgerCsv();
        const dataLine = csv.split('\n')[1];

        // No attacker field survives as a raw, comma-adjacent formula trigger.
        expect(dataLine).not.toContain(',=cmd');
        expect(dataLine).not.toContain(',+SUM');
        expect(dataLine).not.toContain(',-2-3');
        // Each neutralized cell carries the literal-text apostrophe.
        expect(csv).toContain("'=cmd");
        expect(csv).toContain("'+SUM(1+1)");
        expect(csv).toContain("'-2-3");
    });
});

describe('exportLedgerCsv — a partial export must never look complete', () => {
    it('pages past the 500-row list clamp instead of silently truncating', async () => {
        // Before the fix the same 600-row ledger produced 501 lines: the export
        // asked listLedgerEntries for 5000 and got the newest 500 back.
        h.rows = Array.from({ length: 600 }, (_, i) => ledgerRow(i));
        const csv = await exportLedgerCsv();
        expect(csv.split('\n')).toHaveLength(601); // header + 600
        expect(csv).not.toContain('** TRUNCATED');
    });

    it('appends a full-width TRUNCATED notice row when the export ceiling is reached', async () => {
        h.rows = Array.from({ length: 6 }, (_, i) => ledgerRow(i));
        h.infinite = true; // a ledger deeper than the ceiling
        const lines = (await exportLedgerCsv({ limit: 10 })).split('\n');
        const headerCols = lines[0].split(',').length;
        const notice = lines[lines.length - 1];

        expect(notice).toMatch(/^"?\*\* TRUNCATED/);
        expect(notice).toContain('ceiling 10');
        expect(notice).toContain('the 10 most recent');
        // Names the oldest row that DID make the file, so the auditor knows where
        // the window stops. (created_at is the first CSV column.)
        const oldestIncluded = lines[lines.length - 2].split(',')[0];
        expect(notice).toContain(`older than ${oldestIncluded}`);
        // Rectangular: one populated cell + the rest empty, so a spreadsheet
        // import keeps its column count.
        expect(notice.split(',').length).toBe(headerCols);
        // Rows 1..N stay a clean, parseable ledger — the notice is LAST.
        expect(lines).toHaveLength(12); // header + 10 entries + notice
    });

    it('ignores a caller-supplied offset — an export always starts at the newest entry', async () => {
        h.rows = [ledgerRow(0), ledgerRow(1)];
        const lines = (await exportLedgerCsv({ offset: 400 })).split('\n');
        expect(lines[1]).toContain('e0');
        // A stale client offset must not behead the file: no .range() is issued.
        expect(h.queries[0].some(c => c.method === 'range')).toBe(false);
    });

    it('clamps the export ceiling to MAX_LEDGER_EXPORT_LIMIT', async () => {
        h.rows = Array.from({ length: 600 }, (_, i) => ledgerRow(i));
        h.infinite = true;
        const lines = (await exportLedgerCsv({ limit: 999_999 })).split('\n');
        expect(lines[lines.length - 1]).toContain('ceiling 5000');
        expect(lines).toHaveLength(5002); // header + 5000 entries + notice
    });

    it('treats a non-positive limit as "the whole window", not a one-row file', async () => {
        h.rows = Array.from({ length: 600 }, (_, i) => ledgerRow(i));
        const csv = await exportLedgerCsv({ limit: -5 });
        expect(csv.split('\n')).toHaveLength(601);
        expect(csv).not.toContain('** TRUNCATED');
    });
});
