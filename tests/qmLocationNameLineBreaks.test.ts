import { describe, it, expect, vi, beforeEach } from 'vitest';

// QM LOCATION NAMES MUST NOT CARRY LINE BREAKS.
//
// Location names are rendered into the warehouse stock CSV. A bare CR or LF inside a field
// starts a new spreadsheet row, and a formula-looking start of that row (`=`, `+`, `-`, `@`)
// evaluates on the exporter's machine. The export itself quotes CR/LF and neutralises leading
// formula characters (tests/sec-warehouse-csv.test.ts); this is the write-time half, so no
// future consumer of the stored name has to remember to defend against it.

const h = vi.hoisted(() => ({
    writes: [] as Array<{ table: string; op: 'insert' | 'update'; row: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'range']) b[m] = () => b;
        b.insert = (row: Record<string, unknown>) => { h.writes.push({ table, op: 'insert', row }); return b; };
        b.update = (row: Record<string, unknown>) => { h.writes.push({ table, op: 'update', row }); return b; };
        const settle = () => Promise.resolve({
            data: { id: 7, name: 'n', type: 'custom', parent_id: null, description: null, sort_order: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
            error: null,
        });
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle().then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});
vi.mock('../lib/push', () => ({ sendPushToStaff: () => {}, sendPushToUsers: async () => {} }));

import { createQmLocation, updateQmLocation } from '../lib/db/quartermaster';

const nameWritten = () => {
    const w = h.writes.find((x) => x.table === 'quartermaster_locations');
    return w?.row.name;
};

describe('QM location names collapse line breaks on write', () => {
    beforeEach(() => { h.writes.length = 0; });

    it('createQmLocation: a CR-smuggled formula row is flattened into one line', async () => {
        await createQmLocation({ name: 'Bay 1\r=HYPERLINK("http://x")', type: 'custom' } as Parameters<typeof createQmLocation>[0]);
        expect(nameWritten()).toBe('Bay 1 =HYPERLINK("http://x")');
        expect(String(nameWritten())).not.toMatch(/[\r\n]/);
    });

    it('createQmLocation: CRLF and LF runs become a single space, edges trimmed', async () => {
        await createQmLocation({ name: '\r\nHangar\n\n\r\nA\n', type: 'custom' } as Parameters<typeof createQmLocation>[0]);
        expect(nameWritten()).toBe('Hangar A');
    });

    it('updateQmLocation: a renamed location is flattened the same way', async () => {
        await updateQmLocation({ id: 7, name: 'Deck 2\n+SUM(A1:A9)' });
        expect(nameWritten()).toBe('Deck 2 +SUM(A1:A9)');
    });

    it('a plain name is stored unchanged', async () => {
        await createQmLocation({ name: '  Armoury  ', type: 'custom' } as Parameters<typeof createQmLocation>[0]);
        expect(nameWritten()).toBe('Armoury');
    });
});
