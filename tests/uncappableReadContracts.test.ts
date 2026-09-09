import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from './stripComments';

// The inverse of tests/listReadOrderRatchet.test.ts.
//
// That file records unbounded reads as a budget to shrink. THESE reads must never be capped at
// all, and the distinction is not a performance judgement — capping any of them is a correctness
// bug with a specific, named consequence:
//
//   * the media GC's reference set        -> a short read DELETES live images
//   * push recipient fan-out              -> silently undelivered notifications
//   * an outbound federation roster       -> `memberCount` becomes a lie to a peer
//   * the wiki import slug map            -> an overwrite becomes a duplicate insert
//   * finance aggregate sums              -> a wrong balance presented as fact
//   * cascade-delete id collection        -> a RESTRICT foreign key blocks the delete midway
//   * election ballots and tallies        -> a wrong election result presented as fact
//
// The repo has been bitten by exactly this shape before: the finance ledger CSV silently stopping
// at 500 rows was a Phase 1 defect. The point of pinning it as a TEST rather than a comment is
// that a comment is deleted by whoever is "finishing the job" of adding caps everywhere.
//
// If a read here genuinely outgrows memory, the answer is exhaustive PAGING or a count-verified
// refusal — never a bare `.limit()`. Both idioms already exist in the tree: see
// `exportLedgerCsv` (paged, marks truncation IN the artifact) and `readInventoryOnHand`
// (compares rows.length to an exact count and REFUSES).

const ROOT = resolve(__dirname, '..');

/** Extract a named function's body by brace matching from its declaration. */
function functionBody(src: string, name: string): string {
    const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(src);
    if (!decl) throw new Error(`function ${name} not found — it was renamed; update this contract`);
    const open = src.indexOf('{', decl.index);
    if (open === -1) throw new Error(`no body for ${name}`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`unbalanced body for ${name}`);
}

// Comment blanking is the shared, string-aware helper (tests/stripComments.ts).

interface Contract { file: string; fn: string; why: string }

const UNCAPPABLE: Contract[] = [
    { file: 'lib/orgMediaGc.ts', fn: 'gatherReferencedKeys', why: 'a short reference set makes the nightly sweep DELETE live images' },
    { file: 'lib/db/alliances.ts', fn: 'getAllyRosterProjection', why: 'an outbound federation payload; a short read makes memberCount a lie to the peer' },
    { file: 'lib/db/wiki.ts', fn: 'importWikiPages', why: 'the slug map; a short read turns an overwrite into a duplicate insert' },
    // getFinancesOverview no longer READS rows at all — it calls finance_overview_stats(),
    // so the contract went VACUOUS rather than red (the assertion is the absence of a
    // `.limit()`, and there is nothing left to truncate). Swapped for the read that now
    // carries the same property: listTreasuryAccounts feeds the account list the overview
    // renders, and a short page there is a missing account, silently.
    { file: 'lib/db/finances.ts', fn: 'listTreasuryAccounts', why: 'every active account feeds the treasury view; a short read hides one' },
    { file: 'lib/db/government/internal.ts', fn: 'getVotesForElection', why: 'election integrity — a truncated ballot set is a wrong result presented as fact' },
    { file: 'lib/db/government/internal.ts', fn: 'tallyPreferentialFull', why: 'election integrity — as above, and preferential rounds compound the error' },
    { file: 'lib/db/quartermaster.ts', fn: 'deleteQmLocation', why: 'cascade-delete id collection under RESTRICT FKs; a short read blocks the delete midway' },
    { file: 'lib/db/warehouse.ts', fn: 'deleteWarehouseCatalogItem', why: 'cascade-delete id collection under RESTRICT FKs; as above' },
    { file: 'lib/push.ts', fn: 'loadRecipientProfiles', why: 'push recipient fan-out; a cap is silently undelivered notifications' },
    { file: 'lib/push.ts', fn: 'filterLiveRecipients', why: 'push recipient fan-out; as above' },
];

describe('reads that must never be capped', () => {
    it.each(UNCAPPABLE)('$file $fn stays uncapped — $why', ({ file, fn }) => {
        const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
        const body = functionBody(src, fn);
        expect(body).not.toMatch(/\.limit\s*\(/);
    });

    // The contracts are only worth anything if the functions still exist. A rename that silently
    // dropped an entry would leave the read unprotected with every test still green.
    it('every contract names a function that exists', () => {
        for (const { file, fn } of UNCAPPABLE) {
            const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
            expect(() => functionBody(src, fn), `${file} ${fn}`).not.toThrow();
        }
        expect(UNCAPPABLE.length).toBeGreaterThanOrEqual(10);
    });

    // The two sanctioned alternatives to a bare cap, kept discoverable. If someone needs to bound
    // one of the reads above, these are the shapes to copy.
    it('the paging and count-verify idioms both still exist to copy', () => {
        const finances = readFileSync(join(ROOT, 'lib/db/finances.ts'), 'utf8');
        // Paged export that marks truncation in the artifact rather than hiding it.
        expect(finances).toMatch(/TRUNCATED/);
        const qm = readFileSync(join(ROOT, 'lib/db/quartermaster.ts'), 'utf8');
        // Count-verified refusal: rows.length < count => throw rather than answer from a
        // half-read table.
        expect(qm).toMatch(/rows\.length\s*<\s*count/);
    });
});
