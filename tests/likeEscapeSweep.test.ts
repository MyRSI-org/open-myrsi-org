import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { escapeLikePattern } from '../lib/pgrest';
import { stripComments } from './stripComments';

// LIKE-escape sweep (security rule 2 — a widened `.ilike` is an unscoped read,
// and on `.update().ilike()` an unscoped WRITE).
//
// The defect class is "one member of a family was missed". escapeLikePattern
// escaped %/_/\ but not `*`, which PostgREST rewrites to `%` in a like/ilike
// operand before Postgres ever sees it; and five hand-rolled copies of the same
// escape had drifted from the helper independently (one of them never escaped
// `\` at all, so an input of `\%` emitted a literal backslash followed by a LIVE
// wildcard). A behavioural stub can only disprove that for the one path it
// happens to drive, so the family is pinned at source level, in the idiom of
// tests/wildcardSelectRatchet.test.ts.

// The one legitimate home of a LIKE-metacharacter escape. Every other data-layer
// file must call the helper instead of re-deriving the character class.
const HAND_ROLLED_ALLOWLIST: Record<string, number> = {
    'lib/pgrest.ts': 1,
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

// Comments are blanked before scanning so lib/pgrest.ts's own doc block — and the
// explanatory comment left at each repointed call site — does not register as a call
// site. Shared helper: the local version here had the same blanking bug that blinded
// the wildcard-select ratchet.

const files = [...walk('lib'), ...walk('api')];
const sources: Record<string, string> = {};
for (const rel of files) {
    sources[rel] = stripComments(readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8'));
}

// A `.replace(/[…%…]/…)` — a character class containing the LIKE wildcard, i.e.
// an escape being re-derived by hand. Order-independent, so `[%_,()]` and
// `[_%\\]` are caught as readily as the original `[\\%_]`. Deliberately does NOT
// match safeSearchTerm's allow-list class (`[^a-zA-Z0-9 _-]`) or its two inline
// copies in lib/db/intel.ts, which STRIP for an `.or()` grammar string rather
// than escape for an ilike operand — a different job with a different answer.
const HAND_ROLLED = /\.replace\(\/\[[^\]]*%[^\]]*\]/g;

// `.ilike('col', `%${v}%`)` — a substring search. The interpolated local must be
// the output of escapeLikePattern; the surrounding %…% is intentional.
const SUBSTRING_ILIKE = /\.ilike\('([a-z_]+)', *`%\$\{(\w+)\}%`\)/g;

// Identity lookups: `.ilike('<handle-ish column>', <arg>)`. The ARGUMENT is
// captured and inspected rather than excluded with a negative lookahead — a
// `(?!escapeLikePattern)` placed after `, *` passes vacuously, because `*` can
// match zero characters and slide the lookahead past the identifier.
const TARGET_COLUMNS = 'target_id|target_rsi_handle|affiliated_org|unregistered_client_rsi_handle|rsi_handle';

function targetLookupArgs(rel: string): string[] {
    const re = new RegExp(`\\.ilike\\('(?:${TARGET_COLUMNS})', *([^)]+\\)?)\\)`, 'g');
    return [...sources[rel].matchAll(re)].map((m) => m[1].trim());
}

function unescapedArgs(args: string[]): string[] {
    return args.filter((a) => a !== 'safeTarget' && !a.startsWith('escapeLikePattern('));
}

describe('LIKE-escape sweep (lib/** + api/**)', () => {
    it('no data-layer file hand-rolls a LIKE escape', () => {
        const counts: Record<string, number> = {};
        for (const rel of files) {
            const n = (sources[rel].match(HAND_ROLLED) || []).length;
            if (n > 0) counts[rel] = n;
        }
        const offenders: string[] = [];
        for (const [file, count] of Object.entries(counts)) {
            const allowed = HAND_ROLLED_ALLOWLIST[file] ?? 0;
            if (count > allowed) {
                offenders.push(`${file}: ${count} inline LIKE escape(s) (allowed ${allowed}) — call escapeLikePattern from lib/pgrest.ts instead of re-deriving the class`);
            }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    it('the hand-rolled allow-list is not stale', () => {
        const stale: string[] = [];
        for (const [file, allowed] of Object.entries(HAND_ROLLED_ALLOWLIST)) {
            const count = (sources[file]?.match(HAND_ROLLED) || []).length;
            if (count < allowed) {
                stale.push(`${file}: now ${count} (allow-listed ${allowed}) — lower the entry to lock in the improvement`);
            }
        }
        expect(stale, stale.join('\n')).toEqual([]);
    });

    it('every %…% substring ilike is fed by escapeLikePattern', () => {
        const sites: Array<[string, string, string]> = [];
        for (const rel of files) {
            SUBSTRING_ILIKE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = SUBSTRING_ILIKE.exec(sources[rel])) !== null) sites.push([rel, m[1], m[2]]);
        }
        // Marketplace 1, quartermaster 2, warehouse 2, public 2. Guards against a
        // vacuous pass if the search paths are refactored away.
        //
        // Was 8. The armoury search repair replaced quartermaster's TWO custom_name-only
        // .ilike() filters (list + count) with a single shared .or() expression — that grammar
        // is safeSearchTerm's job, not this sweep's (see the note above HAND_ROLLED) — and
        // added ONE new .ilike on the catalog name resolve. Net 8 -> 7. Lower this only when a
        // search path genuinely moves; never to make a new unescaped ilike pass.
        expect(sites.length, 'no %…% ilike found — did the search paths move?').toBeGreaterThanOrEqual(7);
        const unfed = sites
            .filter(([rel, , v]) => !new RegExp(`const\\s+${v}\\s*(?::[^=]+)?=\\s*escapeLikePattern\\(`).test(sources[rel]))
            .map(([rel, col, v]) => `${rel}: .ilike('${col}', …${v}…) — ${v} is not assigned from escapeLikePattern()`);
        expect(unfed, unfed.join('\n')).toEqual([]);
    });

    it('the escaper itself covers all four metacharacters', () => {
        // Duplicated from tests/wave3SecurityHelpers.test.ts on purpose: this file
        // is the sweep's own reference point and must stand alone if that one moves.
        expect(escapeLikePattern('a%b_c\\d*e')).toBe('a\\%b\\_c\\\\d\\*e');
    });

    it('lib/db/intel.ts has no unescaped target lookup left', () => {
        const args = targetLookupArgs('lib/db/intel.ts');
        expect(args.length, 'no target lookups found — did they move?').toBeGreaterThan(8);
        const unescaped = unescapedArgs(args);
        expect(unescaped, `unescaped target lookups remain: ${unescaped.join(', ')}`).toEqual([]);
    });

    // The identity-lookup family outside intel.ts. These resolve an RSI handle to
    // a row, so a widened match is a mis-link, not just an over-fetch.
    it.each(['lib/db/users.ts', 'lib/db/hr.ts', 'lib/db/requests.ts'])(
        '%s escapes every handle-keyed identity lookup',
        (rel) => {
            const args = targetLookupArgs(rel);
            expect(args.length, `${rel}: no identity lookup found — did it move?`).toBeGreaterThan(0);
            const unescaped = unescapedArgs(args);
            expect(unescaped, `${rel}: unescaped identity lookups: ${unescaped.join(', ')}`).toEqual([]);
        },
    );

    it('the comment that licensed the unescaped affiliated-org fan-out is gone', () => {
        // getDossier's org fan-out was left raw because this comment asserted
        // orgName was trustworthy for coming "from DB rows". affiliated_org is free
        // text an intel author writes — and that a federation peer can plant via
        // syncTrustedFeeds. Pin the removal: the comment is what re-opens the gap.
        const raw = readFileSync(join(ROOT, 'lib', 'db', 'intel.ts'), 'utf8');
        expect(raw).not.toMatch(/comes from DB rows, not the client/);
    });

    it('scans a plausible number of files (guards a silently broken scanner)', () => {
        expect(files.length).toBeGreaterThan(80);
    });
});
