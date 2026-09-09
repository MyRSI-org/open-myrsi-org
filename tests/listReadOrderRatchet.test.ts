import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from './stripComments';

// A `.limit()` WITHOUT a total ORDER BY does not "return the first n rows" — Postgres may return
// ANY n rows, and two identical calls can disagree. A `.range()` paging loop without one is worse:
// paging is undefined ACROSS pages, so rows can repeat and rows can be SKIPPED entirely.
//
// This was not theoretical. Of the 60 capped list reads in this repo, exactly TWO carried a
// primary-key tiebreak: 23 had no `.order()` at all and 34 had a partial order over a column with
// routine ties (`created_at`, `sort_order`, `publish_date`, `name`). Six were `.range()` loops with
// no order whatsoever — including the org importer's catalog index, whose own comment asserted
// "catalog rows arrive in id order" while nothing established one.
//
// Two ratchets:
//   ORDER — an ABSOLUTE rule. Every capped list read ends with a primary-key tiebreak. The set of
//           offenders is now empty and must stay empty.
//   CAP   — a baseline that may only SHRINK. Capping a read is not always correct (see
//           tests/uncappableReadContracts.test.ts), so this is a budget, not a target.

const ROOT = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!/node_modules|dist|dist-server/.test(p)) walk(p, out); }
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

// Comment blanking is the shared, string-aware helper (tests/stripComments.ts).

interface Site { file: string; line: number; capped: boolean; hasRange: boolean; orders: string[]; limitOne: boolean }

