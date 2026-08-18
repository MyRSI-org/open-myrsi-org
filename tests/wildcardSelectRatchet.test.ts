import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Wildcard-select ratchet (security / data-minimisation rule).
//
// No wildcard select, `(*)` embed, or bare `select()` may exist in the server
// data layer. Every wildcard pulls every column — including ones added to the
// table later — and is one missed mapper away from shipping them to the browser.
// Queries must enumerate exactly the columns the caller needs.
//
// The baseline is EMPTY. The rule is absolute, not a ratchet down from a
// tolerated baseline.
//
// RESOLUTION: an earlier version of this check only inspected string literals
// passed directly to `.select(...)`, so a const holding a wildcard slipped
// through entirely — a gap the header comment in lib/db/government/orders.ts had
// to warn about by hand. It now resolves const identifiers and `obj.prop`
// references to their declared string values before testing them, and any select
// argument it CANNOT resolve statically must be declared in
// DYNAMIC_SELECT_ALLOWLIST below. A new unresolvable select therefore fails here
// instead of silently opting out of the rule.

const BASELINE: Record<string, number> = {};

// Select arguments that cannot be resolved to a string at rest. Each entry is a
// deliberate, reviewed exception — adding one is a decision, not an accident.
//
// lib/db/users.ts: bulkAssignUsersScalar takes `column`, typed as the literal
//   union 'unit_id' | 'rank_id' | 'position_id'. The helper is module-internal
//   (not exported) and every call site passes one of those literals, so the
//   compiler already constrains it to a single non-wildcard column name.
const DYNAMIC_SELECT_ALLOWLIST: Record<string, number> = {
    'lib/db/users.ts': 1,
};

const ROOT = resolve(__dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel, acc);
        else if (entry.name.endsWith('.ts')) acc.push(rel);
    }
    return acc;
}

// Comments are stripped before scanning so prose that merely mentions a select
// call does not register as a call site (or as an unresolvable one).
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const STRING_LITERAL = /^(`[^`]*`|'[^']*'|"[^"]*")$/;
const CONST_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
const OBJ_PROP = /([A-Za-z_$][\w$]*)\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;

// The first argument of every `.select(...)` call, extracted with a quote- and
// depth-aware walk rather than a regex. A regex cannot do this: virtually every
// column list contains a comma, so any pattern that stops at the first comma
// truncates `'key, value'` to `'key` and misreads it as a dynamic expression.
function extractSelectArgs(src: string): string[] {
    const NEEDLE = '.select(';
    const out: string[] = [];
    let i = 0;
    while ((i = src.indexOf(NEEDLE, i)) !== -1) {
        let j = i + NEEDLE.length;
        const start = j;
        let depth = 0;
        let quote: string | null = null;
        for (; j < src.length; j++) {
            const c = src[j];
            if (quote) {
                if (c === '\\') { j++; continue; }
                if (c === quote) quote = null;
                continue;
            }
            if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
            if (c === '(' || c === '[' || c === '{') { depth++; continue; }
            if (c === ')' && depth === 0) break;
            if (c === ')' || c === ']' || c === '}') { depth--; continue; }
            if (c === ',' && depth === 0) break;
        }
        out.push(src.slice(start, j).trim());
        i = j;
    }
    return out;
}

const files = [...walk('lib'), ...walk('api')];
const sources: Record<string, string> = {};
for (const rel of files) {
    sources[rel] = stripComments(readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8'));
}

// Symbol tables: per-file first (a local const shadows), then project-wide so a
// select importing its column list from a sibling module still resolves.
const fileConsts: Record<string, Record<string, string>> = {};
const fileProps: Record<string, Record<string, string[]>> = {};
const globalConsts: Record<string, string> = {};
const globalProps: Record<string, string[]> = {};

for (const rel of files) {
    fileConsts[rel] = {};
    fileProps[rel] = {};
    let m: RegExpExecArray | null;
    CONST_DECL.lastIndex = 0;
    while ((m = CONST_DECL.exec(sources[rel])) !== null) {
        fileConsts[rel][m[1]] = m[2];
        if (!(m[1] in globalConsts)) globalConsts[m[1]] = m[2];
    }
    OBJ_PROP.lastIndex = 0;
    while ((m = OBJ_PROP.exec(sources[rel])) !== null) {
        (fileProps[rel][m[1]] ||= []).push(m[2]);
        (globalProps[m[1]] ||= []).push(m[2]);
    }
}

/** Every string a select argument could resolve to, or null if unresolvable. */
function resolveSelectArg(rel: string, arg: string): string[] | null {
    if (STRING_LITERAL.test(arg)) return [arg];
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
        const v = fileConsts[rel]?.[arg] ?? globalConsts[arg];
        return v === undefined ? null : [v];
    }
    // `namespace.CONST` / `obj.prop` — check object-literal props first, then the
    // const tables (an `import * as users` reference resolves via its module).
    const qualified = arg.match(/^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/);
    if (qualified) {
        const prop = qualified[1];
        const vals = fileProps[rel]?.[prop] ?? globalProps[prop];
        if (vals) return vals;
        const v = fileConsts[rel]?.[prop] ?? globalConsts[prop];
        return v === undefined ? null : [v];
    }
    return null;
}

