import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_STOCK_TOTAL } from '../lib/stockLimits';

// schema.sql is applied BY HAND in the Supabase SQL editor. There is no migration runner
// and no CI step that executes it, so a defect in this file is discovered by an operator
// pasting it into a console — which is the worst possible place to discover one. These
// tests are the only thing standing between an edit here and that moment.
//
// Two families:
//   1. STRUCTURE — the file must still be valid SQL. A statement that lands inside a
//      dollar-quoted function body fails the ENTIRE run. This is not hypothetical: it is
//      exactly what a naive "insert after the function's END;" does, because `END;` is
//      followed by `$$;` on the next line.
//   2. STOCK INVARIANTS — the on-hand guards and the row-lock protocol that the
//      quartermaster and warehouse ledgers depend on for correctness under concurrency.

const SQL = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');
const LINES = SQL.split(/\r?\n/);

/** name -> body text between `AS $$` and the closing `$$;`. */
function functionBodies(): Map<string, string> {
    const out = new Map<string, string>();
    const re = /CREATE OR REPLACE FUNCTION\s+(public\.\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(SQL)) !== null) {
        const open = SQL.indexOf('$$', m.index);
        if (open === -1) continue;
        const close = SQL.indexOf('$$', open + 2);
        if (close === -1) continue;
        out.set(m[1], SQL.slice(open + 2, close));
    }
    return out;
}

const BODIES = functionBodies();

