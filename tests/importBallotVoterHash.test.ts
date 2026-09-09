import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IMPORTED_BALLOT_HASH_PREFIX } from '../lib/db/importedBallot';

// government_election_votes.voter_hash is `text NOT NULL` here, and the hosted
// exporter drops voter_hash from EVERY row of EVERY table (GLOBAL_DROP) so the
// ballots stay secret. The two facts together meant every ballot line of every
// import 23502'd — the batch insert fails, each row is retried alone, fails again,
// and is discarded into skipBreakdown.constraintViolation behind a generic "rejected
// by this instance's database" warning. 100% of a source org's election ballots,
// every time.
//
// The importer now strips any inbound voter_hash (parity with the exporter's
// GLOBAL_DROP) and then synthesises a UNIQUE, prefix-marked, non-identifying one.
// These pin the properties that make that safe, and the one that makes it a fix:
//   * the ballots actually land (the mock below reproduces the real 23502);
//   * every hash is DISTINCT — a constant would collapse every voter's vote for one
//     candidate onto a single row under uq_gov_election_vote (1 vote per candidate);
//   * no synthesised hash can be mistaken for a real computeVoterHash output;
//   * strip-then-synthesise ordering, so a crafted NDJSON can neither forge the
//     marker nor pre-seed a member's uq_gov_motion_vote_hash slot on a motion.

const h = vi.hoisted(() => ({ inserts: [] as { table: string; rows: Record<string, unknown>[] }[] }));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        const b: any = {
            select: () => b,
            insert: (rows: any) => {
                const list: Record<string, unknown>[] = Array.isArray(rows) ? rows : [rows];
                // Reproduce the real NOT-NULL constraint. Without it the mock accepts
                // anything and the "ballots are no longer discarded" assertions below
                // would pass on the unfixed tree, pinning nothing.
                if (table === 'government_election_votes' && list.some((r) => r.voter_hash == null)) {
                    return Promise.resolve({
                        data: null,
                        error: {
                            code: '23502',
                            message: 'null value in column "voter_hash" of relation "government_election_votes" violates not-null constraint',
                            details: null, hint: null,
                        },
                    });
                }
                // Capture only what the database ACCEPTED, so `inserts` is what landed.
                h.inserts.push({ table, rows: list });
                return Promise.resolve({ error: null, data: null });
            },
            update: () => b,
            delete: () => ({
                neq: () => Promise.resolve({ error: null }),
                eq: () => Promise.resolve({ error: null }),
                in: () => Promise.resolve({ error: null }),
            }),
            eq: () => Promise.resolve({ data: [], error: null }),
            in: () => b,
            range: () => Promise.resolve({ data: [], error: null }),
            // Empty-DB guard + any bare-await read resolves to an empty/zero result.
            then: (r: any) => Promise.resolve({ count: 0, error: null, data: [] }).then(r),
        };
        return b;
    };
    return {
        supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null, data: null }) },
        handleSupabaseError: () => {},
    };
});

import { importOrgData } from '../lib/db/importer';

// What an org export actually carries for a ballot: no id, no cast_at, no voter_hash.
const BALLOTS = [
    { election_id: 1, candidate_id: 10, rank_order: 1 },
    { election_id: 1, candidate_id: 11, rank_order: 2 },
    { election_id: 1, candidate_id: 10, rank_order: 1 },
];

const ndjson = (lines: string[]) => lines.join('\n');

const HEADER = JSON.stringify({
    kind: 'header', version: 1,
    tableOrder: ['government_election_votes', 'government_motion_votes'],
    manifest: { government_election_votes: 3, government_motion_votes: 1 },
});

const EXPORT_NDJSON = ndjson([
    HEADER,
    ...BALLOTS.map((r) => JSON.stringify({ kind: 'row', t: 'government_election_votes', r })),
    JSON.stringify({ kind: 'row', t: 'government_motion_votes', r: { id: 5, motion_id: 2, user_id: null, voter_hash: 'a'.repeat(64), vote: 'for' } }),
]);

const rowsFor = (table: string) => h.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);

beforeEach(() => { h.inserts = []; });

describe('org import: secret election ballots', () => {
    it('imports every ballot instead of discarding it on the NOT-NULL voter_hash', async () => {
        const result = await importOrgData(EXPORT_NDJSON);

        // The regression assertion: pre-fix all three rows 23502 and land in
        // constraintViolation, and rowsInserted counts only the motion vote.
        expect(result.skipBreakdown.constraintViolation).toBe(0);
        expect(rowsFor('government_election_votes')).toHaveLength(3);
        expect(result.rowsInserted).toBe(4); // 3 ballots + 1 motion vote
    });

    it('stamps every ballot with a marked, unique, non-identifying voter_hash', async () => {
        await importOrgData(EXPORT_NDJSON);
        const hashes = rowsFor('government_election_votes').map((r) => r.voter_hash as string);

        expect(hashes).toHaveLength(3);
        for (const hash of hashes) {
            expect(typeof hash).toBe('string');
            expect(hash.startsWith(IMPORTED_BALLOT_HASH_PREFIX)).toBe(true);
            // A real computeVoterHash is a 64-char lowercase hex HMAC. The two forms
            // must stay distinguishable by prefix alone, so the ranked-choice tally
            // can refuse imported ballots without refusing genuine ones.
            expect(hash).not.toMatch(/^[0-9a-f]{64}$/);
        }
        // DISTINCT per row. A constant would satisfy every assertion above and then
        // collide on uq_gov_election_vote (election_id, candidate_id, voter_hash),
        // silently reducing each candidate to exactly one vote.
        expect(new Set(hashes).size).toBe(3);
    });

    it('overwrites a voter_hash a crafted export tried to supply', async () => {
        const forged = 'b'.repeat(64); // shaped exactly like a real computeVoterHash output
        await importOrgData(ndjson([
            JSON.stringify({ kind: 'header', version: 1, tableOrder: ['government_election_votes'], manifest: { government_election_votes: 1 } }),
            JSON.stringify({ kind: 'row', t: 'government_election_votes', r: { election_id: 1, candidate_id: 10, rank_order: 1, voter_hash: forged } }),
        ]));

        const hash = rowsFor('government_election_votes')[0].voter_hash as string;
        // Strip-then-synthesise: the inbound value dies in SECRET_DROP_COLUMNS before
        // the synthesiser runs, so a file can never suppress the marker.
        expect(hash).not.toBe(forged);
        expect(hash.startsWith(IMPORTED_BALLOT_HASH_PREFIX)).toBe(true);
    });

    it('drops an inbound voter_hash from a secret MOTION ballot entirely', async () => {
        await importOrgData(EXPORT_NDJSON);
        const motion = rowsFor('government_motion_votes')[0];

        // government_motion_votes.voter_hash is nullable, so these rows always
        // imported — carrying whatever the file said. A crafted value equal to
        // computeVoterHash(motionId, userId) would consume that member's one-vote
        // slot via uq_gov_motion_vote_hash and lock them out of an open motion.
        expect('voter_hash' in motion).toBe(false);
        expect(motion.vote).toBe('for');
    });

    it('tells the operator what the ballots lost, instead of the generic rejection line', async () => {
        const result = await importOrgData(EXPORT_NDJSON);

        expect(result.warnings.some((w) => /^government_election_votes: 3 ballot\(s\) imported without their voter linkage/.test(w))).toBe(true);
        expect(result.warnings.some((w) => w.startsWith('government_election_votes: 3 row(s) were rejected'))).toBe(false);
    });
});