const wildcardCounts: Record<string, number> = {};
const dynamicCounts: Record<string, number> = {};
let scannedCallSites = 0;

for (const rel of files) {
    for (const arg of extractSelectArgs(sources[rel])) {
        scannedCallSites++;
        // A bare .select() selects every column too.
        if (arg === '') { wildcardCounts[rel] = (wildcardCounts[rel] ?? 0) + 1; continue; }
        const resolved = resolveSelectArg(rel, arg);
        if (resolved === null) { dynamicCounts[rel] = (dynamicCounts[rel] ?? 0) + 1; continue; }
        if (resolved.some((v) => v.includes('*'))) {
            wildcardCounts[rel] = (wildcardCounts[rel] ?? 0) + 1;
        }
    }
}

describe('wildcard-select ratchet (lib/** + api/**)', () => {
    it('no file gained a wildcard select (enumerate your columns instead)', () => {
        const regressions: string[] = [];
        for (const [file, count] of Object.entries(wildcardCounts)) {
            const allowed = BASELINE[file] ?? 0;
            if (count > allowed) {
                regressions.push(`${file}: ${count} wildcard selects (baseline ${allowed}) — new queries must enumerate exact columns`);
            }
        }
        expect(regressions, regressions.join('\n')).toEqual([]);
    });

    it('baseline is ratcheted down when wildcards are removed', () => {
        const stale: string[] = [];
        for (const [file, allowed] of Object.entries(BASELINE)) {
            const count = wildcardCounts[file] ?? 0;
            if (count < allowed) {
                stale.push(`${file}: now ${count} (baseline ${allowed}) — lower the BASELINE entry to lock in the improvement`);
            }
        }
        expect(stale, stale.join('\n')).toEqual([]);
    });

    it('every select argument is statically resolvable or explicitly allow-listed', () => {
        const undeclared: string[] = [];
        for (const [file, count] of Object.entries(dynamicCounts)) {
            const allowed = DYNAMIC_SELECT_ALLOWLIST[file] ?? 0;
            if (count > allowed) {
                undeclared.push(`${file}: ${count} unresolvable select argument(s) (allow-listed ${allowed}) — pass a literal or a module-level const, or add a reviewed DYNAMIC_SELECT_ALLOWLIST entry`);
            }
        }
        expect(undeclared, undeclared.join('\n')).toEqual([]);
    });

    it('the dynamic allow-list is not stale', () => {
        const stale: string[] = [];
        for (const [file, allowed] of Object.entries(DYNAMIC_SELECT_ALLOWLIST)) {
            const count = dynamicCounts[file] ?? 0;
            if (count < allowed) {
                stale.push(`${file}: now ${count} unresolvable (allow-listed ${allowed}) — lower the entry`);
            }
        }
        expect(stale, stale.join('\n')).toEqual([]);
    });

    it('actually resolves const-based selects (guards the resolver itself)', () => {
        // A real const resolves to a real, wildcard-free column list.
        const tpl = resolveSelectArg('lib/db/operation-templates.ts', 'TEMPLATE_SELECT');
        expect(tpl).not.toBeNull();
        expect(tpl!.join()).toContain('classification_level');
        expect(tpl!.some((v) => v.includes('*'))).toBe(false);
        // An unknown identifier is reported as unresolvable, not silently passed.
        expect(resolveSelectArg('lib/db/ops.ts', 'NOT_A_REAL_SYMBOL_XYZ')).toBeNull();
    });

    it('flags a const that holds a wildcard (the gap this check was written to close)', () => {
        const rel = 'lib/__ratchet_probe__.ts';
        fileConsts[rel] = { SNEAKY_SELECT: "'*'" };
        fileProps[rel] = {};
        try {
            const resolved = resolveSelectArg(rel, 'SNEAKY_SELECT');
            expect(resolved).not.toBeNull();
            expect(resolved!.some((v) => v.includes('*'))).toBe(true);
        } finally {
            delete fileConsts[rel];
            delete fileProps[rel];
        }
    });

    it('extracts whole select arguments, commas and nesting included', () => {
        // The bug this extractor replaced: stopping at the first comma turned
        // `'key, value'` into `'key` and misclassified it as dynamic.
        expect(extractSelectArgs(`q.select('key, value').in('key', [1])`)).toEqual(["'key, value'"]);
        expect(extractSelectArgs('q.select(`a, rel(b, c)`)')).toEqual(['`a, rel(b, c)`']);
        expect(extractSelectArgs('q.select(COLS, { count: "exact" })')).toEqual(['COLS']);
        expect(extractSelectArgs('q.select()')).toEqual(['']);
    });

    it('scans a plausible number of call sites (guards a silently broken scanner)', () => {
        // If a regex or path change quietly stops matching, this trips rather
        // than the suite reporting a clean run over zero files.
        expect(files.length).toBeGreaterThan(80);
        expect(scannedCallSites).toBeGreaterThan(500);
    });
});
