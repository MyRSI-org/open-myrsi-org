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
    // Every write/filter call the module makes, per table, so the write-time
    // normalisation tests can read back exactly what would have been stored.
    calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
    // Result for .single()/.maybeSingle(), keyed by table. An ARRAY is a queue —
    // one entry per call, in order (a lookup-then-insert on the same table).
    singles: {} as Record<string, unknown>,
}));

vi.mock('../lib/db/common', () => {
    const builder = (table: string) => {
        // Minimal thenable query builder: every chained filter/order/range returns
        // `b`, and awaiting it resolves to the seeded rows (and a matching count so
        // the head-count query in listWarehouseStockCount also resolves cleanly).
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'order', 'limit', 'range', 'insert', 'update']) {
            b[m] = (...args: unknown[]) => { h.calls.push({ table, method: m, args }); return b; };
        }
        const one = () => {
            const s = h.singles[table];
            return Promise.resolve({ data: (Array.isArray(s) ? s.shift() : s) ?? null, error: null });
        };
        b.single = one; b.maybeSingle = one;
        b.then = (resolve: (v: { data: unknown; count: number; error: null }) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: h.rows, count: h.rows.length, error: null }).then(resolve, reject);
        return b;
    };
    return {
        supabase: { from: (table: string) => builder(table) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import {
    exportWarehouseCsv, createWarehouseStock, createWarehouseCatalogItem, updateWarehouseCatalogItem,
} from '../lib/db/warehouse';
import { buildStockCsv, csvEscape } from '../components/views/warehouse/stockCsv';

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

beforeEach(() => { h.rows = []; h.calls = []; h.singles = {}; });

describe('exportWarehouseCsv — formula-injection neutralization', () => {
    // These pin the SERVER output only. On its own the '\r' case proved nothing:
    // "'\r..." still ends a spreadsheet row at the CR if the client leaves the cell
    // unquoted, so the end-to-end block below drives the real client escaper.
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

// -----------------------------------------------------------------------------
// End to end: server rows → the REAL client assembler (stockCsv.ts) → a parse with
// spreadsheet row semantics. This is the boundary that matters — what a member
// sees when they open the download.
// -----------------------------------------------------------------------------

// Minimal RFC-4180 reader with Excel/LibreOffice row rules: OUTSIDE quotes a bare
// CR, a bare LF or CRLF each end the row; INSIDE quotes they are cell content.
function parseLikeSpreadsheet(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else cell += ch;
        } else if (ch === '"' && cell === '') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(cell); cell = '';
        } else if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else {
            cell += ch;
        }
    }
    row.push(cell); rows.push(row);
    return rows;
}

// A cell a spreadsheet would evaluate: a trigger char first, or behind leading
// whitespace that a trimming importer drops.
const isLiveFormula = (cell: string) => /^\s*[=+\-@]/.test(cell);

async function exportedSheet(over: Parameters<typeof stockRow>[0]): Promise<string[][]> {
    h.rows = [stockRow(over)];
    const page = await exportWarehouseCsv();
    return parseLikeSpreadsheet(buildStockCsv(page.rows));
}

function expectOneSafeDataRow(sheet: string[][]) {
    // Header + exactly one data row of eight cells — nothing split off a new row.
    expect(sheet).toHaveLength(2);
    expect(sheet[1]).toHaveLength(8);
    for (const cell of sheet.flat()) expect(isLiveFormula(cell), JSON.stringify(cell)).toBe(false);
}

describe('warehouse stock CSV — end to end through the real client escaper', () => {
    const HYPERLINK = '=HYPERLINK("http://evil","click")';
    // The embedded-CR payloads carry NO comma or quote on purpose: either of those
    // already forces quoting, which would hide a quote set that is missing CR.
    const BARE_FORMULA = '=SUM(1+1)*cmd|calc';

    it('an EMBEDDED CR in notes stays inside one quoted cell (no new row, no live formula)', async () => {
        const notes = 'x\r' + BARE_FORMULA;
        const sheet = await exportedSheet({ notes });
        expectOneSafeDataRow(sheet);
        expect(sheet[1][7]).toBe(notes);
    });

    it('an embedded CR in an operator-named field (location) stays in its cell', async () => {
        const location = 'Bay 4\r@' + BARE_FORMULA.slice(1);
        const sheet = await exportedSheet({ location });
        expectOneSafeDataRow(sheet);
        expect(sheet[1][4]).toBe(location);
    });

    it('a LEADING CR is neutralised and quoted, so the formula never starts a row', async () => {
        const sheet = await exportedSheet({ notes: '\r=SUM(1+1)', name: '\r' + HYPERLINK });
        expectOneSafeDataRow(sheet);
        expect(sheet[1][7]).toBe("'\r=SUM(1+1)");
        expect(sheet[1][0]).toBe("'\r" + HYPERLINK);
    });

    it('a trigger behind leading whitespace (space / LF / tab) is neutralised', async () => {
        const sheet = await exportedSheet({ notes: ' =SUM(1+1)', quality: '\n' + HYPERLINK, unit: '\t@cmd' });
        expectOneSafeDataRow(sheet);
        expect(sheet[1][7]).toBe("' =SUM(1+1)");
        expect(sheet[1][1]).toBe("'\n" + HYPERLINK);
        expect(sheet[1][3]).toBe("'\t@cmd");
    });

    it('benign values round-trip unchanged (commas and quotes survive, nothing gains an apostrophe)', async () => {
        const sheet = await exportedSheet({ name: 'Titanium', notes: 'damaged, "repack"', location: 'Hangar A' });
        expectOneSafeDataRow(sheet);
        expect(sheet[1]).toEqual(['Titanium', 'Refined', 'ore', 'SCU', 'Hangar A', '10', '2', 'damaged, "repack"']);
    });
});

describe('stockCsv.csvEscape — RFC-4180 quoting covers CR', () => {
    it('quote-wraps a value containing a bare CR, LF, comma or quote', () => {
        expect(csvEscape('a\rb')).toBe('"a\rb"');
        expect(csvEscape('a\nb')).toBe('"a\nb"');
        expect(csvEscape('a,b')).toBe('"a,b"');
        expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    });
    it('leaves plain values, numbers and null alone', () => {
        expect(csvEscape('plain')).toBe('plain');
        expect(csvEscape(42)).toBe('42');
        expect(csvEscape(null)).toBe('');
        expect(csvEscape(undefined)).toBe('');
    });
});

// -----------------------------------------------------------------------------
// Write time: single-line warehouse fields never store a CR/LF in the first place.
// -----------------------------------------------------------------------------

const writeOf = (table: string, method: 'insert' | 'update') =>
    h.calls.find(c => c.table === table && c.method === method)?.args[0] as Record<string, unknown> | undefined;

const STOCK_ROW = { id: 1, catalog_id: 1, location_id: 1, notes: null, created_at: 't', updated_at: 't' };
const CATALOG_ROW = { id: 5, name: 'n', category: 'ore', quality_label: null, unit: 'SCU', description: null, archived_at: null, created_at: 't', updated_at: 't' };

describe('warehouse single-line fields — CR/LF collapsed to spaces at write time', () => {
    it('createWarehouseStock stores notes on one line', async () => {
        h.singles.warehouse_stock = STOCK_ROW;
        await createWarehouseStock({ catalogId: 1, locationId: 1, notes: '  x\r=HYPERLINK("http://evil")\r\nmore\n ' });
        expect(writeOf('warehouse_stock', 'insert')?.notes).toBe('x =HYPERLINK("http://evil") more');
    });

    it('createWarehouseStock keeps an empty/blank note as null', async () => {
        h.singles.warehouse_stock = STOCK_ROW;
        await createWarehouseStock({ catalogId: 1, locationId: 1, notes: '\r\n ' });
        expect(writeOf('warehouse_stock', 'insert')?.notes).toBeNull();
    });

    it('createWarehouseStock (platform source) normalises the quality label it stamps on the catalog row', async () => {
        h.singles.warehouse_platform_commodities = { id: 9, name: 'Quantanium', is_fuel: false, is_refined: false, is_extractable: true, is_raw: false, is_mineral: false };
        // Lookup finds no existing catalog row, then the insert returns the new id.
        h.singles.warehouse_catalog = [null, { id: 77 }];
        h.singles.warehouse_stock = STOCK_ROW;
        await createWarehouseStock({ catalogId: 9, locationId: 1, source: 'platform', qualityLabel: 'Grade\r=A\n' });
        const qualityLookup = h.calls.find(c => c.table === 'warehouse_catalog' && c.method === 'eq' && c.args[0] === 'quality_label');
        expect(qualityLookup?.args[1]).toBe('Grade =A');
        expect(writeOf('warehouse_catalog', 'insert')?.quality_label).toBe('Grade =A');
        expect(writeOf('warehouse_stock', 'insert')?.catalog_id).toBe(77);
    });

    it('createWarehouseCatalogItem stores name / quality / unit on one line', async () => {
        h.singles.warehouse_catalog = CATALOG_ROW;
        await createWarehouseCatalogItem({ name: 'Ti\r=cmd', category: 'ore', qualityLabel: 'High\nGrade', unit: 'S\r\nCU', description: 'multi\nline ok' });
        const ins = writeOf('warehouse_catalog', 'insert');
        expect(ins?.name).toBe('Ti =cmd');
        expect(ins?.quality_label).toBe('High Grade');
        expect(ins?.unit).toBe('S CU');
        // Description is a genuine multi-line field and is not in the CSV — untouched.
        expect(ins?.description).toBe('multi\nline ok');
    });

    it('updateWarehouseCatalogItem patches name / quality / unit on one line', async () => {
        h.singles.warehouse_catalog = CATALOG_ROW;
        await updateWarehouseCatalogItem({ id: 5, name: 'A\rB', qualityLabel: 'C\nD', unit: 'E\r\nF' });
        const patch = writeOf('warehouse_catalog', 'update');
        expect(patch?.name).toBe('A B');
        expect(patch?.quality_label).toBe('C D');
        expect(patch?.unit).toBe('E F');
    });
});
