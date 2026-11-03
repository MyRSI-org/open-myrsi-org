import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/government/elections.ts — election lifecycle, the secret ballot and the
// conclusion (tally → thresholds → ties → persistence → auto-appointment).
//
// The appointment path is NOT stubbed: concludeElection drives the real
// appointPositionHolder in structure.ts, so the gov_appoint_holder RPC arguments a
// winner produces are asserted directly.

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());
// structure.ts → orgMediaDocs → storage imports the storage client; nothing here signs media.
vi.mock('../lib/supabaseServer', () => ({ supabase: { storage: { from: () => ({}) } }, handleSupabaseError: () => {} }));

import {
    fake, on, only, queries, eqs, calls, writeLog, resetFake, assertNoWildcards, govBroadcasts, type FakeQuery,
} from './cov-db-government-fake';
import {
    getElectionsState, createElection, updateElection, advanceElection, declareCandidacy, withdrawCandidacy,
    castElectionVote, concludeElection, callByElection, cancelElection, certifyElection,
} from '../lib/db/government/elections';
import { computeVoterHash, log, USER_HYDRATE } from '../lib/db/government/internal';
import type { GovernmentElection } from '../types';

type Row = Record<string, unknown>;

const ELECTION_COLUMNS = 'id, position_id, title, description, election_type, status, candidacy_start, candidacy_end, voting_start, voting_end, min_candidates, max_winners, min_voter_turnout_pct, min_vote_threshold_pct, allow_runoff, runoff_top_n, parent_election_id, is_by_election, remaining_term_days, created_by_id, concluded_at, conclusion_reason, certified_by_id, certified_at, eligible_voter_count, total_votes_cast, created_at, updated_at';

beforeEach(() => { resetFake(); });
afterEach(() => { assertNoWildcards(); vi.restoreAllMocks(); });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// getElectionsState
// ---------------------------------------------------------------------------

function electionRow(over: Row = {}): Row {
    return {
        id: 1, position_id: 3, title: 'Race', description: null, election_type: 'SimpleMajority', status: 'Voting',
        min_candidates: 1, max_winners: 1, allow_runoff: false, runoff_top_n: 2, is_by_election: false,
        created_by_id: 7, created_at: 't', updated_at: 't',
        candidates: [
            { id: 70, election_id: 1, user_id: 7, declared_at: 'd', withdrawn_at: null, is_winner: false, vote_count: 5, vote_percentage: '62.5' },
            { id: 71, election_id: 1, user_id: 8, declared_at: 'd', withdrawn_at: '2026-01-01', is_winner: false, vote_count: 3, vote_percentage: '37.5' },
        ],
        ...over,
    };
}

describe('getElectionsState', () => {
    it('reads the newest 50 elections with explicit columns and a total order', async () => {
        on('government_elections', 'select', { data: [] });
        await expect(getElectionsState()).resolves.toEqual([]);
        const q = only('government_elections', 'select');
        expect(q.columns).toContain(`created_by:users!government_elections_created_by_id_fkey(${USER_HYDRATE})`);
        expect(q.columns).toContain(`user:users!government_election_candidates_user_id_fkey(${USER_HYDRATE})`);
        expect(q.columns).toMatch(/^id, position_id, title,/);
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'limit')).toEqual([[50]]);
    });

    it('hides withdrawn candidates and every tally until the election has concluded', async () => {
        on('government_elections', 'select', { data: [electionRow({ status: 'Voting' }), electionRow({ id: 2, status: 'Cancelled' })] });
        const [voting, cancelled] = await getElectionsState();
        for (const e of [voting, cancelled]) {
            expect(e.candidates!.map(c => c.id)).toEqual([70]);
            expect(e.candidates![0].voteCount).toBeUndefined();
            expect(e.candidates![0].votePercentage).toBeUndefined();
        }
    });

    it('shows the tally once concluded', async () => {
        on('government_elections', 'select', { data: [electionRow({ status: 'Concluded' })] });
        const [e] = await getElectionsState();
        expect(e.candidates).toEqual([expect.objectContaining({ id: 70, voteCount: 5, votePercentage: 62.5 })]);
    });

    it('stamps hasVoted for the viewer from the voter registry of the elections in Voting', async () => {
        on('government_elections', 'select', { data: [electionRow({ id: 1 }), electionRow({ id: 2 }), electionRow({ id: 3, status: 'Concluded' })] });
        on('government_election_voter_registry', 'select', { data: [{ election_id: 2 }] });
        const out = await getElectionsState(42);
        const reg = only('government_election_voter_registry', 'select');
        expect(reg.columns).toBe('election_id');
        expect(eqs(reg)).toEqual({ user_id: 42 });
        expect(calls(reg, 'in')).toEqual([['election_id', [1, 2]]]);
        expect(out.map(e => [e.id, e.hasVoted])).toEqual([[1, false], [2, true], [3, false]]);
    });

    it('no viewer, or nothing in Voting, makes no registry read', async () => {
        on('government_elections', 'select', { data: [electionRow()] });
        const [anon] = await getElectionsState();
        expect(anon.hasVoted).toBeUndefined();
        resetFake();
        on('government_elections', 'select', { data: [electionRow({ status: 'Draft', candidates: null })] });
        const [draft] = await getElectionsState(42);
        expect(draft.hasVoted).toBeUndefined();
        expect(draft.candidates).toBeUndefined();
        expect(queries('government_election_voter_registry')).toHaveLength(0);
    });

    it('a failed registry read leaves every hasVoted false rather than guessing', async () => {
        on('government_elections', 'select', { data: [electionRow()] });
        on('government_election_voter_registry', 'select', { error: { message: 'x' } });
        const [e] = await getElectionsState(42);
        expect(e.hasVoted).toBe(false);
    });

    it('a failed election read degrades to an empty list', async () => {
        on('government_elections', 'select', { error: { code: 'XX000', message: 'boom' } });
        await expect(getElectionsState(42)).resolves.toEqual([]);
        expect(fake.safeFetchFallbacks).toEqual(['government_elections']);
    });
});

// ---------------------------------------------------------------------------
// createElection / updateElection / callByElection / cancel / certify
// ---------------------------------------------------------------------------

