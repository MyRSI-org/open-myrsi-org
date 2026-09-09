import { describe, it, expect, vi, beforeEach } from 'vitest';

// Election turnout quorum (min_voter_turnout_pct) enforcement.
//
// government_elections.eligible_voter_count must be written so concludeElection's
// `if (min_voter_turnout_pct && eligible_voter_count)` branch is live: otherwise a
// 1-voter election would auto-appoint its winner into a veto-capable apex office
// despite a configured quorum.
//
//   (1) advanceElection (Candidacy->Voting) snapshots a non-null
//       eligible_voter_count (count of non-deleted members holding gov:participate).
//   (2) concludeElection with a quorum set + turnout below it: status='Cancelled',
//       result.isConclusive=false, and appointPositionHolder is NOT called.
//   (3) fail-closed: quorum set but eligible_voter_count null -> Cancelled, no appoint.
//   (+) preserved flow: quorum met -> Concluded + appoints; quorum 0/unset -> Concluded.
//
// Plus (4): a tally that could not be COMPUTED is never persisted as a normal
// conclusion. Ranked-choice ballots that arrived via an org import carry a
// synthesised, prefix-marked voter_hash (the export withholds the real one), so the
// per-voter grouping IRV needs does not exist and tallyPreferentialFull refuses.
// With a negative control proving the exact-count tallies still conclude on those
// same ballots — over-applying the guard would break a legitimate re-tally.
//
// Mocks the supabase client used by elections.ts (mirrors electionVoteIntegrity)
// and stubs appointPositionHolder so we can assert the appointment side effect.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    nextId: 1,
    appointCalls: [] as unknown[],
}));

function applyEq(
    rows: Array<Record<string, unknown>>,
    filters: Record<string, unknown>,
    isNull: string[],
    inFilter: { col: string; vals: unknown[] } | null,
) {
    return rows.filter((r) => {
        for (const [c, v] of Object.entries(filters)) if (r[c] !== v) return false;
        for (const c of isNull) if (r[c] !== null && r[c] !== undefined) return false;
        if (inFilter && !inFilter.vals.includes(r[inFilter.col])) return false;
        return true;
    });
}

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | Array<Record<string, unknown>> | null,
            filters: {} as Record<string, unknown>,
            isNull: [] as string[],
            inFilter: null as { col: string; vals: unknown[] } | null,
            wantCount: false,
            headOnly: false,
            // The tally read now PAGES and then verifies its total against an exact
            // count, so the stub has to honour the window or the paging is untested.
            range: null as [number, number] | null,
        };
        const rows = () => applyEq(h.tables[table] ?? [], state.filters, state.isNull, state.inFilter);
        const b: any = {};
        b.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.count) state.wantCount = true;
            if (opts?.head) state.headOnly = true;
            return b;
        };
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown> | Array<Record<string, unknown>>) => { state.op = 'insert'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.is = (c: string, _v: null) => { state.isNull.push(c); return b; };
        b.in = (c: string, vals: unknown[]) => { state.inFilter = { col: c, vals }; return b; };
        b.order = () => b;
        b.limit = () => b;
        b.range = (from: number, to: number) => { state.range = [from, to]; return b; };

        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                if (state.wantCount) {
                    return Promise.resolve({ data: state.headOnly ? null : rows(), error: null, count: rows().length });
                }
                const all = rows();
                const data = state.range ? all.slice(state.range[0], state.range[1] + 1) : all;
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'update') { for (const r of rows()) Object.assign(r, state.values); return Promise.resolve({ data: null, error: null }); }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

// Stub the appointment path: assert it is (not) invoked without exercising the
// real RPC/holder write.
vi.mock('../lib/db/government/structure', () => ({
    appointPositionHolder: async (data: unknown) => { h.appointCalls.push(data); return { id: 1 }; },
}));

