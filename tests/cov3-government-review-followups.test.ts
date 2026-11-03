import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Government review follow-ups (lib/db/government/internal.ts, legislation.ts and
// api/actions/government.ts). Each block pins one behaviour change:
//
//   (a) a ballot read refuses a REPEATED row id. Ballot ids are random uuids (election
//       votes) or identities that become visible at commit (bill / motion votes), so a
//       ballot cast mid-read can land inside a page already read and push that page's
//       last row across the boundary: read twice, the new ballot never read, and the
//       exact count still agrees. getVotesForElection and the conclusion recount both
//       lacked the guard tallyPreferentialFull already had.
//   (b) a cast whose ballot insert succeeded broadcasts even when the tally refresh then
//       throws — the ballot landed, and other members used never to hear of it.
//   (c) only an item in 'Voting' may be concluded, and the conclusion UPDATE carries that
//       condition: concluding a Vetoed bill re-decided it (an un-veto).
//   (d) the conclude announcements name the item and its real verdict: the db result
//       never carried title/status, so every push said "A bill concluded (final).".
//   (e) instant-runoff follows tie branches in ascending candidate id, so the numbers
//       concludeElection stores do not depend on the order the ballot rows were read.
//
// The action handlers run END TO END here: '../lib/db' is the real government barrel,
// over the recording supabase fake, so a push body is built from what the real db
// function returned — not from a hand-written stub result.

const h = vi.hoisted(() => ({
    pushes: [] as Array<{ perm: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());
// structure.ts / legislation.ts → orgMediaDocs → storage imports the storage client; nothing here signs media.
vi.mock('../lib/supabaseServer', () => ({ supabase: { storage: { from: () => ({}) } }, handleSupabaseError: () => {} }));
vi.mock('../lib/db', async () => ({ ...(await import('../lib/db/government')) }));
vi.mock('../lib/push', () => ({
    sendPushToPermission: (perm: string, payload: Record<string, unknown>) => {
        h.pushes.push({ perm, payload });
        return Promise.resolve();
    },
}));

import {
    fake, on, only, queries, eqs, calls, writeLog, resetFake, assertNoWildcards, govBroadcasts, broadcastToOrg, type FakeQuery,
} from './cov-db-government-fake';
import { getVotesForElection, instantRunoff } from '../lib/db/government/internal';
import { castLegislationVote, castMotionVote, concludeLegislationVote, concludeMotion } from '../lib/db/government/legislation';
import { concludeElection } from '../lib/db/government/elections';
import { governmentActions } from '../api/actions/government';
import { LegislationStatus, MotionStatus } from '../types';

type Row = Record<string, unknown>;
type Handler = (payload: unknown) => Promise<unknown>;
const run = (action: string, payload: unknown) => (governmentActions as unknown as Record<string, Handler>)[action](payload);

beforeEach(() => { resetFake(); h.pushes = []; });
afterEach(() => { assertNoWildcards(); });

const ELECTION_REFUSAL = 'The ballot count changed while tallying — re-run the count.';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pageReads = (table: string) => queries(table, 'select').filter(q => !q.selectOpts?.head);
const countReads = (table: string) => queries(table, 'select').filter(q => q.selectOpts?.head);

// ---------------------------------------------------------------------------
// (a) Ballot reads refuse a repeated row id
// ---------------------------------------------------------------------------

describe('(a) getVotesForElection refuses a row read twice across a page boundary', () => {
    // A full first page, then a ballot cast mid-read sorts INTO it: its last row is pushed
    // onto page 2, the new ballot is never read, and the total (1001) still agrees.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ candidate_id: i < 500 ? 1 : 2, rank_order: null, id: uuid(i) }));
    function seedShiftedRead() {
        on('government_election_votes', 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count: 1001 };
            const [from] = calls(q, 'range')[0] as number[];
            return { data: from === 0 ? page1 : [page1[999]] };
        });
    }

    it('refuses on the repeated id — before the count, which would have agreed', async () => {
        seedShiftedRead();
        await expect(getVotesForElection(5)).rejects.toThrow(ELECTION_REFUSAL);
        expect(pageReads('government_election_votes').map(q => calls(q, 'range')[0])).toEqual([[0, 999], [1000, 1999]]);
        expect(countReads('government_election_votes')).toHaveLength(0);
    });

    it('distinct uuid ids across pages are read in full (the guard refuses only a real repeat)', async () => {
        const page2 = [{ candidate_id: 2, rank_order: null, id: uuid(1000) }];
        on('government_election_votes', 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count: 1001 };
            const [from] = calls(q, 'range')[0] as number[];
            return { data: from === 0 ? page1 : page2 };
        });
        const votes = await getVotesForElection(5);
        expect(votes).toHaveLength(1001);
        expect(votes.filter(v => v.candidate_id === 2)).toHaveLength(501);
        expect(countReads('government_election_votes')).toHaveLength(1);
    });

    it('a page that comes back with no data reads as no rows — and the exact count must still agree', async () => {
        on('government_election_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 0 } : { data: null }));
        await expect(getVotesForElection(5)).resolves.toEqual([]);
        resetFake();
        // A null page against a count of 1 is a ballot the read never saw: refuse.
        on('government_election_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 1 } : { data: null }));
        await expect(getVotesForElection(5)).rejects.toThrow(ELECTION_REFUSAL);
    });

    it('a repeated row inside a single page refuses too', async () => {
        const dup = [{ candidate_id: 1, rank_order: null, id: uuid(1) }, { candidate_id: 1, rank_order: null, id: uuid(1) }];
        on('government_election_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 2 } : { data: dup }));
        await expect(getVotesForElection(5)).rejects.toThrow(ELECTION_REFUSAL);
    });

    it('concludeElection surfaces the refusal and writes nothing: the election stays in Voting, re-runnable', async () => {
        on('government_elections', 'select', { data: {
            id: 1, status: 'Voting', max_winners: 1, election_type: 'SimpleMajority', min_voter_turnout_pct: null,
            eligible_voter_count: null, min_vote_threshold_pct: null, allow_runoff: false, position_id: 3, voting_end: null,
            runoff_top_n: 2, title: 'Race', created_by_id: 9,
        } });
        seedShiftedRead();
        await expect(concludeElection(1)).rejects.toThrow(ELECTION_REFUSAL);
        expect(writeLog()).toEqual([]);
        expect(fake.rpcCalls).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('(a) the bill / motion conclusion recount refuses a row read twice across a page boundary', () => {
    // Page 1: 500 for, 500 against, the last row a 'for'. A ballot cast mid-read pushes that
    // row onto page 2. Counted twice, the bill would PASS 501–500; the unseen new ballot
    // may be the 501st 'against'. The total (1001) agrees, so only the repeat refuses.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, vote: i < 499 || i === 999 ? 'for' : 'against' }));
    function seedShiftedRecount(table: 'government_legislation_votes' | 'government_motion_votes') {
        on(table, 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count: 1001 };
            const [from] = calls(q, 'range')[0] as number[];
            return { data: from === 0 ? page1 : [page1[999]] };
        });
    }

    it.each([
        ['concludeLegislationVote', 'government_legislation', 'government_legislation_votes', concludeLegislationVote, 'The legislation ballot count changed while it was being recounted — conclude it again.'],
        ['concludeMotion', 'government_motions', 'government_motion_votes', concludeMotion, 'The motion ballot count changed while it was being recounted — conclude it again.'],
    ] as const)('%s refuses, concludes nothing and announces nothing', async (_name, parent, ballots, conclude, refusal) => {
        expect(page1.filter(r => r.vote === 'for')).toHaveLength(500);
        on(parent, 'select', { data: { id: 3, status: 'Voting', title: 'T' } });
        on(parent, 'update', { data: [{ id: 3 }] });
        seedShiftedRecount(ballots);
        await expect(conclude(3)).rejects.toThrow(refusal);
        expect(pageReads(ballots).map(q => calls(q, 'range')[0])).toEqual([[0, 999], [1000, 1999]]);
        expect(countReads(ballots)).toHaveLength(0);
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('distinct ids across pages still conclude, from every row', async () => {
        on('government_legislation', 'select', { data: { id: 3, status: 'Voting', title: 'T' } });
        on('government_legislation', 'update', { data: [{ id: 3 }] });
        on('government_legislation_votes', 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count: 1001 };
            const [from] = calls(q, 'range')[0] as number[];
            return { data: from === 0 ? page1 : [{ id: 1001, vote: 'against' }] };
        });
        await expect(concludeLegislationVote(3)).resolves.toEqual({ passed: false, status: 'Failed', title: 'T' });
        expect(only('government_legislation', 'update').values).toMatchObject({ status: 'Failed', votes_for: 500, votes_against: 501, votes_abstain: 0 });
    });
});

// ---------------------------------------------------------------------------
// (b) A stored ballot is always announced (ids only)
// ---------------------------------------------------------------------------

describe('(b) castLegislationVote broadcasts once the ballot is stored, even when the tally refresh fails', () => {
    function seedCast() {
        on('government_legislation', 'select', { data: { status: 'Voting' } });
        on('government_position_holders', 'select', { data: { position_id: 4, position: { can_vote_legislation: true } } });
        on('government_legislation_votes', 'select', { data: null }, { data: [{ vote: 'for' }] });
    }

    it('a failed tally WRITE still throws the "recorded" message — and the ballot is announced, by slice only', async () => {
        seedCast();
        on('government_legislation', 'update', { error: { message: 'write timeout' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('Your vote was recorded, but the legislation tally could not be saved');
        expect(writeLog()).toEqual(['government_legislation_votes:insert', 'government_legislation:update']);
        // Security rule 4: a discriminator, never the vote, the voter or the bill.
        expect(broadcastToOrg.mock.calls).toEqual([['government_update', { slices: ['legislation'] }]]);
    });

    it('a failed tally RECOUNT read still throws — and the ballot is announced', async () => {
        on('government_legislation', 'select', { data: { status: 'Voting' } });
        on('government_position_holders', 'select', { data: { position_id: 4, position: { can_vote_legislation: true } } });
        on('government_legislation_votes', 'select', { data: null }, { error: { message: 'recount timeout' } });
        await expect(castLegislationVote(3, 7, 4, 'against')).rejects.toThrow('Your vote was recorded, but the legislation tally could not be recounted');
        expect(writeLog()).toEqual(['government_legislation_votes:insert']);
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('a clean cast broadcasts exactly once', async () => {
        seedCast();
        await expect(castLegislationVote(3, 7, 4, 'for')).resolves.toBeUndefined();
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('no ballot stored, no broadcast: a failed insert, a duplicate, or a refused cast', async () => {
        seedCast();
        on('government_legislation_votes', 'insert', { error: { code: 'XX000', message: 'x' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('Failed to cast legislation vote');
        expect(govBroadcasts()).toEqual([]);

        resetFake();
        seedCast();
        on('government_legislation_votes', 'insert', { error: { code: '23505', message: 'dup' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('You have already voted on this legislation.');
        expect(govBroadcasts()).toEqual([]);

        resetFake();
        on('government_legislation', 'select', { data: { status: 'Passed' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('Legislation is not in voting phase');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('(b) castMotionVote broadcasts once the ballot is stored, even when the tally refresh fails', () => {
    function seedCast(secret: boolean) {
        on('government_motions', 'select', { data: { status: 'Voting', is_secret_ballot: secret, restricted_to_position_ids: null } });
        on('government_motion_votes', 'select', { data: null }, { data: [{ vote: 'for' }] });
    }

    it.each([['public', false], ['secret', true]] as const)('%s ballot: a failed tally write still throws — and the ballot is announced, by slice only', async (_kind, secret) => {
        seedCast(secret);
        on('government_motions', 'update', { error: { message: 'write timeout' } });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('Your vote was recorded, but the motion tally could not be saved');
        expect(writeLog()).toEqual(['government_motion_votes:insert', 'government_motions:update']);
        expect(broadcastToOrg.mock.calls).toEqual([['government_update', { slices: ['motions'] }]]);
    });

    it.each([['public', false], ['secret', true]] as const)('%s ballot: a clean cast broadcasts exactly once; a failed insert broadcasts nothing', async (_kind, secret) => {
        seedCast(secret);
        await expect(castMotionVote(2, 7, 'for')).resolves.toBeUndefined();
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);

        resetFake();
        seedCast(secret);
        on('government_motion_votes', 'insert', { error: { code: 'XX000', message: 'x' } });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('Failed to cast motion vote');
        expect(govBroadcasts()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// (c) Only an item in 'Voting' is concluded
// ---------------------------------------------------------------------------

// The vocabulary comes from the shared enums, so a status added later is covered too.
const NOT_VOTING_BILL = Object.values(LegislationStatus).filter(s => s !== LegislationStatus.Voting);
const NOT_VOTING_MOTION = Object.values(MotionStatus).filter(s => s !== MotionStatus.Voting);

describe('(c) concludeLegislationVote concludes only a bill in Voting', () => {
    it('the vocabulary under test is the real one', () => {
        expect(NOT_VOTING_BILL).toEqual(['Draft', 'Proposed', 'Debate', 'Passed', 'Failed', 'Vetoed', 'Repealed', 'Amended']);
    });

    // A Vetoed bill re-concluded from its old ballots was an un-veto; a Draft was "decided".
    it.each(NOT_VOTING_BILL)('refuses a %s bill before reading a single ballot', async (status) => {
        on('government_legislation', 'select', { data: { id: 3, status, title: 'Act' } });
        on('government_legislation', 'update', { data: [{ id: 3 }] });
        await expect(concludeLegislationVote(3)).rejects.toThrow('Legislation is not in voting phase');
        expect(only('government_legislation', 'select').columns).toBe('id, status, title');
        expect(queries('government_legislation_votes')).toHaveLength(0);
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('the conclusion write is conditional on Voting: a status that moved after the read refuses', async () => {
        on('government_legislation', 'select', { data: { id: 3, status: 'Voting', title: 'Act' } });
        on('government_legislation_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 1 } : { data: [{ id: 1, vote: 'for' }] }));
        on('government_legislation', 'update', { data: [] });
        await expect(concludeLegislationVote(3)).rejects.toThrow('Legislation is no longer in voting phase — it was not concluded.');
        const u = only('government_legislation', 'update');
        expect(eqs(u)).toEqual({ id: 3, status: 'Voting' });
        expect(u.returning).toBe('id');
        expect(govBroadcasts()).toEqual([]);
    });

    it('a conclusion write that reports no rows at all also refuses (fail closed)', async () => {
        on('government_legislation', 'select', { data: { id: 3, status: 'Voting', title: 'Act' } });
        on('government_legislation_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 0 } : { data: [] }));
        on('government_legislation', 'update', { data: null });
        await expect(concludeLegislationVote(3)).rejects.toThrow('Legislation is no longer in voting phase — it was not concluded.');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('(c) concludeMotion concludes only a motion in Voting', () => {
    it('the vocabulary under test is the real one', () => {
        expect(NOT_VOTING_MOTION).toEqual(['Open', 'Passed', 'Failed', 'Cancelled']);
    });

    // A cancelled motion re-concluded was un-cancelled into Passed/Failed.
    it.each(NOT_VOTING_MOTION)('refuses a %s motion before reading a single ballot', async (status) => {
        on('government_motions', 'select', { data: { id: 2, status, title: 'Adjourn' } });
        on('government_motions', 'update', { data: [{ id: 2 }] });
        await expect(concludeMotion(2)).rejects.toThrow('Motion is not in voting phase');
        expect(only('government_motions', 'select').columns).toBe('id, status, title');
        expect(queries('government_motion_votes')).toHaveLength(0);
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('a motion cancelled between the read and the write is not concluded over the cancel', async () => {
        on('government_motions', 'select', { data: { id: 2, status: 'Voting', title: 'Adjourn' } });
        on('government_motion_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 1 } : { data: [{ id: 1, vote: 'for' }] }));
        on('government_motions', 'update', { data: [] });
        await expect(concludeMotion(2)).rejects.toThrow('Motion is no longer in voting phase — it was not concluded.');
        const u = only('government_motions', 'update');
        expect(eqs(u)).toEqual({ id: 2, status: 'Voting' });
        expect(u.returning).toBe('id');
        expect(govBroadcasts()).toEqual([]);

        resetFake();
        on('government_motions', 'select', { data: { id: 2, status: 'Voting', title: 'Adjourn' } });
        on('government_motion_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 0 } : { data: [] }));
        on('government_motions', 'update', { data: null });
        await expect(concludeMotion(2)).rejects.toThrow('Motion is no longer in voting phase — it was not concluded.');
    });
});

// ---------------------------------------------------------------------------
// (d) The conclude announcements name the item and its verdict — end to end
// ---------------------------------------------------------------------------

function seedConclusion(parent: 'government_legislation' | 'government_motions', ballots: 'government_legislation_votes' | 'government_motion_votes', title: string, votes: string[], update: Row = { data: [{ id: 3 }] }) {
    on(parent, 'select', { data: { id: 3, status: 'Voting', title } });
    on(parent, 'update', update);
    const rows = votes.map((vote, i) => ({ id: i + 1, vote }));
    on(ballots, 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: rows.length } : { data: rows }));
}

describe('(d) gov:conclude_legislation_vote announces the bill by name with its real verdict', () => {
    it.each([
        [['for', 'for', 'against'], { passed: true, status: 'Passed' }, 'Clean Air Act passed.'],
        [['for', 'against', 'against'], { passed: false, status: 'Failed' }, 'Clean Air Act was defeated.'],
        [['for', 'against', 'abstain'], { passed: false, status: 'Failed' }, 'Clean Air Act was defeated.'],
    ])('ballots %j → %j → "%s"', async (votes, verdict, body) => {
        seedConclusion('government_legislation', 'government_legislation_votes', 'Clean Air Act', votes);
        await expect(run('gov:conclude_legislation_vote', { legislationId: 3 })).resolves.toEqual({ ...verdict, title: 'Clean Air Act' });
        expect(h.pushes).toEqual([{
            perm: 'gov:view',
            payload: { title: 'Legislation concluded', body, tag: 'gov-legislation-concluded-3', data: { view: 'government', tab: 'legislation', legislationId: 3 } },
        }]);
    });

    it('a stored empty title falls back to the generic name, as the other pushes do', async () => {
        seedConclusion('government_legislation', 'government_legislation_votes', '', ['for']);
        await run('gov:conclude_legislation_vote', { legislationId: 3 });
        expect(h.pushes.map(p => p.payload.body)).toEqual(['A bill passed.']);
    });

    it('a refused conclusion — wrong state, or a state that moved mid-conclusion — announces nothing', async () => {
        on('government_legislation', 'select', { data: { id: 3, status: 'Vetoed', title: 'Clean Air Act' } });
        await expect(run('gov:conclude_legislation_vote', { legislationId: 3 })).rejects.toThrow('Legislation is not in voting phase');
        resetFake();
        seedConclusion('government_legislation', 'government_legislation_votes', 'Clean Air Act', ['for'], { data: [] });
        await expect(run('gov:conclude_legislation_vote', { legislationId: 3 })).rejects.toThrow('Legislation is no longer in voting phase — it was not concluded.');
        expect(h.pushes).toEqual([]);
    });
});

describe('(d) gov:conclude_motion announces the motion by name with its real verdict', () => {
    it.each([
        [['for', 'abstain'], { passed: true, status: 'Passed' }, 'Adjourn passed.'],
        [['against'], { passed: false, status: 'Failed' }, 'Adjourn was defeated.'],
    ])('ballots %j → %j → "%s"', async (votes, verdict, body) => {
        seedConclusion('government_motions', 'government_motion_votes', 'Adjourn', votes);
        await expect(run('gov:conclude_motion', { motionId: 3 })).resolves.toEqual({ ...verdict, title: 'Adjourn' });
        expect(h.pushes).toEqual([{
            perm: 'gov:view',
            payload: { title: 'Motion concluded', body, tag: 'gov-motion-concluded-3', data: { view: 'government', tab: 'motions', motionId: 3 } },
        }]);
    });

    it('an empty title falls back to the generic name; a refused conclusion announces nothing', async () => {
        seedConclusion('government_motions', 'government_motion_votes', '', []);
        await run('gov:conclude_motion', { motionId: 3 });
        expect(h.pushes.map(p => p.payload.body)).toEqual(['A motion was defeated.']);

        resetFake();
        h.pushes = [];
        on('government_motions', 'select', { data: { id: 3, status: 'Cancelled', title: 'Adjourn' } });
        await expect(run('gov:conclude_motion', { motionId: 3 })).rejects.toThrow('Motion is not in voting phase');
        expect(h.pushes).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// (e) Instant-runoff: the same ballots store the same numbers, whatever the row order
// ---------------------------------------------------------------------------

// A=70, B=71, C=72, D=73, one seat. Round 1: A 4, D 2, B 1, C 1 of 8 — no majority, and
// B and C tie for last. Eliminating B moves its ballot to A (A 5 of 8, D 2, C 1); eliminating
// C moves its ballot to D, then B goes alone (A 5, D 3). Both branches seat A, so the tie
// does not matter — but they report DIFFERENT final rounds, and concludeElection stores
// each candidate's vote_count from whichever branch the search follows first. That used to
// be whichever of B / C had its ballot READ first (random uuids); it is now the lowest id.
const [A, B, C, D] = [70, 71, 72, 73];
const ballotsOf = (voter: string, ...prefs: number[]) => prefs.map((candidate_id, i) => ({ candidate_id, rank_order: i + 1, voter_hash: voter }));
const RANK1_A = [1, 2, 3, 4].flatMap(n => ballotsOf(`a${n}`, A));
const BALLOT_B = ballotsOf('b', B, A);
const BALLOT_C = ballotsOf('c', C, D);
const BALLOT_D = [1, 2].flatMap(n => ballotsOf(`d${n}`, D));
// Rows as the (rank_order, id) read returns them: every rank-1 row, then the rank-2 rows.
// Only the position of B's and C's rows (i.e. their random ids) differs.
const B_READ_FIRST = [...RANK1_A, BALLOT_B[0], BALLOT_C[0], ...BALLOT_D, BALLOT_B[1], BALLOT_C[1]];
const C_READ_FIRST = [...RANK1_A, BALLOT_C[0], BALLOT_B[0], ...BALLOT_D, BALLOT_C[1], BALLOT_B[1]];

describe('(e) instantRunoff reports the same rounds whichever tied ballot is read first', () => {
    const byCandidate = (r: ReturnType<typeof instantRunoff>) => [...r.allResults].sort((p, q) => p.candidateId - q.candidateId);

    it('follows the lowest candidate id first: B (71) is eliminated, not C', () => {
        const bFirst = instantRunoff([[A], [A], [A], [A], [B, A], [C, D], [D], [D]], 1);
        const cFirst = instantRunoff([[A], [A], [A], [A], [C, D], [B, A], [D], [D]], 1);
        const expected = [
            { candidateId: A, voteCount: 5, percentage: 62.5 },
            { candidateId: C, voteCount: 1, percentage: 12.5 },
            { candidateId: D, voteCount: 2, percentage: 25 },
        ];
        for (const r of [bFirst, cFirst]) {
            expect(r.isConclusive).toBe(true);
            expect(r.tie).toBeUndefined();
            expect(r.totalVotes).toBe(8);
            expect(r.winners).toEqual([{ candidateId: A, voteCount: 5, percentage: 62.5 }]);
            expect(byCandidate(r)).toEqual(expected);
        }
    });
});

describe('(e) concludeElection stores identical results for the same ballots in two row orders', () => {
    function seedRanked(rows: Array<{ candidate_id: number; rank_order: number; voter_hash: string }>, idBase: number) {
        // Fresh ids per order, as two reads of uuid-keyed rows would carry.
        const withIds = rows.map((r, i) => ({ id: uuid(idBase + i), ...r }));
        on('government_elections', 'select', { data: {
            id: 1, status: 'Voting', max_winners: 1, election_type: 'Preferential', min_voter_turnout_pct: null,
            eligible_voter_count: null, min_vote_threshold_pct: null, allow_runoff: false, position_id: 3, voting_end: null,
            runoff_top_n: 2, title: 'Race', created_by_id: 9,
        } });
        on('government_election_votes', 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count: withIds.length };
            const [from, to] = calls(q, 'range')[0] as number[];
            return { data: withIds.slice(from, to + 1) };
        });
        on('government_election_voter_registry', 'select', { count: 8 });
        on('government_election_candidates', 'select', (q: FakeQuery) => ({ data: { user_id: (eqs(q).id as number) * 10, election_id: 1 } }));
        on('users', 'select', { data: { id: 1 } });
        on('government_position_holders', 'select', { data: null });
        fake.rpcResult = { data: 500, error: null };
    }
    const stored = () => ({
        candidates: queries('government_election_candidates', 'update')
            .map(q => ({ id: eqs(q).id, ...(q.values as Row) }))
            .sort((p, q) => (p.id as number) - (q.id as number)),
        election: (() => {
            const v = { ...(only('government_elections', 'update').values as Row) };
            for (const k of ['concluded_at', 'voting_end', 'updated_at']) {
                expect(v[k]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                delete v[k];
            }
            return v;
        })(),
        appointed: fake.rpcCalls.filter(c => c.fn === 'gov_appoint_holder').map(c => c.args),
    });

    it('outcome AND per-candidate counts match, and are the lowest-id branch\'s numbers', async () => {
        const results: Array<ReturnType<typeof stored>> = [];
        for (const [rows, idBase] of [[B_READ_FIRST, 0], [C_READ_FIRST, 500]] as const) {
            resetFake();
            seedRanked([...rows], idBase);
            const res = await concludeElection(1);
            expect(res.status).toBe('Concluded');
            expect(res.conclusionReason).toBe('Election concluded normally');
            results.push(stored());
        }
        expect(results[1]).toEqual(results[0]);
        expect(results[0]).toEqual({
            candidates: [
                { id: A, vote_count: 5, vote_percentage: 62.5, is_winner: true },
                { id: C, vote_count: 1, vote_percentage: 12.5, is_winner: false },
                { id: D, vote_count: 2, vote_percentage: 25, is_winner: false },
            ],
            election: { status: 'Concluded', conclusion_reason: 'Election concluded normally', total_votes_cast: 8 },
            appointed: [{ p_position_id: 3, p_user_id: 700, p_appointed_by_id: null, p_election_id: 1 }],
        });
    });
});
