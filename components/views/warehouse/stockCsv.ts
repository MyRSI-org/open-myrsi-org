// Browser-side assembly of the warehouse stock CSV export (WhStockTab). Lives in
// its own module so tests/sec-warehouse-csv.test.ts can drive the REAL escaper
// end to end, server rows → this file → a spreadsheet-style parse.
//
// Formula-injection neutralisation is the server's job (exportWarehouseCsv in
// lib/db/warehouse.ts prefixes the literal-text apostrophe); this layer only does
// RFC-4180 quoting, and must not neutralise again or benign values would gain a
// second apostrophe.

export const CSV_HEADER = ['Commodity', 'Quality', 'Category', 'Unit', 'Location', 'On Hand', 'Reserved', 'Notes'] as const;

export interface StockExportRow {
    commodity: string;
    quality: string;
    category: string;
    unit: string;
    location: string;
    onHand: number;
    reserved: number;
    notes: string;
}

// CR is in the quote set alongside LF: Excel and LibreOffice end a row on a bare
// CR, so an unquoted 'x\r=HYPERLINK(...)' began a NEW row whose first cell was a
// live formula — one the server's leading-character check never saw.
export function csvEscape(v: unknown): string {
    if (v == null) return '';
    const s = String(v);
    if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

export function buildStockCsv(rows: StockExportRow[]): string {
    const lines = [CSV_HEADER.join(',')];
    for (const r of rows) {
        lines.push([
            csvEscape(r.commodity),
            csvEscape(r.quality),
            csvEscape(r.category),
            csvEscape(r.unit),
            csvEscape(r.location),
            csvEscape(r.onHand),
            csvEscape(r.reserved),
            csvEscape(r.notes),
        ].join(','));
    }
    return lines.join('\n');
}