import { advanceElection, concludeElection } from '../lib/db/government/elections';
import { getVotesForElection } from '../lib/db/government/internal';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMPORTED_BALLOT_HASH_PREFIX } from '../lib/db/importedBallot';

beforeEach(() => {
    h.tables = {};
    h.nextId = 1000;
    h.appointCalls = [];
});

// gov:participate granted to role 2; users 101-103 are eligible voters, 104 is in
// a role without the permission, 105 is soft-deleted -> electorate size = 3.
function seedElectorate() {
    h.tables.permissions = [{ id: 5, name: 'gov:participate', category: 'Government' }];
    h.tables.role_permissions = [{ role_id: 2, permission_id: 5 }];
    h.tables.users = [
        { id: 101, role_id: 2, deleted_at: null },
        { id: 102, role_id: 2, deleted_at: null },
        { id: 103, role_id: 2, deleted_at: null },
        { id: 104, role_id: 9, deleted_at: null }, // role without gov:participate
        { id: 105, role_id: 2, deleted_at: '2026-01-01' }, // soft-deleted
    ];
}

function seedVotingElection(over: Record<string, unknown> = {}) {
    h.tables.government_elections = [{
        id: 1, status: 'Voting', election_type: 'SimpleMajority', max_winners: 1,
        min_candidates: 1, min_vote_threshold_pct: null, allow_runoff: false,
        runoff_top_n: 2, position_id: 3, voting_end: null,
        ...over,
    }];
    h.tables.government_election_candidates = [{ id: 7, election_id: 1, user_id: 70, withdrawn_at: null }];
}

function seedBallots(voterCount: number) {
    h.tables.government_election_votes = Array.from({ length: voterCount }, () => ({ election_id: 1, candidate_id: 7, rank_order: null }));
    h.tables.government_election_voter_registry = Array.from({ length: voterCount }, (_v, i) => ({ id: i + 1, election_id: 1, user_id: 70 + i }));
}

// A two-candidate election whose ballots came from an ORG IMPORT: the export drops
// voter_hash by design, so the importer stamps a unique IMPORTED_BALLOT_HASH_PREFIX
// value per ROW. Candidate 7 leads on raw row count (2 rows vs 1).
function seedImportedBallotElection(electionType: string) {
    seedVotingElection({ election_type: electionType, min_voter_turnout_pct: null, eligible_voter_count: null });
    h.tables.government_election_candidates = [
        { id: 7, election_id: 1, user_id: 70, withdrawn_at: null, is_winner: false },
        { id: 8, election_id: 1, user_id: 80, withdrawn_at: null, is_winner: false },
    ];
    h.tables.government_election_votes = [
        { election_id: 1, candidate_id: 7, rank_order: 1, voter_hash: `${IMPORTED_BALLOT_HASH_PREFIX}aaa` },
        { election_id: 1, candidate_id: 8, rank_order: 2, voter_hash: `${IMPORTED_BALLOT_HASH_PREFIX}bbb` },
        { election_id: 1, candidate_id: 7, rank_order: 2, voter_hash: `${IMPORTED_BALLOT_HASH_PREFIX}ccc` },
    ];
    h.tables.government_election_voter_registry = [
        { id: 1, election_id: 1, user_id: 101 },
        { id: 2, election_id: 1, user_id: 102 },
    ];
}

describe('(1) advanceElection snapshots the electorate', () => {
    it('writes a non-null eligible_voter_count at Candidacy->Voting', async () => {
        seedElectorate();
        h.tables.government_elections = [{
            id: 1, status: 'Candidacy', min_candidates: 1,
            candidacy_start: 't0', candidacy_end: null, voting_start: null,
            candidates: [{ id: 7, withdrawn_at: null }],
        }];

        await advanceElection(1);

        const row = h.tables.government_elections[0];
        expect(row.status).toBe('Voting');
        // Count of non-deleted members holding gov:participate (101,102,103).
        expect(row.eligible_voter_count).toBe(3);
        expect(typeof row.eligible_voter_count).toBe('number');
    });
});

