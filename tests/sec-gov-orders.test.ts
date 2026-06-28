import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// government_orders rows must reach the wire through an explicit field-by-field
// mapper, never as a raw DB row pulled by a wildcard `select('*')`. A wildcard
// can hide behind a const like ORDER_SELECT, which the wildcard-select ratchet
// misses because it only flags string literals passed directly to `.select(...)`.
// Two checks below:
//   (1) the mapper drops any unexpected column instead of shipping it, and
//   (2) a const-resolving ratchet proves orders.ts contributes 0 wildcards
//       (and that the detector catches a wildcard hidden behind a const).

const h = vi.hoisted(() => ({
    selectRow: null as Record<string, unknown> | null,
    selectRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        const state = { op: 'select' as string };
        const b: Record<string, unknown> = {};
        b.select = () => { state.op = 'select'; return b; };
        b.update = () => { state.op = 'update'; return b; };
        b.insert = () => { state.op = 'insert'; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = () => b; b.is = () => b; b.in = () => b; b.lt = () => b;
        b.order = () => b; b.limit = () => b;
        const settle = (mode: 'single' | 'many') => {
            if (state.op !== 'select') return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: mode === 'single' ? h.selectRow : h.selectRows, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('many').then(res, rej);
        return b;
    }
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    };
});

import { listGovernmentOrders, getGovernmentOrder } from '../lib/db/government/orders';

// Exactly the keys toGovernmentOrder enumerates — the wire contract.
const EXPECTED_KEYS = [
    'id', 'issuer_position_id', 'issuer_user_id', 'number', 'title', 'preamble', 'body',
    'rationale', 'status', 'effective_at', 'expires_at', 'issued_at', 'revoked_at',
    'revoked_by_user_id', 'revoked_by_position_id', 'revoked_reason', 'created_at',
    'updated_at', 'issuer_position', 'issuer', 'revoked_by',
].sort();

function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'O1',
        issuer_position_id: 5,
        issuer_user_id: 10,
        number: 'EO-1',
        title: 'Mobilization',
        preamble: 'Whereas…',
        body: 'The directive.',
        rationale: 'Article 3.',
        status: 'active',
        effective_at: '2026-01-01T00:00:00Z',
        expires_at: null,
        issued_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
        revoked_by_user_id: null,
        revoked_by_position_id: null,
        revoked_reason: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        issuer_position: { id: 5, name: 'Chancellor', icon: 'crown', secret_pos_flag: 'LEAK-POS' },
        issuer: { id: 10, name: 'Alice', avatar_url: 'a.png', rsi_handle: 'alice', email: 'LEAK-EMAIL@x.com' },
        revoked_by: null,
        // Columns a future migration might add — must NEVER reach the wire:
        internal_note: 'SECRET internal note',
        classification: 'TOP-SECRET',
        ...over,
    };
}

beforeEach(() => {
    h.selectRow = null;
    h.selectRows = [];
});

describe('government_orders mapper gates the wire', () => {
    it('getGovernmentOrder returns only enumerated fields and drops unexpected columns', async () => {
        h.selectRow = rawRow();
        const order = await getGovernmentOrder('O1', 10);
        expect(order).not.toBeNull();
        expect(Object.keys(order as object).sort()).toEqual(EXPECTED_KEYS);
        // The unexpected DB columns are dropped, not forwarded.
        expect('internal_note' in (order as object)).toBe(false);
        expect('classification' in (order as object)).toBe(false);
        expect(JSON.stringify(order)).not.toContain('SECRET internal note');
        expect(JSON.stringify(order)).not.toContain('TOP-SECRET');
    });

    it('embeds are narrowed to their enumerated columns (no embed widening leak)', async () => {
        h.selectRow = rawRow();
        const order = await getGovernmentOrder('O1', 10);
        expect(Object.keys(order!.issuer_position as object).sort()).toEqual(['icon', 'id', 'name']);
        expect(Object.keys(order!.issuer as object).sort()).toEqual(['avatar_url', 'id', 'name', 'rsi_handle']);
        // Extra embed columns never cross the wire.
        expect(JSON.stringify(order)).not.toContain('LEAK-POS');
        expect(JSON.stringify(order)).not.toContain('LEAK-EMAIL');
    });

    it('listGovernmentOrders maps every row through the mapper', async () => {
        h.selectRows = [rawRow({ id: 'A' }), rawRow({ id: 'B' })];
        const orders = await listGovernmentOrders(10);
        expect(orders).toHaveLength(2);
        for (const o of orders) {
            expect(Object.keys(o as object).sort()).toEqual(EXPECTED_KEYS);
            expect('internal_note' in (o as object)).toBe(false);
        }
        expect(JSON.stringify(orders)).not.toContain('SECRET internal note');
    });

    it('preserves draft visibility: a draft is hidden from non-authors, shown to the author', async () => {
        h.selectRow = rawRow({ status: 'draft', issuer_user_id: 10 });
        expect(await getGovernmentOrder('O1', 999)).toBeNull();   // non-author
        h.selectRow = rawRow({ status: 'draft', issuer_user_id: 10 });
        expect(await getGovernmentOrder('O1', 10)).not.toBeNull(); // author
    });
});

// Const-resolving wildcard detector. The repo ratchet (wildcardSelectRatchet.test.ts)
// only inspects string/template literals passed DIRECTLY to `.select(...)`, so a
// wildcard hidden behind `const ORDER_SELECT = \`*, …\`; .select(ORDER_SELECT)` is
// not caught. This resolves module-level consts too, closing that blind spot.
function countWildcardSelectsResolvingConsts(src: string): number {
    let count = 0;
    // Direct literal arg containing '*'.
    const directRe = /\.select\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
    let m: RegExpExecArray | null;
    while ((m = directRe.exec(src)) !== null) {
        if (m[1].includes('*')) count++;
    }
    // Bare .select() pulls every column too.
    const bare = src.match(/\.select\(\s*\)/g);
    count += bare ? bare.length : 0;
    // Const-indirection: `const NAME = \`…*…\`` then `.select(NAME)`.
    const constRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
    const wildcardConsts = new Set<string>();
    let c: RegExpExecArray | null;
    while ((c = constRe.exec(src)) !== null) {
        if (c[2].includes('*')) wildcardConsts.add(c[1]);
    }
    if (wildcardConsts.size) {
        const identRe = /\.select\(\s*([A-Za-z_$][\w$]*)\s*[),]/g;
        let s: RegExpExecArray | null;
        while ((s = identRe.exec(src)) !== null) {
            if (wildcardConsts.has(s[1])) count++;
        }
    }
    return count;
}

describe('const-indirection wildcard ratchet', () => {
    const ordersSrc = readFileSync(
        resolve(__dirname, '..', 'lib', 'db', 'government', 'orders.ts'),
        'utf8',
    );

    it('the detector catches a wildcard hidden behind a const', () => {
        const before = 'const ORDER_SELECT = `\n  *,\n  issuer:users(id)\n`;\nawait x.select(ORDER_SELECT).eq("id", 1);';
        expect(countWildcardSelectsResolvingConsts(before)).toBeGreaterThan(0);
    });

    it('lib/db/government/orders.ts contributes 0 wildcard selects (const included)', () => {
        expect(countWildcardSelectsResolvingConsts(ordersSrc)).toBe(0);
    });
});