function scan(): Site[] {
    const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'api'))];
    const rows: Site[] = [];
    for (const f of files) {
        const raw = readFileSync(f, 'utf8');
        const src = stripComments(raw);
        let idx = 0;
        while ((idx = src.indexOf('.select(', idx)) !== -1) {
            let d = 0, end = src.length;
            for (let j = idx; j < src.length; j++) {
                const ch = src[j];
                if (ch === '(' || ch === '[' || ch === '{') d++;
                else if (ch === ')' || ch === ']' || ch === '}') d--;
                else if (ch === ';' && d <= 0) { end = j; break; }
            }
            let chain = src.slice(idx, end);
            const before = src.slice(Math.max(0, idx - 400), idx);
            const isWrite = /\.(insert|update|upsert|delete)\s*\(/.test(before.slice(-200));
            const isSingle = /\.(single|maybeSingle)\s*\(/.test(chain);
            const isHead = /head:\s*true/.test(chain);

            // BUILDER-VARIABLE FOLLOW-ON. A very common shape puts the cap and the order in
            // LATER statements:
            //     let q = supabase.from('x').select(...).order('created_at');
            //     if (filter) q = q.eq(...);
            //     q = q.range(offset, offset + limit - 1);
            // Scanning only to the first `;` sees an uncapped, partially-ordered chain and lets
            // it skip the absolute rule entirely. Seven real offenders hid here — two of them
            // client-driven PAGING loops, the worse failure this file exists to prevent.
            //
            // So: if this select was assigned to a variable, append every later statement in
            // the same file that re-assigns or awaits that variable, and treat the whole thing
            // as one chain.
            const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(before.replace(/[\s\S]*?\n/g, m => m).slice(-200).split('\n').pop() ?? '')
                ?? /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?supabase[\s\S]*$/.exec(before.slice(-300));
            if (assign) {
                const varName = assign[1];
                // Bounded window: the enclosing function, approximated generously. A false
                // positive here can only ADD order/limit evidence, never remove it.
                const after = src.slice(end, end + 4000);
                const re = new RegExp(`(?:^|[^\\w$])${varName}\\s*=\\s*${varName}\\s*\\.[^;]*;|await\\s+${varName}\\s*\\.[^;]*;`, 'g');
                for (const m2 of after.matchAll(re)) chain += ' ' + m2[0];
            }

            if (!isWrite && !isSingle && !isHead) {
                rows.push({
                    file: f.slice(ROOT.length + 1).replace(/\\/g, '/'),
                    line: raw.slice(0, idx).split(/\r?\n/).length,
                    capped: /\.limit\s*\(/.test(chain) || /\.range\s*\(/.test(chain),
                    hasRange: /\.range\s*\(/.test(chain),
                    orders: [...chain.matchAll(/\.order\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]),
                    limitOne: /\.limit\s*\(\s*1\s*\)/.test(chain),
                });
            }
            idx += 8;
        }
    }
    return rows;
}

/**
 * Columns that constitute a TOTAL order, i.e. a real tiebreak.
 *
 * `id` is the primary key on every table this scan reaches but two, both of which are junction
 * tables with a COMPOSITE key and no `id` column at all:
 *   · `role_permissions` `(role_id, permission_id)` — `role_id` is the tiebreak available there.
 *   · `user_certifications` `(user_id, certification_id)` — each read pins ONE half with .eq()
 *     and orders on the OTHER, which then completes the key: the cert-holders report fixes
 *     certification_id and ends on user_id, the member transcript fixes user_id and ends on
 *     certification_id.
 *
 * Adding to this set is how a nondeterministic read gets waved through — do it only for a column
 * that genuinely completes a key on its table, and say which table and which read.
 */
// `key` is here for exactly one table: public.settings is the only one in the tree with
// no `id` column — its primary key IS `key` (schema.sql, settings_pkey PRIMARY KEY (key)),
// so ordering by it is a genuine total order, not a partial one. Verified as the sole
// `.order('key'` site in lib/** + api/** when it was added; if a second appears on a table
// where `key` is not unique, this entry stops being safe.
const TOTAL_ORDER_COLUMNS = new Set(['id', 'role_id', 'user_id', 'certification_id', 'key']);

const sites = scan();
const capped = sites.filter(s => s.capped);

describe('capped list reads truncate deterministically', () => {
    it('scans a meaningful surface (guards against the scanner silently matching nothing)', () => {
        expect(sites.length).toBeGreaterThan(300);
        expect(capped.length).toBeGreaterThan(50);
    });

    // THE ABSOLUTE RULE. Empty baseline, like tests/wildcardSelectRatchet.test.ts.
    it('every capped list read ends with a primary-key tiebreak', () => {
        const offenders = capped
            // Exempt ONLY a bare `.limit(1)` with no ordering at all — a pure existence probe,
            // where one row is the whole answer and there is nothing to disambiguate.
            //
            // Deliberately NOT exempting every `.limit(1)`: a "give me the top one" read that
            // orders by a non-unique column returns an ARBITRARY row among ties, and the caller
            // usually goes on to use that row's data. Those need the tiebreak like any other.
            .filter(s => !(s.limitOne && s.orders.length === 0))
            .filter(s => s.orders.length === 0 || !TOTAL_ORDER_COLUMNS.has(s.orders[s.orders.length - 1]))
            .map(s => `${s.file}:${s.line} [${s.orders.join(' > ') || 'NO ORDER'}]`);
        expect(offenders, `capped reads without a total order:\n${offenders.join('\n')}`).toEqual([]);
    });

    // Stricter than the rule above, and worth its own assertion because the failure mode is worse:
    // a partial order at least returns a consistent SET; `.range()` without any order can return
    // the same row twice across pages and drop another entirely.
    it('no .range() paging loop runs without an ORDER BY', () => {
        const offenders = sites
            .filter(s => s.hasRange && s.orders.length === 0)
            .map(s => `${s.file}:${s.line}`);
        expect(offenders, `.range() without ORDER BY:\n${offenders.join('\n')}`).toEqual([]);
    });
});

/**
 * Uncapped list reads, by file. A BUDGET, not a target.
 *
 * Deliberately not zero and deliberately not a goal to drive to zero: capping a read is often the
 * WRONG fix. A cap on the media GC's reference set deletes live images; on a federation roster it
 * makes `memberCount` a lie; on an election tally it produces a wrong result presented as fact.
 * Those reads are pinned as uncappable by tests/uncappableReadContracts.test.ts.
 *
 * This exists so a NEW unbounded read is a visible, deliberate act rather than a default. Lower a
 * number when you cap one; never raise one.
 */
const UNCAPPED_BASELINE: Record<string, number> = {
    'api/actions/intel.ts': 1,
    'api/actions/requests.ts': 1,
    'api/index.ts': 1,
    'api/query.ts': 1,
    'api/sw.ts': 1,
    'lib/ai.ts': 2,
    'lib/db.ts': 12,
    'lib/db/academy.ts': 11,
    'lib/db/allianceSync.ts': 2,
    'lib/db/alliances.ts': 5,
    'lib/db/clientRoleLock.ts': 1,
    'lib/db/common.ts': 2,
    'lib/db/finances.ts': 1,
    'lib/db/fleet.ts': 10,
    'lib/db/government/elections.ts': 3,
    // Was 2. getVotesForElection now pages to exhaustion on a total order and verifies
    // the total against an exact count — an unbounded read there did not fail on
    // truncation, it tallied a subset and reported a winner.
    'lib/db/government/internal.ts': 1,
    'lib/db/government/legislation.ts': 5,
    'lib/db/government/orders.ts': 2,
    'lib/db/hr.ts': 12,
    'lib/db/importer.ts': 11,
    'lib/db/intel.ts': 23,
    'lib/db/marketplace.ts': 6,
    'lib/db/notifications.ts': 1,
    'lib/db/opReminders.ts': 3,
    'lib/db/operation-templates.ts': 4,
    'lib/db/operations-federation.ts': 11,
    // MOVED, not added: this is the branding-settings read that used to sit in
    // api/actions/operations.ts's buildAnnouncementEmbedInput. The function relocated
    // so the start-notice cron could reuse it; the read is byte-identical.
    'lib/db/opAnnouncement.ts': 1,
    'lib/db/ops.ts': 17,
    'lib/db/public.ts': 4,
    'lib/db/quartermaster.ts': 16,
    'lib/db/requests.ts': 2,
    'lib/db/roleDefaults.ts': 2,
    'lib/db/secretsRotation.ts': 2,
    'lib/db/seeder.ts': 3,
    'lib/db/system.ts': 27,
    'lib/db/users.ts': 18,
    'lib/db/warehouse.ts': 9,
    'lib/db/wiki.ts': 4,
    'lib/discord.ts': 1,
    // Was 11. Every read in gatherReferencedKeys is now paged to exhaustion — an
    // unpaged read there did not fail on truncation, it silently shrank the
    // "still referenced" set and the sweep deleted the live images past the cap.
    'lib/orgMediaGc.ts': 0,
    'lib/push.ts': 10,
    'lib/radio.ts': 3,
    'lib/secrets.ts': 1,
};

describe('uncapped list reads — a budget that may only shrink', () => {
    const actual: Record<string, number> = {};
    for (const s of sites) if (!s.capped) actual[s.file] = (actual[s.file] || 0) + 1;

    it('no file exceeds its baseline', () => {
        const over = Object.entries(actual)
            .filter(([f, n]) => n > (UNCAPPED_BASELINE[f] ?? 0))
            .map(([f, n]) => `${f}: ${n} > ${UNCAPPED_BASELINE[f] ?? 0}`);
        expect(over, `new unbounded list reads:\n${over.join('\n')}`).toEqual([]);
    });

    it('the baseline has no stale entries (ratchet DOWN when a read is capped)', () => {
        const stale = Object.entries(UNCAPPED_BASELINE)
            .filter(([f, n]) => (actual[f] ?? 0) < n)
            .map(([f, n]) => `${f}: baseline ${n}, actual ${actual[f] ?? 0} — lower it`);
        expect(stale, `baseline entries that should be lowered:\n${stale.join('\n')}`).toEqual([]);
    });
});