describe('(2) turnout below quorum is not concluded', () => {
    it('cancels and never auto-appoints when turnout < min_voter_turnout_pct', async () => {
        seedVotingElection({ min_voter_turnout_pct: 50, eligible_voter_count: 10 });
        seedBallots(1); // 1 of 10 = 10% < 50%

        const res = await concludeElection(1);

        expect(res?.status).toBe('Cancelled');
        expect(res?.result.isConclusive).toBe(false);
        expect(h.appointCalls.length).toBe(0);
        expect(h.tables.government_elections[0].status).toBe('Cancelled');
    });
});

describe('(3) fail-closed when electorate size is unknown', () => {
    it('cancels (does not appoint) when a quorum is set but eligible_voter_count is null', async () => {
        seedVotingElection({ min_voter_turnout_pct: 50, eligible_voter_count: null });
        seedBallots(1); // a winner exists, but the quorum is unverifiable

        const res = await concludeElection(1);

        expect(res?.status).toBe('Cancelled');
        expect(res?.result.isConclusive).toBe(false);
        expect(h.appointCalls.length).toBe(0);
    });
});

describe('(+) legitimate flow preserved', () => {
    it('concludes and auto-appoints when the quorum IS met', async () => {
        seedVotingElection({ min_voter_turnout_pct: 50, eligible_voter_count: 2 });
        seedBallots(2); // 2 of 2 = 100% >= 50%

        const res = await concludeElection(1);

        expect(res?.status).toBe('Concluded');
        expect(res?.result.isConclusive).toBe(true);
        expect(h.appointCalls.length).toBe(1);
        expect((h.appointCalls[0] as { electionId?: number }).electionId).toBe(1);
    });

    it('concludes (no quorum gate) when min_voter_turnout_pct is 0/unset', async () => {
        seedVotingElection({ min_voter_turnout_pct: null, eligible_voter_count: null });
        seedBallots(1); // single voter, but no quorum required

        const res = await concludeElection(1);

        expect(res?.status).toBe('Concluded');
        expect(res?.result.isConclusive).toBe(true);
        expect(h.appointCalls.length).toBe(1);
    });
});

describe('(4) an uncomputable tally is never recorded as a normal conclusion', () => {
    it('refuses to rank IMPORTED ballots and appoints nobody', async () => {
        seedImportedBallotElection('Preferential');

        const res = await concludeElection(1);

        // Without the guard each imported row is its own single-preference ballot:
        // the rank-2 rows would count as FIRST preferences, candidate 7 would "win"
        // 2-1 on a tally that never happened, and be appointed to the position.
        expect(res?.result.isConclusive).toBe(false);
        expect(res?.status).toBe('Cancelled');
        expect(res?.conclusionReason).toMatch(/cannot be re-tallied here/);
        expect(h.tables.government_elections[0].status).toBe('Cancelled');
        expect(h.tables.government_elections[0].conclusion_reason).toMatch(/cannot be re-tallied here/);
        // Nobody is crowned and nobody takes office.
        expect(h.tables.government_election_candidates.some((c) => c.is_winner === true)).toBe(false);
        expect(h.appointCalls.length).toBe(0);
    });

    it('STILL concludes a PLURALITY election whose ballots were imported', async () => {
        // The negative control. Per-candidate totals survive an import EXACTLY (the
        // export keeps one row per (voter, candidate)), so the counting tallies must
        // NOT be guarded — only the ranked-choice one, which needs the lost grouping.
        seedImportedBallotElection('Plurality');

        const res = await concludeElection(1);

        expect(res?.status).toBe('Concluded');
        expect(res?.result.isConclusive).toBe(true);
        const byId = (id: number) => h.tables.government_election_candidates.find((c) => c.id === id)!;
        expect(byId(7).vote_count).toBe(2);
        expect(byId(7).is_winner).toBe(true);
        expect(byId(8).vote_count).toBe(1);
        expect(byId(8).is_winner).toBe(false);
        expect(h.appointCalls.length).toBe(1);
    });

    it('records a genuinely inconclusive tally with its real reason (preferential, no ballots)', async () => {
        // Pre-existing behaviour change: tallyPreferentialFull already returned
        // 'No votes cast', but concludeElection ignored `reason` and filed the
        // election as Concluded / "Election concluded normally".
        seedVotingElection({ election_type: 'Preferential', min_voter_turnout_pct: null, eligible_voter_count: null });
        seedBallots(0);

        const res = await concludeElection(1);

        expect(res?.status).toBe('Cancelled');
        expect(res?.conclusionReason).toBe('No votes cast');
        expect(h.appointCalls.length).toBe(0);
    });

    it('records a genuinely inconclusive tally with its real reason (counting tally, no ballots)', async () => {
        // Same contract for the non-preferential tallies, or four of the five election
        // types would still file a zero-ballot election as having concluded normally.
        seedVotingElection({ election_type: 'Plurality', min_voter_turnout_pct: null, eligible_voter_count: null });
        seedBallots(0);

        const res = await concludeElection(1);

        expect(res?.status).toBe('Cancelled');
        expect(res?.conclusionReason).toBe('No votes cast');
        expect(h.appointCalls.length).toBe(0);
    });
});

