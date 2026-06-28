import { describe, it, expect, vi, beforeEach } from 'vitest';

// FINANCES — CSV formula-injection neutralization.
//
// exportLedgerCsv emits attacker-controlled memo / counterparty_text / notes
// (stored verbatim by submitDeposit / submitWithdrawal / recordAdjustment) into
// a downloadable CSV. A cell beginning with = + - @ (or a leading TAB/CR) is
// auto-evaluated as a formula by Excel / LibreOffice / Sheets, so an officer who
// merely opens the export executes the attacker's payload. csvEscape must
// neutralize the trigger by prefixing a single quote (literal-text marker) while
// preserving the existing RFC-4180 quote-wrapping for delimiter-bearing cells.

const h = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/db/common', () => {
    const builder = () => {
        // Minimal thenable query builder: every chained filter/order returns
        // `b`, and awaiting it resolves to the seeded rows.
        const b: Record<string, unknown> = {};
        const self = () => b;
        b.select = self; b.eq = self; b.gte = self; b.lte = self;
        b.order = self; b.limit = self; b.range = self;
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: h.rows, error: null }).then(resolve, reject);
        return b;
    };
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import { csvEscape, exportLedgerCsv } from '../lib/db/finances';

beforeEach(() => { h.rows = []; });

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
