import { describe, it, expect, vi, beforeEach } from 'vitest';

// WAREHOUSE — CSV formula-injection neutralization.
//
// warehouse:export_csv (exportWarehouseCsv) ships RAW row objects to the browser,
// which assembles the download in WhStockTab.handleStartCsvExport. The client
// csvEscape only RFC-4180 quote-wraps and OMITS formula-injection neutralization,
// so an operator-controlled commodity/quality/category/unit/location/notes value
// beginning with = + - @ (or a leading TAB/CR) is auto-evaluated as a formula by
// Excel/LibreOffice/Sheets when the export is opened. exportWarehouseCsv is the
// server-side output boundary (lib/db), so it must neutralize the trigger by
// prefixing a literal-text apostrophe before returning the rows, while
// leaving benign values byte-for-byte unchanged (the client still quote-wraps, so
// the server must NOT also wrap — that would double-wrap delimiter-bearing cells).

const h = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/db/common', () => {
    const builder = () => {
        // Minimal thenable query builder: every chained filter/order/range returns
        // `b`, and awaiting it resolves to the seeded rows (and a matching count so
        // the head-count query in listWarehouseStockCount also resolves cleanly).
        const b: Record<string, unknown> = {};
        const self = () => b;
        b.select = self; b.eq = self; b.is = self; b.order = self; b.limit = self; b.range = self;
        b.then = (resolve: (v: { data: unknown; count: number; error: null }) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: h.rows, count: h.rows.length, error: null }).then(resolve, reject);
        return b;
    };
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import { exportWarehouseCsv } from '../lib/db/warehouse';

// Build a v_warehouse_stock_with_qty row in the shape toStock() consumes.
function stockRow(over: { name?: string; quality?: string; category?: string; unit?: string; location?: string; notes?: string }) {
    return {
        id: 's1', catalog_id: 1, location_id: 1,
        notes: over.notes ?? '',
        created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
        quantity_on_hand: 10, quantity_reserved: 2,
        catalog: {
            id: 1, name: over.name ?? 'Titanium', category: over.category ?? 'ore',
            quality_label: over.quality ?? 'Refined', unit: over.unit ?? 'SCU',
            description: null, archived_at: null,
            created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
        },
        location: { id: 1, name: over.location ?? 'Hangar A', type: 'hangar' },
    };
}

beforeEach(() => { h.rows = []; });

describe('exportWarehouseCsv — formula-injection neutralization', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
        it(`prefixes a literal-text apostrophe for notes/commodity starting with ${JSON.stringify(lead)}`, async () => {
            h.rows = [stockRow({ name: lead + 'cmd', notes: lead + 'SUM(1+1)' })];
            const page = await exportWarehouseCsv();
            expect(page.rows[0].commodity).toBe("'" + lead + 'cmd');
            expect(page.rows[0].notes).toBe("'" + lead + 'SUM(1+1)');
            // The returned cell no longer begins with a spreadsheet-evaluated char.
            expect(/^[=+\-@\t\r]/.test(page.rows[0].commodity)).toBe(false);
            expect(/^[=+\-@\t\r]/.test(page.rows[0].notes)).toBe(false);
        });
    }

    it('neutralizes a classic =HYPERLINK payload in any operator-controlled field', async () => {
        const payload = '=HYPERLINK("http://evil","click")';
        h.rows = [stockRow({ name: payload, quality: payload, category: payload, unit: payload, location: payload, notes: payload })];
        const r = (await exportWarehouseCsv()).rows[0];
        for (const field of [r.commodity, r.quality, r.category, r.unit, r.location, r.notes]) {
            expect(field).toBe("'" + payload);
            expect(field.startsWith('=')).toBe(false);
        }
    });

    it('leaves benign values byte-for-byte unchanged (no spurious apostrophe, no double quote-wrapping)', async () => {
        h.rows = [stockRow({ name: 'Titanium', quality: 'Refined', category: 'ore', unit: 'SCU', location: 'Hangar A', notes: 'damaged, repack' })];
        const r = (await exportWarehouseCsv()).rows[0];
        expect(r.commodity).toBe('Titanium');
        expect(r.quality).toBe('Refined');
        expect(r.category).toBe('ore');
        expect(r.unit).toBe('SCU');
        expect(r.location).toBe('Hangar A');
        // Delimiter-bearing notes must NOT be quote-wrapped here — the client
        // assembler does RFC-4180 wrapping; wrapping again would corrupt it.
        expect(r.notes).toBe('damaged, repack');
        expect(r.onHand).toBe(10);
        expect(r.reserved).toBe(2);
    });
});
