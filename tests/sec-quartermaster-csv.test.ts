import { describe, it, expect, vi, beforeEach } from 'vitest';

// QUARTERMASTER — CSV formula-injection neutralization.
//
// exportInventoryCsv emits attacker-controlled `name` (custom_name) and `notes`
// columns — stored verbatim by createInventoryItem / updateInventoryItem (no
// stripHtml / textSanitize) — into a downloadable CSV. A cell beginning with
// = + - @ (or a leading TAB/CR) is auto-evaluated as a formula by Excel /
// LibreOffice / Sheets, so a quartermaster who merely opens the export executes
// the attacker's payload. The QM exporter had its OWN copy of csvEscape that
// performed only RFC-4180 quote-wrapping and OMITTED the neutralization that
// finances.ts csvEscape performs. This version prefixes a single quote
// (literal-text marker) for a leading trigger while preserving the existing
// RFC-4180 quote-wrapping for delimiter-bearing cells.

const h = vi.hoisted(() => ({
    inventory: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/db/common', () => {
    const makeBuilder = (rows: unknown) => {
        // Minimal thenable query builder: every chained filter/order returns the
        // same object, and awaiting it resolves to the per-table seed.
        const b: Record<string, unknown> = {};
        const self = () => b;
        b.select = self; b.eq = self; b.in = self; b.ilike = self;
        b.order = self; b.range = self; b.lt = self; b.not = self; b.limit = self;
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        return b;
    };
    return {
        // Inventory query returns the crafted rows; movement/issuance aggregates
        // resolve empty (quantities are irrelevant to the escaping assertion).
        supabase: { from: (table: string) => makeBuilder(table === 'quartermaster_inventory' ? h.inventory : []) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import { csvEscapeQm as csvEscape, exportInventoryCsv } from '../lib/db/quartermaster';

beforeEach(() => { h.inventory = []; });

describe('csvEscape — formula-injection neutralization (quartermaster)', () => {
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

    it('neutralizes a bare =cmd payload', () => {
        expect(csvEscape('=cmd|"/c calc"!A1')).toMatch(/^"?'=cmd/);
    });

    it('preserves RFC-4180 quote-wrapping for delimiter-bearing values (no spurious change)', () => {
        expect(csvEscape('a,b')).toBe('"a,b"');
        expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
        expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    });

    it('leaves benign values untouched', () => {
        expect(csvEscape('Ballistic Rifle')).toBe('Ballistic Rifle');
        expect(csvEscape(1234)).toBe('1234');
        expect(csvEscape(null)).toBe('');
        expect(csvEscape(undefined)).toBe('');
    });
});

describe('exportInventoryCsv — output-side neutralization end to end', () => {
    it('neutralizes a formula-bearing custom name and notes in the exported CSV', async () => {
        h.inventory = [{
            id: 1,
            catalog_id: null,
            catalog: null,
            custom_name: '=cmd|"/c calc"!A1',
            location_id: null,
            location: null,
            condition: 'pristine',
            acquired_at: '2026-06-01T00:00:00Z',
            notes: '+SUM(1+1)',
            is_archived: false,
            quantity_on_hand: 0,
            quantity_on_issue: 0,
            created_at: '2026-06-01T00:00:00Z',
            updated_at: '2026-06-01T00:00:00Z',
        }];

        const csv = await exportInventoryCsv();
        const dataLine = csv.split('\n')[1];

        // No attacker field survives as a raw, comma-adjacent formula trigger.
        expect(dataLine).not.toContain(',=cmd');
        expect(dataLine).not.toContain(',+SUM');
        // Each neutralized cell carries the literal-text apostrophe.
        expect(csv).toContain("'=cmd");
        expect(csv).toContain("'+SUM(1+1)");
    });

    it('neutralizes a formula-bearing catalog name in the exported CSV', async () => {
        h.inventory = [{
            id: 2,
            catalog_id: 9,
            catalog: {
                id: 9,
                slug: 'evil',
                name: '=HYPERLINK("http://evil","pwn")',
                category: 'weapon',
                subcategory: null,
                thumbnail_url: null,
            },
            custom_name: null,
            location_id: null,
            location: null,
            condition: 'pristine',
            acquired_at: '2026-06-01T00:00:00Z',
            notes: null,
            is_archived: false,
            quantity_on_hand: 5,
            quantity_on_issue: 0,
            created_at: '2026-06-01T00:00:00Z',
            updated_at: '2026-06-01T00:00:00Z',
        }];

        const csv = await exportInventoryCsv();
        const dataLine = csv.split('\n')[1];

        // The catalog name column is no longer a raw, comma-adjacent =HYPERLINK.
        expect(dataLine).not.toContain(',=HYPERLINK');
        expect(dataLine).not.toContain('",=HYPERLINK');
        expect(csv).toContain("'=HYPERLINK");
    });
});