describe('createElection', () => {
    it('inserts a Draft with safe defaults and returns the mapped election', async () => {
        on('government_elections', 'insert', { data: { id: 9, position_id: 3, title: 'Race', election_type: 'SimpleMajority', status: 'Draft', min_candidates: 1, max_winners: 1, allow_runoff: false, runoff_top_n: 2, is_by_election: false, created_by_id: 7, created_at: 't', updated_at: 't' } });
        const e = await createElection({ positionId: 3, title: 'Race', userId: 7 });
        const q = only('government_elections', 'insert');
        expect(q.values).toEqual({
            position_id: 3, title: 'Race', description: null, election_type: 'SimpleMajority', status: 'Draft',
            candidacy_start: null, candidacy_end: null, voting_start: null, voting_end: null,
            min_candidates: 1, max_winners: 1, min_voter_turnout_pct: null, min_vote_threshold_pct: null,
            allow_runoff: false, runoff_top_n: 2, is_by_election: false, remaining_term_days: null, created_by_id: 7,
        });
        expect(q.returning).toBe(ELECTION_COLUMNS);
        expect(q.terminal).toBe('single');
        expect(e).toMatchObject({ id: 9, status: 'Draft', createdById: 7 });
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('carries every supplied rule through', async () => {
        on('government_elections', 'insert', { data: null });
        await expect(createElection({
            positionId: 3, title: 'Race', description: 'd', electionType: 'Approval', candidacyStart: 'a', candidacyEnd: 'b',
            votingStart: 'c', votingEnd: 'e', minCandidates: 2, maxWinners: 3, minVoterTurnoutPct: 40, minVoteThresholdPct: 10,
            allowRunoff: true, runoffTopN: 4, isByElection: true, remainingTermDays: 12, userId: 7,
        })).resolves.toBeNull();
        expect(only('government_elections', 'insert').values).toEqual({
            position_id: 3, title: 'Race', description: 'd', election_type: 'Approval', status: 'Draft',
            candidacy_start: 'a', candidacy_end: 'b', voting_start: 'c', voting_end: 'e',
            min_candidates: 2, max_winners: 3, min_voter_turnout_pct: 40, min_vote_threshold_pct: 10,
            allow_runoff: true, runoff_top_n: 4, is_by_election: true, remaining_term_days: 12, created_by_id: 7,
        });
    });

    it('surfaces an insert failure with the caller message and does not broadcast', async () => {
        on('government_elections', 'insert', { error: { message: 'violates fk' } });
        await expect(createElection({ positionId: 3, title: 'x', userId: 7 })).rejects.toThrow('Failed to create election');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('updateElection', () => {
    it('writes only the supplied fields (plus updated_at) and skips the status read for cosmetic edits', async () => {
        await updateElection(4, { title: 'New', description: 'D', candidacyStart: 'a', candidacyEnd: 'b', votingStart: 'c', votingEnd: 'd' });
        expect(queries('government_elections', 'select')).toHaveLength(0);
        const u = only('government_elections', 'update');
        expect(u.values).toEqual({ title: 'New', description: 'D', candidacy_start: 'a', candidacy_end: 'b', voting_start: 'c', voting_end: 'd', updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 4 });
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('maps every outcome field while the election is a Draft', async () => {
        on('government_elections', 'select', { data: { status: 'Draft' } });
        await updateElection(4, { electionType: 'Approval', minCandidates: 2, maxWinners: 3, minVoterTurnoutPct: 30, minVoteThresholdPct: 20, allowRunoff: true, runoffTopN: 3 } as Partial<GovernmentElection>);
        const s = only('government_elections', 'select');
        expect(s.columns).toBe('status');
        expect(eqs(s)).toEqual({ id: 4 });
        expect(only('government_elections', 'update').values).toEqual({
            election_type: 'Approval', min_candidates: 2, max_winners: 3, min_voter_turnout_pct: 30,
            min_vote_threshold_pct: 20, allow_runoff: true, runoff_top_n: 3, updated_at: expect.stringMatching(ISO),
        });
    });

    it('an outcome edit fails closed on an unreadable status', async () => {
        on('government_elections', 'select', { error: { message: 'x' } });
        await expect(updateElection(4, { maxWinners: 2 })).rejects.toThrow('Failed to load election');
        expect(queries('government_elections', 'update')).toHaveLength(0);
    });

    it('an outcome edit is refused once voting has opened', async () => {
        on('government_elections', 'select', { data: { status: 'Voting' } });
        await expect(updateElection(4, { allowRunoff: true })).rejects.toThrow('The rules of an election can only be changed while it is a draft.');
        expect(queries('government_elections', 'update')).toHaveLength(0);
    });

    it('an empty patch writes nothing and broadcasts nothing', async () => {
        await updateElection(4, {});
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('a write failure surfaces the caller message', async () => {
        on('government_elections', 'update', { error: { message: 'x' } });
        await expect(updateElection(4, { title: 'x' })).rejects.toThrow('Failed to update election');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('callByElection', () => {
    it('creates a by-election that inherits the position term length', async () => {
        on('government_positions', 'select', { data: { term_length_days: 90 } });
        on('government_elections', 'insert', { data: null });
        await callByElection({ positionId: 3, title: 'By', userId: 7 });
        const p = only('government_positions', 'select');
        expect(p.columns).toBe('term_length_days');
        expect(eqs(p)).toEqual({ id: 3 });
        expect(only('government_elections', 'insert').values).toMatchObject({ position_id: 3, title: 'By', is_by_election: true, remaining_term_days: 90, created_by_id: 7, status: 'Draft' });
    });

    it('a position without a term (or not found) leaves the remaining term empty', async () => {
        on('government_positions', 'select', { data: null });
        on('government_elections', 'insert', { data: null });
        await callByElection({ positionId: 3, title: 'By', userId: 7, remainingTermDays: 400 });
        expect(only('government_elections', 'insert').values).toMatchObject({ is_by_election: true, remaining_term_days: null });
    });
});

describe('cancelElection / certifyElection', () => {
    it('cancels only an election that has not concluded, defaulting the reason', async () => {
        await cancelElection(5, '');
        const u = only('government_elections', 'update');
        expect(u.values).toEqual({ status: 'Cancelled', concluded_at: expect.stringMatching(ISO), conclusion_reason: 'Cancelled by electoral officer', updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 5 });
        expect(calls(u, 'in')).toEqual([['status', ['Draft', 'Candidacy', 'Voting']]]);
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('records a supplied cancellation reason', async () => {
        await cancelElection(5, 'Irregularities');
        expect((only('government_elections', 'update').values as Row).conclusion_reason).toBe('Irregularities');
    });

    it('a cancel write failure surfaces', async () => {
        on('government_elections', 'update', { error: { message: 'x' } });
        await expect(cancelElection(5, 'r')).rejects.toThrow('Failed to cancel election');
    });

    it('certifies only a Concluded election, stamping the certifier', async () => {
        await certifyElection(5, 7);
        const u = only('government_elections', 'update');
        expect(u.values).toEqual({ certified_by_id: 7, certified_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 5, status: 'Concluded' });
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('a certify write failure surfaces', async () => {
        on('government_elections', 'update', { error: { message: 'x' } });
        await expect(certifyElection(5, 7)).rejects.toThrow('Failed to certify election');
    });
});

// ---------------------------------------------------------------------------
// advanceElection
// ---------------------------------------------------------------------------

describe('advanceElection', () => {
    const cands = (n: number, withdrawn = 0) => [
        ...Array.from({ length: n }, (_, i) => ({ id: i + 1, withdrawn_at: null })),
        ...Array.from({ length: withdrawn }, (_, i) => ({ id: 100 + i, withdrawn_at: 'w' })),
    ];

    it('an unreadable or missing election is "not found"', async () => {
        on('government_elections', 'select', { error: { message: 'x' } });
        await expect(advanceElection(1)).rejects.toThrow('Election not found');
        resetFake();
        on('government_elections', 'select', { data: null });
        await expect(advanceElection(1)).rejects.toThrow('Election not found');
        expect(writeLog()).toEqual([]);
    });

    it('Draft → Candidacy, stamping candidacy_start only when unset', async () => {
        on('government_elections', 'select', { data: { id: 1, status: 'Draft', candidacy_start: null, candidates: [] } });
        await advanceElection(1);
        const read = only('government_elections', 'select');
        expect(read.columns).toBe('id, status, candidacy_start, candidacy_end, voting_start, min_candidates, candidates:government_election_candidates(id, withdrawn_at)');
        const u = only('government_elections', 'update');
        expect(u.values).toEqual({ status: 'Candidacy', candidacy_start: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 1 });
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);

        resetFake();
        on('government_elections', 'select', { data: { id: 1, status: 'Draft', candidacy_start: 'scheduled', candidates: null } });
        await advanceElection(1);
        expect((only('government_elections', 'update').values as Row).candidacy_start).toBe('scheduled');
    });

    it('a failed Draft → Candidacy write surfaces and does not broadcast', async () => {
        on('government_elections', 'select', { data: { id: 1, status: 'Draft', candidates: [] } });
        on('government_elections', 'update', { error: { message: 'x' } });
        await expect(advanceElection(1)).rejects.toThrow('Failed to advance election to Candidacy');
        expect(govBroadcasts()).toEqual([]);
    });

    it('Candidacy → Voting is refused below min_candidates, not counting withdrawn ones', async () => {
        on('government_elections', 'select', { data: { id: 1, status: 'Candidacy', min_candidates: 2, candidates: cands(1, 3) } });
        await expect(advanceElection(1)).rejects.toThrow('Need at least 2 candidate(s), currently 1');
        expect(writeLog()).toEqual([]);
    });

    it('Candidacy → Voting snapshots the electorate: non-deleted members of roles holding gov:participate', async () => {
        on('government_elections', 'select', { data: { id: 1, status: 'Candidacy', min_candidates: 1, candidacy_end: null, voting_start: 'set', candidates: cands(2) } });
        on('permissions', 'select', { data: { id: 5 } });
        on('role_permissions', 'select', { data: [{ role_id: 2 }, { role_id: 4 }] });
        on('users', 'select', { count: 17 });
        await advanceElection(1);

        const perm = only('permissions', 'select');
        expect(perm.columns).toBe('id');
        expect(eqs(perm)).toEqual({ name: 'gov:participate' });
        const rp = only('role_permissions', 'select');
        expect(rp.columns).toBe('role_id');
        expect(eqs(rp)).toEqual({ permission_id: 5 });
        const users = only('users', 'select');
        expect(users.columns).toBe('id');
        expect(users.selectOpts).toEqual({ count: 'exact', head: true });
        expect(calls(users, 'in')).toEqual([['role_id', [2, 4]]]);
        expect(calls(users, 'is')).toEqual([['deleted_at', null]]);

        expect(only('government_elections', 'update').values).toEqual({
            status: 'Voting', candidacy_end: expect.stringMatching(ISO), voting_start: 'set', eligible_voter_count: 17, updated_at: expect.stringMatching(ISO),
        });
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it.each([
        ['the permission row is missing', () => { on('permissions', 'select', { data: null }); }, ['permissions']],
        ['no role holds it', () => { on('permissions', 'select', { data: { id: 5 } }); on('role_permissions', 'select', { data: null }); }, ['permissions', 'role_permissions']],
        ['the member count is unreadable', () => { on('permissions', 'select', { data: { id: 5 } }); on('role_permissions', 'select', { data: [{ role_id: 2 }] }); on('users', 'select', { count: null }); }, ['permissions', 'role_permissions', 'users']],
    ])('snapshots an electorate of 0 when %s (the quorum then fails closed)', async (_label, seed, tables) => {
        on('government_elections', 'select', { data: { id: 1, status: 'Candidacy', min_candidates: 1, candidates: cands(1) } });
        seed();
        await advanceElection(1);
        expect((only('government_elections', 'update').values as Row).eligible_voter_count).toBe(0);
        expect(fake.queries.filter(q => q.op === 'select' && q.table !== 'government_elections').map(q => q.table)).toEqual(tables);
    });

    it('a failed Candidacy → Voting write surfaces', async () => {
        on('government_elections', 'select', { data: { id: 1, status: 'Candidacy', min_candidates: 0, candidates: [] } });
        on('government_elections', 'update', { error: { message: 'x' } });
        await expect(advanceElection(1)).rejects.toThrow('Failed to advance election to Voting');
    });

    it('Voting → hands off to concludeElection (which re-reads the full election)', async () => {
        on('government_elections', 'select',
            { data: { id: 1, status: 'Voting', candidates: [] } },
            { data: null });
        await expect(advanceElection(1)).rejects.toThrow('Election not found');
        expect(queries('government_elections', 'select')).toHaveLength(2);
    });

    it('Voting → a successful conclusion broadcasts once (from the conclusion, not twice)', async () => {
        seedConclude({ votes: [{ candidate_id: 70 }] });
        await expect(advanceElection(1)).resolves.toBeUndefined();
        expect((electionUpdate().values as Row).status).toBe('Concluded');
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }, { slices: ['elections'] }]);
    });

    it.each(['Concluded', 'Cancelled', 'Runoff'])('refuses to advance from %s', async (status) => {
        on('government_elections', 'select', { data: { id: 1, status, candidates: [] } });
        await expect(advanceElection(1)).rejects.toThrow(`Cannot advance election from status: ${status}`);
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Candidacy
// ---------------------------------------------------------------------------

describe('declareCandidacy / withdrawCandidacy', () => {
    it('is refused outside the candidacy phase (or for an unknown election)', async () => {
        on('government_elections', 'select', { data: { status: 'Voting' } });
        await expect(declareCandidacy(1, 7, 'x')).rejects.toThrow('Election is not in candidacy phase');
        resetFake();
        on('government_elections', 'select', { data: null });
        await expect(declareCandidacy(1, 7, 'x')).rejects.toThrow('Election is not in candidacy phase');
        expect(writeLog()).toEqual([]);
    });

    it('checks for an existing active candidacy, then inserts and returns the mapped row', async () => {
        on('government_elections', 'select', { data: { status: 'Candidacy' } });
        on('government_election_candidates', 'select', { count: 0 });
        on('government_election_candidates', 'insert', { data: { id: 70, election_id: 1, user_id: 7, platform_statement: 'Vote me', declared_at: 'd', withdrawn_at: null, is_winner: false, vote_count: null, vote_percentage: null } });
        const c = await declareCandidacy(1, 7, 'Vote me');

        const pre = only('government_election_candidates', 'select');
        expect(pre.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(pre)).toEqual({ election_id: 1, user_id: 7 });
        expect(calls(pre, 'is')).toEqual([['withdrawn_at', null]]);
        const ins = only('government_election_candidates', 'insert');
        expect(ins.values).toEqual({ election_id: 1, user_id: 7, platform_statement: 'Vote me' });
        expect(ins.returning).toBe('id, election_id, user_id, platform_statement, declared_at, withdrawn_at, is_winner, vote_count, vote_percentage');
        expect(c).toMatchObject({ id: 70, electionId: 1, userId: 7, platformStatement: 'Vote me' });
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('an empty statement is stored as null, and a null insert result maps to null', async () => {
        on('government_elections', 'select', { data: { status: 'Candidacy' } });
        on('government_election_candidates', 'insert', { data: null });
        await expect(declareCandidacy(1, 7, '')).resolves.toBeNull();
        expect((only('government_election_candidates', 'insert').values as Row).platform_statement).toBeNull();
    });

    it('a generic insert failure surfaces the caller message', async () => {
        on('government_elections', 'select', { data: { status: 'Candidacy' } });
        on('government_election_candidates', 'insert', { error: { code: '23503', message: 'fk' } });
        await expect(declareCandidacy(1, 7, null)).rejects.toThrow('Failed to declare candidacy');
        expect(govBroadcasts()).toEqual([]);
    });

    it('withdraws only the caller\'s active candidacy in that election', async () => {
        await withdrawCandidacy(1, 7);
        const u = only('government_election_candidates', 'update');
        expect(u.values).toEqual({ withdrawn_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ election_id: 1, user_id: 7 });
        expect(calls(u, 'is')).toEqual([['withdrawn_at', null]]);
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('a withdraw failure surfaces', async () => {
        on('government_election_candidates', 'update', { error: { message: 'x' } });
        await expect(withdrawCandidacy(1, 7)).rejects.toThrow('Failed to withdraw candidacy');
    });
});

// ---------------------------------------------------------------------------
// castElectionVote — the secret ballot
// ---------------------------------------------------------------------------

describe('castElectionVote', () => {
    function seedBallotBox(election: Row, candidates: Row[], alreadyVoted = 0) {
        on('government_elections', 'select', { data: { status: 'Voting', election_type: 'SimpleMajority', max_winners: 1, ...election } });
        on('government_election_candidates', 'select', { data: candidates });
        on('government_election_voter_registry', 'select', { count: alreadyVoted });
    }
    const cand = (id: number, over: Row = {}) => ({ id, election_id: 1, withdrawn_at: null, ...over });

    it.each([[[]], [null], ['not-an-array']])('rejects a missing ballot (%j) before any read', async (sel) => {
        await expect(castElectionVote(1, 7, sel as never)).rejects.toThrow('No selections provided');
        expect(fake.queries).toEqual([]);
    });

    it('rejects an oversized ballot before any read', async () => {
        await expect(castElectionVote(1, 7, Array.from({ length: 65 }, (_, i) => ({ candidateId: i })))).rejects.toThrow('Too many selections');
        expect(fake.queries).toEqual([]);
    });

    it('accepts a ballot of exactly the 64-selection ceiling', async () => {
        seedBallotBox({ election_type: 'Preferential' }, Array.from({ length: 64 }, (_, i) => cand(i + 1)));
        await castElectionVote(1, 7, Array.from({ length: 64 }, (_, i) => ({ candidateId: i + 1, rankOrder: i + 1 })));
        expect((only('government_election_votes', 'insert').values as Row[])).toHaveLength(64);
    });

    it('is refused outside the voting phase', async () => {
        on('government_elections', 'select', { data: { status: 'Candidacy' } });
        await expect(castElectionVote(1, 7, [{ candidateId: 1 }])).rejects.toThrow('Election is not in voting phase');
        const read = only('government_elections', 'select');
        expect(read.columns).toBe('status, election_type, max_winners');
        expect(eqs(read)).toEqual({ id: 1 });
        expect(writeLog()).toEqual([]);
    });

    it('rejects a ballot with no well-formed candidate id', async () => {
        on('government_elections', 'select', { data: { status: 'Voting', election_type: 'SimpleMajority', max_winners: 1 } });
        await expect(castElectionVote(1, 7, [{ candidateId: 1.5 }, { candidateId: 'x' as never }, null as never])).rejects.toThrow('No valid selections provided');
        expect(writeLog()).toEqual([]);
    });

    it('records participation then writes an UNLINKABLE ballot (voter_hash, never user_id)', async () => {
        seedBallotBox({}, [cand(70)]);
        await castElectionVote(1, 7, [{ candidateId: 70 }, { candidateId: 71 }]);

        // Single-choice method: only the first distinct candidate is validated and cast.
        expect(calls(only('government_election_candidates', 'select'), 'in')).toEqual([['id', [70]]]);
        expect(only('government_election_candidates', 'select').columns).toBe('id, election_id, withdrawn_at');
        const already = only('government_election_voter_registry', 'select');
        expect(already.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(already)).toEqual({ election_id: 1, user_id: 7 });

        // Participation is recorded BEFORE the ballot (the unique registry row is the guard).
        expect(writeLog()).toEqual(['government_election_voter_registry:insert', 'government_election_votes:insert']);
        expect(only('government_election_voter_registry', 'insert').values).toEqual({ election_id: 1, user_id: 7 });
        const rows = only('government_election_votes', 'insert').values as Row[];
        expect(rows).toEqual([{ election_id: 1, voter_hash: computeVoterHash(1, 7), candidate_id: 70, rank_order: null }]);
        expect(rows[0]).not.toHaveProperty('user_id');
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });

    it('a preferential ballot keeps one row per distinct candidate with its rank', async () => {
        seedBallotBox({ election_type: 'Preferential' }, [cand(70), cand(71), cand(72)]);
        await castElectionVote(1, 7, [{ candidateId: 72, rankOrder: 1 }, { candidateId: 70, rankOrder: 2 }, { candidateId: 72, rankOrder: 3 }, { candidateId: 71 }]);
        expect((only('government_election_votes', 'insert').values as Row[]).map(r => [r.candidate_id, r.rank_order])).toEqual([[72, 1], [70, 2], [71, null]]);
    });

    it('an approval ballot is capped at max_winners, and a null max_winners means one', async () => {
        seedBallotBox({ election_type: 'Approval', max_winners: null }, [cand(70), cand(71)]);
        await castElectionVote(1, 7, [{ candidateId: 70 }, { candidateId: 71 }]);
        expect((only('government_election_votes', 'insert').values as Row[]).map(r => r.candidate_id)).toEqual([70]);
    });

    it('a failed candidate validation read refuses before anything is written', async () => {
        on('government_elections', 'select', { data: { status: 'Voting', election_type: 'SimpleMajority', max_winners: 1 } });
        on('government_election_candidates', 'select', { error: { message: 'x' } });
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Failed to validate candidates');
        expect(writeLog()).toEqual([]);
    });

    it('rejects a candidate that does not exist, belongs to another election, or has withdrawn', async () => {
        seedBallotBox({}, []);
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Invalid candidate selection');
        resetFake();
        seedBallotBox({}, [cand(70, { election_id: 2 })]);
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Invalid candidate selection');
        resetFake();
        seedBallotBox({}, [cand(70, { withdrawn_at: 'w' })]);
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Cannot vote for a withdrawn candidate');
        expect(writeLog()).toEqual([]);
    });

    it('a second ballot from the same member is refused before any write', async () => {
        seedBallotBox({}, [cand(70)], 1);
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('You have already voted in this election');
        expect(writeLog()).toEqual([]);
    });

    it('a failed participation record writes no ballot', async () => {
        seedBallotBox({}, [cand(70)]);
        on('government_election_voter_registry', 'insert', { error: { code: '23505', message: 'dup' } });
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Failed to record vote participation');
        expect(queries('government_election_votes', 'insert')).toHaveLength(0);
        expect(govBroadcasts()).toEqual([]);
    });

    it('maps a ballot unique violation to "Duplicate vote detected"', async () => {
        seedBallotBox({}, [cand(70)]);
        on('government_election_votes', 'insert', { error: { code: '23505', message: 'dup' } });
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Duplicate vote detected');
    });

    it('any other ballot write failure surfaces the caller message', async () => {
        seedBallotBox({}, [cand(70)]);
        on('government_election_votes', 'insert', { error: { code: 'XX000', message: 'x' } });
        await expect(castElectionVote(1, 7, [{ candidateId: 70 }])).rejects.toThrow('Failed to cast vote');
        expect(govBroadcasts()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// concludeElection
// ---------------------------------------------------------------------------

type Ballot = { candidate_id: number; rank_order?: number | null; voter_hash?: string };

interface ConcludeSeed {
    election?: Row;
    votes: Ballot[];
    voters?: number;
    /** candidate rows by id (user_id / election_id / platform_statement). */
    candidates?: Record<number, Row>;
}

function seedConclude({ election = {}, votes, voters, candidates = {} }: ConcludeSeed) {
    const rows = votes.map((v, i) => ({ id: i + 1, rank_order: null, voter_hash: `h${i}`, ...v }));
    on('government_elections', 'select', { data: {
        id: 1, status: 'Voting', max_winners: 1, election_type: 'SimpleMajority', min_voter_turnout_pct: null,
        eligible_voter_count: null, min_vote_threshold_pct: null, allow_runoff: false, position_id: 3, voting_end: null,
        runoff_top_n: 2, title: 'Race', created_by_id: 9, ...election,
    } });
    on('government_election_votes', 'select', (q: FakeQuery) => {
        if (q.selectOpts?.head) return { count: rows.length };
        const range = calls(q, 'range')[0] as number[] | undefined;
        return { data: range ? rows.slice(range[0], range[1] + 1) : rows };
    });
    on('government_election_voter_registry', 'select', { count: voters ?? votes.length });
    on('government_election_candidates', 'select', (q: FakeQuery) => {
        const id = eqs(q).id as number;
        return { data: candidates[id] ?? { user_id: id * 10, election_id: 1, platform_statement: `p${id}` } };
    });
    on('users', 'select', { data: { id: 1 } });
    on('government_position_holders', 'select', { data: null });
    fake.rpcResult = { data: 500, error: null };
}

const candidateUpdates = (): Row[] => queries('government_election_candidates', 'update').map(q => ({ id: eqs(q).id, ...(q.values as Row) }));
const electionUpdate = () => only('government_elections', 'update');
const appointed = () => fake.rpcCalls.filter(c => c.fn === 'gov_appoint_holder').map(c => c.args);

describe('concludeElection — preconditions', () => {
    it('reads the full election with its position cap', async () => {
        on('government_elections', 'select', { data: null });
        await expect(concludeElection(1)).rejects.toThrow('Election not found');
        const q = only('government_elections', 'select');
        expect(q.columns).toMatch(/^id, status, max_winners, election_type, min_voter_turnout_pct, eligible_voter_count,/);
        expect(q.columns).toMatch(/position:government_positions\(max_holders\)$/);
        expect(eqs(q)).toEqual({ id: 1 });
    });

    it('refuses an election that is not in Voting, before reading a single ballot', async () => {
        on('government_elections', 'select', { data: { id: 1, status: 'Concluded' } });
        await expect(concludeElection(1)).rejects.toThrow('Election is not in voting phase');
        expect(queries('government_election_votes')).toHaveLength(0);
        expect(writeLog()).toEqual([]);
    });
});

describe('concludeElection — a clear result', () => {
    it('persists the tally, concludes, and seats the winner through the appointment RPC', async () => {
        seedConclude({ votes: [{ candidate_id: 70 }, { candidate_id: 70 }, { candidate_id: 71 }] });
        const res = await concludeElection(1);

        expect(res.status).toBe('Concluded');
        expect(res.conclusionReason).toBe('Election concluded normally');
        expect(candidateUpdates()).toEqual([
            { id: 70, vote_count: 2, vote_percentage: (2 / 3) * 100, is_winner: true },
            { id: 71, vote_count: 1, vote_percentage: (1 / 3) * 100, is_winner: false },
        ]);
        const u = electionUpdate();
        expect(u.values).toEqual({ status: 'Concluded', concluded_at: expect.stringMatching(ISO), conclusion_reason: 'Election concluded normally', total_votes_cast: 3, voting_end: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 1 });

        // Winner re-validated against THIS election, then seated (electionId set → no manual ceiling).
        const winnerRead = queries('government_election_candidates', 'select').find(q => q.columns === 'user_id, election_id')!;
        expect(eqs(winnerRead)).toEqual({ id: 70 });
        expect(appointed()).toEqual([{ p_position_id: 3, p_user_id: 700, p_appointed_by_id: null, p_election_id: 1 }]);
        expect(queries('government_positions')).toHaveLength(0);
        expect(govBroadcasts().at(-1)).toEqual({ slices: ['elections'] });
    });

    it('keeps a scheduled voting_end rather than overwriting it', async () => {
        seedConclude({ election: { voting_end: '2026-05-01T00:00:00.000Z' }, votes: [{ candidate_id: 70 }] });
        await concludeElection(1);
        expect((electionUpdate().values as Row).voting_end).toBe('2026-05-01T00:00:00.000Z');
    });

    it('never seats a winning candidate row that belongs to another election', async () => {
        seedConclude({ votes: [{ candidate_id: 70 }], candidates: { 70: { user_id: 700, election_id: 2 } } });
        const res = await concludeElection(1);
        expect(res.status).toBe('Concluded');
        expect(appointed()).toEqual([]);
    });

    it('an appointment failure is logged and does not undo the conclusion', async () => {
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        seedConclude({ election: { max_winners: 2, election_type: 'Plurality' }, votes: [{ candidate_id: 70 }, { candidate_id: 70 }, { candidate_id: 71 }] });
        fake.rpcResult = { data: null, error: { message: 'position_full' } };
        const res = await concludeElection(1);
        expect(res.status).toBe('Concluded');
        // Both winners were attempted; each failure was logged with ids only.
        expect(appointed().map(a => a.p_user_id)).toEqual([700, 710]);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith('auto-appoint election winner failed', expect.objectContaining({ electionId: 1, positionId: 3, candidateId: 70 }));
    });

    it.each([
        ['Approval', [{ candidate_id: 70 }, { candidate_id: 71 }, { candidate_id: 70 }], [70]],
        ['ProportionalRepresentation', [{ candidate_id: 70 }, { candidate_id: 70 }, { candidate_id: 71 }], [70]],
    ])('dispatches %s to its tally', async (type, votes, winners) => {
        seedConclude({ election: { election_type: type }, votes });
        const res = await concludeElection(1);
        expect(res.result.winners.map(w => w.candidateId)).toEqual(winners);
        expect(res.status).toBe('Concluded');
    });

    it('dispatches Preferential to the full instant-runoff count', async () => {
        seedConclude({
            election: { election_type: 'Preferential' },
            // Converted: this fixture used to be a 1–1–1 first round, in which 72 was
            // eliminated only because its ballot sorted last — a tie that decides the seat
            // (eliminating 71 instead leaves 70 against 72), now inconclusive. Voters d and
            // e make 72 the clear last place.
            votes: [
                { candidate_id: 70, rank_order: 1, voter_hash: 'a' }, { candidate_id: 71, rank_order: 2, voter_hash: 'a' },
                { candidate_id: 71, rank_order: 1, voter_hash: 'b' },
                { candidate_id: 72, rank_order: 1, voter_hash: 'c' }, { candidate_id: 71, rank_order: 2, voter_hash: 'c' },
                { candidate_id: 70, rank_order: 1, voter_hash: 'd' },
                { candidate_id: 71, rank_order: 1, voter_hash: 'e' },
            ],
            voters: 5,
        });
        const res = await concludeElection(1);
        // 70 2, 71 2, 72 1: no majority. 72 is eliminated and its ballot transfers: 71 wins 3 of 5.
        expect(res.result.totalVotes).toBe(5);
        expect(res.result.winners).toEqual([{ candidateId: 71, voteCount: 3, percentage: 60 }]);
        expect(appointed().map(a => a.p_user_id)).toEqual([710]);
    });

    it('a proportional result with equal lists is not treated as a tie', async () => {
        seedConclude({ election: { election_type: 'ProportionalRepresentation', max_winners: 1, allow_runoff: true }, votes: [{ candidate_id: 70 }, { candidate_id: 71 }] });
        const res = await concludeElection(1);
        expect(res.status).toBe('Concluded');
        expect(queries('government_elections', 'insert')).toHaveLength(0);
    });
});

describe('concludeElection — turnout quorum', () => {
    it('cancels below quorum, reporting the measured turnout, and seats nobody', async () => {
        seedConclude({ election: { min_voter_turnout_pct: '50', eligible_voter_count: 10 }, votes: [{ candidate_id: 70 }], voters: 2 });
        const res = await concludeElection(1);
        expect(res.status).toBe('Cancelled');
        expect(res.conclusionReason).toBe('Insufficient voter turnout (20.0% < 50% required)');
        expect(candidateUpdates()).toEqual([{ id: 70, vote_count: 1, vote_percentage: 100, is_winner: false }]);
        expect(appointed()).toEqual([]);
    });

    it('cancels when a quorum is set but the electorate size is unknown', async () => {
        seedConclude({ election: { min_voter_turnout_pct: '25', eligible_voter_count: 0 }, votes: [{ candidate_id: 70 }] });
        const res = await concludeElection(1);
        expect(res.status).toBe('Cancelled');
        expect(res.conclusionReason).toBe('Turnout quorum of 25% required but the electorate size is unknown — quorum not met');
        expect(appointed()).toEqual([]);
    });

    it('a met quorum concludes normally', async () => {
        seedConclude({ election: { min_voter_turnout_pct: '50', eligible_voter_count: 2 }, votes: [{ candidate_id: 70 }], voters: 1 });
        expect((await concludeElection(1)).status).toBe('Concluded');
    });
});

describe('concludeElection — vote threshold', () => {
    const split = [{ candidate_id: 70 }, { candidate_id: 70 }, { candidate_id: 71 }, { candidate_id: 72 }];
    // 3 / 2 / 1 — no tie anywhere, so "the top N" is unambiguous. (In `split`, 71 and 72
    // tie for second, which now widens the runoff field — pinned separately below.)
    const clearSplit = [70, 70, 70, 71, 71, 72].map(candidate_id => ({ candidate_id }));

    it('no candidate over the threshold, runoff allowed: creates the runoff with the top N and seats nobody', async () => {
        seedConclude({ election: { min_vote_threshold_pct: '60', allow_runoff: true, runoff_top_n: 2, max_winners: 1 }, votes: clearSplit });
        on('government_elections', 'insert', { data: { id: 2 } });
        const res = await concludeElection(1);

        expect(res.status).toBe('Runoff');
        expect(res.conclusionReason).toBe('No candidate met 60% threshold — runoff triggered');
        expect(res.result.isConclusive).toBe(false);

        const runoff = only('government_elections', 'insert');
        expect(runoff.values).toEqual({
            position_id: 3, title: 'Race — Runoff', description: 'Runoff election following inconclusive results.',
            election_type: 'SimpleMajority', status: 'Candidacy', candidacy_start: expect.stringMatching(ISO),
            min_candidates: 2, max_winners: 1, allow_runoff: false, runoff_top_n: 2, parent_election_id: 1, created_by_id: 9,
        });
        expect(runoff.returning).toBe('id');
        // The top two (70 with 3 votes, then 71 with 2) are carried into the runoff with their statements.
        const carried = queries('government_election_candidates', 'insert').map(q => q.values);
        expect(carried).toEqual([
            { election_id: 2, user_id: 700, platform_statement: 'p70' },
            { election_id: 2, user_id: 710, platform_statement: 'p71' },
        ]);
        expect(candidateUpdates().every(c => c.is_winner === false)).toBe(true);
        expect((electionUpdate().values as Row).status).toBe('Runoff');
        expect(appointed()).toEqual([]);
    });

    it('a runoff whose creation fails is logged; the parent is still recorded as Runoff', async () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        seedConclude({ election: { min_vote_threshold_pct: '60', allow_runoff: true }, votes: split });
        on('government_elections', 'insert', { error: { message: 'x' } });
        const res = await concludeElection(1);
        expect(res.status).toBe('Runoff');
        expect(error).toHaveBeenCalledWith('create runoff election failed', expect.objectContaining({ parentElectionId: 1 }));
        expect(queries('government_election_candidates', 'insert')).toHaveLength(0);
    });

    it('a carried candidate whose original row cannot be read is skipped; runoff_top_n defaults to 2', async () => {
        seedConclude({ election: { min_vote_threshold_pct: '60', allow_runoff: true, runoff_top_n: 0 }, votes: clearSplit });
        on('government_elections', 'insert', { data: { id: 2 } });
        fake.routes.delete('government_election_candidates:select');
        on('government_election_candidates', 'select', (q: FakeQuery) => ({ data: eqs(q).id === 70 ? null : { user_id: 710, election_id: 1, platform_statement: null } }));
        await concludeElection(1);
        const origReads = queries('government_election_candidates', 'select').filter(q => q.columns === 'user_id, platform_statement');
        expect(origReads.map(q => eqs(q).id)).toEqual([70, 71]);
        expect(queries('government_election_candidates', 'insert').map(q => q.values)).toEqual([{ election_id: 2, user_id: 710, platform_statement: null }]);
    });

    // BUG FIX (pinned): the runoff field was a bare slice of the top N, so a tie at the
    // N-th place was cut by ballot order — 71 went through and 72, level with it, did not.
    it('the runoff field takes in everyone tied with the N-th place', async () => {
        seedConclude({ election: { min_vote_threshold_pct: '60', allow_runoff: true, runoff_top_n: 2 }, votes: split });
        on('government_elections', 'insert', { data: { id: 2 } });
        const res = await concludeElection(1);
        expect(res.status).toBe('Runoff');
        expect(queries('government_election_candidates', 'insert').map(q => (q.values as Row).user_id)).toEqual([700, 710, 720]);
    });

    it('a runoff_top_n below one still carries the leader (and anyone level with them)', async () => {
        seedConclude({ election: { min_vote_threshold_pct: '60', allow_runoff: true, runoff_top_n: -3 }, votes: clearSplit });
        on('government_elections', 'insert', { data: { id: 2 } });
        await concludeElection(1);
        expect(queries('government_election_candidates', 'insert').map(q => (q.values as Row).user_id)).toEqual([700]);
    });

    it('no candidate over the threshold, no runoff: inconclusive, nobody seated', async () => {
        seedConclude({ election: { min_vote_threshold_pct: '60' }, votes: split });
        const res = await concludeElection(1);
        expect(res.conclusionReason).toBe('No candidate met 60% threshold — election inconclusive');
        expect(res.result.isConclusive).toBe(false);
        expect(queries('government_elections', 'insert')).toHaveLength(0);
        expect(appointed()).toEqual([]);
    });

    it('a winner at or over the threshold concludes normally', async () => {
        seedConclude({ election: { min_vote_threshold_pct: '50' }, votes: split });
        const res = await concludeElection(1);
        expect(res.status).toBe('Concluded');
        expect(appointed().map(a => a.p_user_id)).toEqual([700]);
    });
});

// BUG FIX (pinned): the tie check compared candidates WITHIN `winners`, which every tally
// slices to max_winners — so `tied.length > maxWinners` could never be true and the
// check was dead. A dead heat for a single seat was "won" by whichever candidate's first
// ballot happened to sort first, and that candidate was auto-appointed; allow_runoff was
// never consulted for a tie. The check now looks at the whole result.
describe('concludeElection — a tie for the seat', () => {
    const deadHeat = [{ candidate_id: 70 }, { candidate_id: 71 }, { candidate_id: 70 }, { candidate_id: 71 }];

    it('without a runoff: no clear winner, nobody seated', async () => {
        seedConclude({ votes: deadHeat });
        const res = await concludeElection(1);
        expect(res.conclusionReason).toBe('Tie between 2 candidates — no clear winner');
        expect(res.result.isConclusive).toBe(false);
        expect(candidateUpdates().map(c => c.is_winner)).toEqual([false, false]);
        expect(appointed()).toEqual([]);
    });

    it('with a runoff: the tied candidates go to a runoff', async () => {
        seedConclude({ election: { allow_runoff: true }, votes: deadHeat });
        on('government_elections', 'insert', { data: { id: 2 } });
        const res = await concludeElection(1);
        expect(res.status).toBe('Runoff');
        expect(res.conclusionReason).toBe('Tie between 2 candidates — runoff triggered');
        expect(queries('government_election_candidates', 'insert').map(q => (q.values as Row).user_id)).toEqual([700, 710]);
        expect(appointed()).toEqual([]);
    });

    it('a three-way tie for two seats is still a tie', async () => {
        seedConclude({ election: { max_winners: 2, election_type: 'Plurality' }, votes: [{ candidate_id: 70 }, { candidate_id: 71 }, { candidate_id: 72 }] });
        const res = await concludeElection(1);
        expect(res.conclusionReason).toBe('Tie between 3 candidates — no clear winner');
        expect(appointed()).toEqual([]);
    });

    it('a tie that fits inside the seats is not a tie', async () => {
        seedConclude({ election: { max_winners: 2, election_type: 'Plurality' }, votes: [...deadHeat, { candidate_id: 72 }] });
        const res = await concludeElection(1);
        expect(res.status).toBe('Concluded');
        expect(appointed().map(a => a.p_user_id)).toEqual([700, 710]);
    });

    // BUG FIX (pinned): only a tie at the TOP was caught. A 5, B 3, C 3 for two seats: A
    // is in, but B against C is level — and the seat went to whichever sorted first.
    describe('a tie straddling the seat cutoff', () => {
        const straddle = [...Array(5).fill(70), ...Array(3).fill(71), ...Array(3).fill(72)].map(candidate_id => ({ candidate_id }));

        it('without a runoff: no clear winner — nobody is seated, not even the clear leader', async () => {
            seedConclude({ election: { max_winners: 2, election_type: 'Plurality' }, votes: straddle });
            const res = await concludeElection(1);
            expect(res.status).toBe('Concluded');
            expect(res.conclusionReason).toBe('Tie between 2 candidates — no clear winner');
            expect(res.result.isConclusive).toBe(false);
            expect(candidateUpdates().map(c => [c.id, c.vote_count, c.is_winner])).toEqual([[70, 5, false], [71, 3, false], [72, 3, false]]);
            expect(appointed()).toEqual([]);
        });

        it('with a runoff: a runoff is called, carrying both tied candidates', async () => {
            seedConclude({ election: { max_winners: 2, election_type: 'Approval', allow_runoff: true, runoff_top_n: 2 }, votes: straddle });
            on('government_elections', 'insert', { data: { id: 2 } });
            const res = await concludeElection(1);
            expect(res.status).toBe('Runoff');
            expect(res.conclusionReason).toBe('Tie between 2 candidates — runoff triggered');
            expect(queries('government_election_candidates', 'insert').map(q => (q.values as Row).user_id)).toEqual([700, 710, 720]);
            expect(appointed()).toEqual([]);
        });

        it('a clear gap at the cutoff concludes normally', async () => {
            seedConclude({ election: { max_winners: 2, election_type: 'Plurality' }, votes: [...straddle, { candidate_id: 71 }] });
            const res = await concludeElection(1);
            expect(res.status).toBe('Concluded');
            expect(appointed().map(a => a.p_user_id)).toEqual([700, 710]);
        });
    });

    // BUG FIX (pinned): instant-runoff broke a tie for last place by sort order, so a
    // 1–1 final round was "won" by whoever's ballot sorted first.
    describe('a ranked-choice tie', () => {
        const levelRanked = [
            { candidate_id: 70, rank_order: 1, voter_hash: 'a' }, { candidate_id: 71, rank_order: 2, voter_hash: 'a' },
            { candidate_id: 71, rank_order: 1, voter_hash: 'b' }, { candidate_id: 70, rank_order: 2, voter_hash: 'b' },
        ];

        it('goes through the tie path: no clear winner, nobody seated — not Cancelled', async () => {
            seedConclude({ election: { election_type: 'Preferential' }, votes: levelRanked, voters: 2 });
            const res = await concludeElection(1);
            expect(res.status).toBe('Concluded');
            expect(res.conclusionReason).toBe('Ranked-choice tie between 2 candidates in the final round — no clear winner');
            expect(res.result.isConclusive).toBe(false);
            expect(candidateUpdates().map(c => [c.id, c.vote_count, c.is_winner])).toEqual([[70, 1, false], [71, 1, false]]);
            expect(appointed()).toEqual([]);
        });

        it('with a runoff allowed, the tied candidates go to a runoff', async () => {
            seedConclude({ election: { election_type: 'Preferential', allow_runoff: true }, votes: levelRanked, voters: 2 });
            on('government_elections', 'insert', { data: { id: 2 } });
            const res = await concludeElection(1);
            expect(res.status).toBe('Runoff');
            expect(res.conclusionReason).toBe('Ranked-choice tie between 2 candidates in the final round — runoff triggered');
            expect(queries('government_election_candidates', 'insert').map(q => (q.values as Row).user_id)).toEqual([700, 710]);
        });

        // BUG FIX (pinned, review round 2): a two-seat count whose elimination tie led, on
        // one branch, to a majority with a dead heat for seat 2 was decided by which voter's
        // ballot row came first (ids are random uuids in production). Both orders must now
        // conclude the same way. A=70 B=71 C=72 X=73 Y=74; A 5, B 2, C 2, X→A, Y→B.
        it('a multi-seat count concludes the same way whichever ballot is read first', async () => {
            const ballot = (voter: string, ...prefs: number[]) => prefs.map((candidate_id, i) => ({ candidate_id, rank_order: i + 1, voter_hash: voter }));
            const body = [
                ...[1, 2, 3, 4, 5].flatMap(n => ballot(`a${n}`, 70)),
                ...ballot('b1', 71), ...ballot('b2', 71), ...ballot('c1', 72), ...ballot('c2', 72),
            ];
            const x = ballot('x', 73, 70);
            const y = ballot('y', 74, 71);
            // Rows arrive in rank order, so the rank-1 rows set the ballot order.
            const xFirst = [x[0], ...body, y[0], x[1], y[1]];
            const yFirst = [y[0], ...body, x[0], y[1], x[1]];
            const reasons: string[] = [];
            for (const votes of [xFirst, yFirst]) {
                resetFake();
                seedConclude({ election: { election_type: 'Preferential', max_winners: 2 }, votes, voters: 11 });
                const res = await concludeElection(1);
                expect(res.status).toBe('Concluded');
                expect(res.result.isConclusive).toBe(false);
                expect(candidateUpdates().every(c => c.is_winner === false)).toBe(true);
                expect(appointed()).toEqual([]);
                reasons.push(res.conclusionReason);
            }
            expect(reasons).toEqual([
                'Ranked-choice elimination tie between 2 candidates decides the result — no clear winner',
                'Ranked-choice elimination tie between 2 candidates decides the result — no clear winner',
            ]);
        });

        it('a failed turnout quorum still cancels: the tie is not re-decided into a runoff', async () => {
            seedConclude({ election: { election_type: 'Preferential', allow_runoff: true, min_voter_turnout_pct: '50', eligible_voter_count: 10 }, votes: levelRanked, voters: 2 });
            const res = await concludeElection(1);
            expect(res.status).toBe('Cancelled');
            expect(res.conclusionReason).toBe('Insufficient voter turnout (20.0% < 50% required)');
            expect(queries('government_elections', 'insert')).toHaveLength(0);
            expect(appointed()).toEqual([]);
        });
    });
});

describe('concludeElection — an uncomputable tally', () => {
    it('no ballots: Cancelled with the tally\'s own reason, nothing persisted per candidate', async () => {
        seedConclude({ votes: [] });
        const res = await concludeElection(1);
        expect(res.status).toBe('Cancelled');
        expect(res.conclusionReason).toBe('No votes cast');
        expect(candidateUpdates()).toEqual([]);
        expect((electionUpdate().values as Row)).toMatchObject({ status: 'Cancelled', conclusion_reason: 'No votes cast', total_votes_cast: 0 });
    });

    it('the tally\'s reason wins over the turnout text', async () => {
        seedConclude({ election: { min_voter_turnout_pct: '50', eligible_voter_count: 10 }, votes: [] });
        const res = await concludeElection(1);
        expect(res.conclusionReason).toBe('No votes cast');
    });

    it('a refused ballot read leaves the election in Voting (re-runnable): nothing written', async () => {
        seedConclude({ votes: [{ candidate_id: 70 }] });
        fake.routes.delete('government_election_votes:select');
        on('government_election_votes', 'select', { error: { message: 'timeout' } });
        await expect(concludeElection(1)).rejects.toThrow('Failed to fetch votes');
        expect(writeLog()).toEqual([]);
        expect(appointed()).toEqual([]);
    });
});

// BUG FIX (pinned): the candidate-tally and election-status writes discarded their
// errors, so a failed status write still went on to auto-appoint the winner — someone
// took office on an election the database still showed as open for voting (and which
// could then be voted in and concluded again). A failed write now refuses before anyone
// is seated, leaving the election in Voting to be re-run.
describe('concludeElection — persistence fails closed', () => {
    it('a failed status write seats nobody', async () => {
        seedConclude({ votes: [{ candidate_id: 70 }] });
        on('government_elections', 'update', { error: { message: 'x' } });
        await expect(concludeElection(1)).rejects.toThrow('Failed to record the election result');
        expect(appointed()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('a failed candidate tally write refuses before the status is changed', async () => {
        seedConclude({ votes: [{ candidate_id: 70 }] });
        on('government_election_candidates', 'update', { error: { message: 'x' } });
        await expect(concludeElection(1)).rejects.toThrow('Failed to record the election result');
        expect(queries('government_elections', 'update')).toHaveLength(0);
        expect(appointed()).toEqual([]);
    });
});