describe('schema.sql structure — a broken file fails the whole hand-applied run', () => {
    it('every CREATE OR REPLACE FUNCTION and GRANT sits outside every function body', () => {
        // Walk the dollar-quote depth line by line. Anything that toggles to depth 1 is
        // inside a body; a top-level statement found there means an earlier edit spliced
        // itself between an `END;` and its `$$;`.
        let depth = 0;
        let openedAt = 0;
        const offenders: string[] = [];
        for (let i = 0; i < LINES.length; i++) {
            const L = LINES[i];
            if (depth !== 0 && /^\s*(CREATE OR REPLACE FUNCTION|GRANT EXECUTE ON FUNCTION|CREATE TABLE|CREATE INDEX)\b/.test(L)) {
                offenders.push(`line ${i + 1} (inside the body opened at line ${openedAt}): ${L.trim().slice(0, 70)}`);
            }
            const toggles = (L.match(/\$\$/g) || []).length;
            for (let t = 0; t < toggles; t++) {
                depth = depth === 0 ? 1 : 0;
                if (depth === 1) openedAt = i + 1;
            }
        }
        expect(offenders, `top-level statements inside a function body:\n${offenders.join('\n')}`).toEqual([]);
        expect(depth, `unterminated dollar-quote opened at line ${openedAt}`).toBe(0);
    });

    it('parses a meaningful number of function bodies (guards the parser itself)', () => {
        expect(BODIES.size).toBeGreaterThan(30);
        expect(BODIES.has('public.qm_adjust_inventory')).toBe(true);
        expect(BODIES.has('public.warehouse_adjust_stock')).toBe(true);
    });

    it('every public function is on the explicit service_role grant allowlist', () => {
        // The blanket `GRANT ALL ON ALL FUNCTIONS ... TO service_role` covers a FULL
        // re-run, but there is no ALTER DEFAULT PRIVILEGES granting EXECUTE on FUNCTIONS
        // to service_role, while the REVOKE default IS recorded. An operator who pastes
        // only a new §4 function therefore gets 42501. The explicit line is load-bearing.
        const defined = [...new Set(
            [...SQL.matchAll(/^CREATE OR REPLACE FUNCTION\s+(public\.\w+)\s*\(/gm)].map((m) => m[1]),
        )];
        const granted = new Set(
            [...SQL.matchAll(/^GRANT EXECUTE ON FUNCTION\s+(public\.\w+)\s*\(/gm)].map((m) => m[1]),
        );
        const missing = defined.filter((f) => !granted.has(f)
            // Trigger functions are invoked by the trigger, never over PostgREST, and
            // carry no grant. This is the only one.
            && f !== 'public._operation_templates_set_updated_at');
        expect(missing, `public functions with no GRANT EXECUTE line:\n${missing.join('\n')}`).toEqual([]);
    });
});

describe('stock ledgers — on-hand can never go negative through an ordinary write', () => {
    // qm_adjust_inventory was the ONE stock-decreasing qm_* function with no guard. Its
    // documented mirror warehouse_adjust_stock always had one, and that asymmetry made
    // negative quartermaster on-hand reachable through the normal UI.
    const GUARDED: Array<[fn: string, movements: string, key: string, code: string]> = [
        ['public.qm_adjust_inventory', 'quartermaster_inventory_movements', 'inventory_id', 'QM_INSUFFICIENT_STOCK'],
        ['public.qm_set_inventory_total', 'quartermaster_inventory_movements', 'inventory_id', ''],
        ['public.warehouse_adjust_stock', 'warehouse_movements', 'stock_id', 'WAREHOUSE_INSUFFICIENT_STOCK'],
        ['public.warehouse_set_stock_total', 'warehouse_movements', 'stock_id', ''],
    ];

    it.each(GUARDED)('%s reads on-hand as SUM(delta) from %s', (fn, movements, key) => {
        const body = BODIES.get(fn);
        expect(body, `${fn} is not defined in schema.sql`).toBeDefined();
        expect(body).toMatch(new RegExp(`SELECT\\s+COALESCE\\(SUM\\(delta\\),\\s*0\\)\\s+INTO\\s+v_current`));
        expect(body).toContain(`FROM public.${movements} WHERE ${key} = p_`);
    });

    it('the two ADJUST functions refuse a delta that would drive on-hand below zero', () => {
        for (const [fn, , , code] of GUARDED.filter((g) => g[3])) {
            const body = BODIES.get(fn)!;
            expect(body, `${fn} lost its negative-stock guard`).toMatch(/IF\s+v_current\s*\+\s*p_delta\s*<\s*0\s+THEN/);
            expect(body).toContain(`RAISE EXCEPTION '${code}`);
        }
    });

    it('the two SET-TOTAL functions derive the delta themselves and take no delta parameter', () => {
        // The entire point. If a p_delta parameter ever reappears here, the browser is
        // doing the arithmetic again and every race in this file's header is back.
        for (const fn of ['public.qm_set_inventory_total', 'public.warehouse_set_stock_total']) {
            const body = BODIES.get(fn)!;
            expect(body, `${fn} must compute the delta from the live SUM`).toMatch(/v_delta\s*:=\s*p_target_total\s*-\s*v_current/);
            const signature = SQL.slice(SQL.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`), SQL.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`) + 300);
            expect(signature, `${fn} must not accept a delta`).not.toMatch(/p_delta\b/);
        }
    });

    it('a set-total that is already correct posts NOTHING (movements has CHECK delta <> 0)', () => {
        for (const fn of ['public.qm_set_inventory_total', 'public.warehouse_set_stock_total']) {
            expect(BODIES.get(fn)!).toMatch(/IF\s+v_delta\s*=\s*0\s+THEN\s+RETURN\s+NULL;\s*END IF;/);
        }
    });

    it("neither set-total accepts 'initial' — that reason belongs to row creation only", () => {
        for (const fn of ['public.qm_set_inventory_total', 'public.warehouse_set_stock_total']) {
            const allow = /p_reason NOT IN \(([^)]*)\)/.exec(BODIES.get(fn)!);
            expect(allow, `${fn} has no reason allow-list`).not.toBeNull();
            expect(allow![1]).not.toContain('initial');
        }
    });

    it('the SQL ceiling agrees with lib/stockLimits.MAX_STOCK_TOTAL', () => {
        // Two numbers in two languages: if they drift, the dialog offers a total the
        // server will reject, or the server accepts one the dialog thinks is impossible.
        for (const fn of ['public.qm_set_inventory_total', 'public.warehouse_set_stock_total']) {
            const m = /IF p_target_total > (\d+) THEN/.exec(BODIES.get(fn)!);
            expect(m, `${fn} has no ceiling check`).not.toBeNull();
            expect(Number(m![1])).toBe(MAX_STOCK_TOTAL);
        }
    });

    it('neither new function is SECURITY DEFINER', () => {
        // The whole qm_*/warehouse_* family is invoker-rights and reachable only under the
        // service-role key. A SECURITY DEFINER here with a public-inclusive search_path
        // would be a privilege-escalation shape for no benefit.
        for (const fn of ['public.qm_set_inventory_total', 'public.warehouse_set_stock_total']) {
            const at = SQL.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`);
            expect(SQL.slice(at, at + 400)).not.toMatch(/SECURITY DEFINER/);
            expect(SQL.slice(at, at + 400)).toContain('SET search_path = public, pg_temp');
        }
    });
});

describe('the row-lock protocol every stock write depends on', () => {
    // The correctness of BOTH set-total functions rests on a convention that was, until
    // now, written down nowhere: every plpgsql writer of a movement row first takes
    // FOR UPDATE on the parent stock/inventory row, so concurrent writers serialise and
    // each one's SUM(delta) sees the previous one's movement. A future function that
    // inserts a movement without the lock silently reopens the race for everything else.
    const TABLES: Array<[movements: string, parent: string]> = [
        ['public.quartermaster_inventory_movements', 'public.quartermaster_inventory'],
        ['public.warehouse_movements', 'public.warehouse_stock'],
    ];

    it.each(TABLES)('every function inserting into %s locks %s first', (movements, parent) => {
        const offenders: string[] = [];
        for (const [fn, body] of BODIES) {
            let idx = body.indexOf(`INSERT INTO ${movements}`);
            while (idx !== -1) {
                const before = body.slice(0, idx);
                const locked = before.includes('FOR UPDATE') && before.includes(parent);
                if (!locked) offenders.push(`${fn}: inserts into ${movements} without first locking ${parent}`);
                idx = body.indexOf(`INSERT INTO ${movements}`, idx + 1);
            }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    it('finds the writers it claims to check (guards against matching nothing)', () => {
        const writers = [...BODIES].filter(([, b]) => /INSERT INTO public\.(quartermaster_inventory_movements|warehouse_movements)/.test(b));
        expect(writers.length).toBeGreaterThanOrEqual(6);
    });
});