describe('a tally reads EVERY ballot, or refuses to report one', () => {
    // This was a single unbounded, unordered select. PostgREST answers an unbounded
    // select with its server-side maximum and a 200, so an election larger than that
    // cap tallied a SUBSET of ballots and returned a winner — not a degraded read, a
    // WRONG RESULT presented with the same confidence as a right one, in the module
    // whose entire purpose is that the count can be trusted.
    it('pages past the first 1000 ballots instead of counting a truncated page', async () => {
        // 1500 ballots, 900 for candidate 1 and 600 for candidate 2. Under a single
        // 1000-row read the winner would be decided on the first 1000 rows only.
        h.tables['government_election_votes'] = [
            ...Array.from({ length: 900 }, (_, i) => ({ id: `a${i}`, election_id: 1, candidate_id: 1, rank_order: null })),
            ...Array.from({ length: 600 }, (_, i) => ({ id: `b${i}`, election_id: 1, candidate_id: 2, rank_order: null })),
        ];
        const votes = await getVotesForElection(1);
        expect(votes, 'the tally read stopped at the first page').toHaveLength(1500);
        expect(votes.filter(v => v.candidate_id === 2)).toHaveLength(600);
    });

    it('an empty election is still fine (the loop terminates on a short first page)', async () => {
        h.tables['government_election_votes'] = [];
        expect(await getVotesForElection(1)).toEqual([]);
    });

    it('verifies the page total against an exact count, and refuses on a mismatch', () => {
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'government', 'internal.ts'), 'utf8');
        const fn = src.slice(src.indexOf('export async function getVotesForElection'), src.indexOf('export async function getVoterCount'));
        expect(fn, 'the count verification is gone — a mid-read insert would be half-counted').toMatch(/count: 'exact'/);
        expect(fn).toMatch(/count !== out\.length/);
        expect(fn).toMatch(/\.range\(/);
        expect(fn, 'paging without a total order can repeat and drop rows across pages').toMatch(/\.order\('id'/);
    });

    it('the turnout DENOMINATOR fails closed rather than defaulting to zero', () => {
        // `count || 0` turned any read fault into "nobody was eligible", so the
        // min_voter_turnout_pct check compared against zero and an election could be
        // certified on a quorum that was never actually tested.
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'government', 'internal.ts'), 'utf8');
        const fn = src.slice(src.indexOf('export async function getVoterCount'), src.indexOf('export function tallySimpleMajority'));
        expect(fn).toMatch(/handleSupabaseError/);
        expect(fn, 'a null count still reads as zero voters').not.toMatch(/return count \|\| 0/);
    });
});
