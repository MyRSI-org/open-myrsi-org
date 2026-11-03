import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// lib/db/government/internal.ts — the shared core of the government domain:
// row mappers (the field-by-field narrowing every government row passes before the
// wire), the government_update broadcast (slice discriminators only), the keyed
// secret-ballot voter hash, the ballot reads (page to exhaustion + exact-count
// verification, fail closed) and the five tally algorithms.

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());

import {
    fake, on, only, eqs, calls, resetFake, assertNoWildcards, govBroadcasts, type FakeQuery,
} from './cov-db-government-fake';
import {
    toGovernmentConfig, toGovernmentBranch, toGovernmentPosition, toGovernmentPositionHolder,
    toGovernmentElection, toGovernmentElectionCandidate, toGovernmentLegislation,
    toGovernmentLegislationComment, toGovernmentLegislationVote, toGovernmentMotion,
    broadcastGovernmentUpdate, computeVoterHash, getVotesForElection, getVoterCount,
    tallySimpleMajority, tallyPlurality, tallyApproval, tallyPreferential, tallyPreferentialFull,
    tallyProportional, GOVERNMENT_TEMPLATES, USER_HYDRATE, findSeatCutoffTie, instantRunoff,
} from '../lib/db/government/internal';
import { IMPORTED_BALLOT_HASH_PREFIX } from '../lib/db/importedBallot';

type Row = Record<string, unknown>;
// Mapper inputs are generated-row types; fixtures are deliberately partial.
const row = <T>(r: Row) => r as unknown as T;

const USER_EMBED = {
    id: 7, name: 'Alice', avatar_url: 'a.png', role_id: 2, rank_id: 1, rsi_handle: 'alice',
    // Columns a future embed might add — must never survive toMiniUser.
    discord_id: 'LEAK-DISCORD', admin_notes: 'LEAK-NOTES', personnel_notes: 'LEAK-PN',
};

function expectMiniUser(u: unknown, id: number, name: string) {
    const m = u as Record<string, unknown>;
    expect(m).toMatchObject({ id, name, rsiHandle: 'alice', avatarUrl: 'a.png' });
    expect(m.discordId).toBe('');
    expect(m.adminNotes).toBeUndefined();
    expect(m.personnelNotes).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('LEAK');
}

beforeEach(() => { resetFake(); });
afterEach(() => { assertNoWildcards(); });

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

describe('government row mappers', () => {
    it('toGovernmentConfig maps every field and turns empty optionals into undefined', () => {
        const full = toGovernmentConfig(row({
            id: 'c1', government_type: 'westminster', name: 'Parliament', description: 'desc',
            constitution_content: { type: 'doc' }, created_at: 't0', updated_at: 't1',
        }));
        expect(full).toEqual({
            id: 'c1', governmentType: 'westminster', name: 'Parliament', description: 'desc',
            constitutionContent: { type: 'doc' }, createdAt: 't0', updatedAt: 't1',
        });
        const bare = toGovernmentConfig(row({ id: 'c2', government_type: 'custom', name: 'G', description: null, constitution_content: null, created_at: 't', updated_at: 't' }));
        expect(bare.description).toBeUndefined();
        expect(bare.constitutionContent).toBeUndefined();
    });

    it('toGovernmentBranch leaves positions for later hydration and drops empty optionals', () => {
        expect(toGovernmentBranch(row({ id: 1, name: 'Senate', branch_type: 'Legislative', description: null, sort_order: 2, icon: null, created_at: 't' })))
            .toEqual({ id: 1, name: 'Senate', branchType: 'Legislative', description: undefined, sortOrder: 2, icon: undefined, createdAt: 't', positions: undefined });
        expect(toGovernmentBranch(row({ id: 2, name: 'Exec', branch_type: 'Executive', description: 'd', sort_order: 0, icon: 'i', created_at: 't' })))
            .toMatchObject({ description: 'd', icon: 'i' });
    });

    it('toGovernmentPosition maps the authority flags and defaults absent grants/orders flags', () => {
        const p = toGovernmentPosition(row({
            id: 3, branch_id: null, name: 'President', description: null, fill_method: 'Elected',
            term_length_days: null, max_holders: 1, icon: null, sort_order: 0, permissions_granted: null,
            can_propose_legislation: true, can_vote_legislation: false, can_veto_legislation: true,
            can_call_elections: true, can_issue_orders: null, created_at: 't',
        }));
        expect(p).toEqual({
            id: 3, branchId: undefined, name: 'President', description: undefined, fillMethod: 'Elected',
            termLengthDays: undefined, maxHolders: 1, icon: undefined, sortOrder: 0, permissionsGranted: [],
            canProposeLegislation: true, canVoteLegislation: false, canVetoLegislation: true,
            canCallElections: true, canIssueOrders: false, createdAt: 't', currentHolders: undefined,
        });
        const q = toGovernmentPosition(row({
            id: 4, branch_id: 9, name: 'Senator', description: 'd', fill_method: 'Elected', term_length_days: 90,
            max_holders: 10, icon: 'i', sort_order: 1, permissions_granted: ['gov:elected_official'],
            can_propose_legislation: false, can_vote_legislation: true, can_veto_legislation: false,
            can_call_elections: false, can_issue_orders: true, created_at: 't',
        }));
        expect(q).toMatchObject({ branchId: 9, description: 'd', termLengthDays: 90, icon: 'i', permissionsGranted: ['gov:elected_official'], canIssueOrders: true });
    });

    it('toGovernmentPositionHolder narrows the user embeds to the roster-safe mini user', () => {
        const h = toGovernmentPositionHolder(row({
            id: 50, position_id: 3, user_id: 7, appointed_by_id: 8, election_id: 11,
            started_at: 's', ended_at: 'e', end_reason: 'resigned', created_at: 'c',
            user: USER_EMBED, appointed_by: { ...USER_EMBED, id: 8, name: 'Bob' },
        }));
        expect(h).toMatchObject({ id: 50, positionId: 3, userId: 7, appointedById: 8, electionId: 11, startedAt: 's', endedAt: 'e', endReason: 'resigned', createdAt: 'c' });
        expectMiniUser(h.user, 7, 'Alice');
        expectMiniUser(h.appointedBy, 8, 'Bob');

        const bare = toGovernmentPositionHolder(row({ id: 51, position_id: 3, user_id: 7, appointed_by_id: null, election_id: null, started_at: 's', ended_at: null, end_reason: null, created_at: 'c' }));
        expect(bare).toMatchObject({ user: undefined, appointedBy: undefined, appointedById: undefined, electionId: undefined, endedAt: undefined, endReason: undefined });
    });

    it('toGovernmentElection parses the numeric thresholds and maps nested position/candidates', () => {
        const e = toGovernmentElection(row({
            id: 1, position_id: 3, title: 'T', description: 'd', election_type: 'Preferential', status: 'Voting',
            candidacy_start: 'cs', candidacy_end: 'ce', voting_start: 'vs', voting_end: 've',
            min_candidates: 2, max_winners: 1, min_voter_turnout_pct: '25.5', min_vote_threshold_pct: '50',
            allow_runoff: true, runoff_top_n: 2, parent_election_id: 9, is_by_election: true, remaining_term_days: 30,
            created_by_id: 7, concluded_at: 'ca', conclusion_reason: 'r', certified_by_id: 8, certified_at: 'cert',
            eligible_voter_count: 10, total_votes_cast: 4, created_at: 't0', updated_at: 't1', has_voted: true,
            position: { id: 3, name: 'President', fill_method: 'Elected', max_holders: 1, sort_order: 0, permissions_granted: [] },
            created_by: USER_EMBED,
            candidates: [{ id: 70, election_id: 1, user_id: 7, platform_statement: 'p', declared_at: 'd', withdrawn_at: null, is_winner: false, vote_count: 0, vote_percentage: '12.5', user: USER_EMBED }],
        }));
        expect(e).toMatchObject({
            id: 1, positionId: 3, title: 'T', description: 'd', electionType: 'Preferential', status: 'Voting',
            candidacyStart: 'cs', candidacyEnd: 'ce', votingStart: 'vs', votingEnd: 've', minCandidates: 2, maxWinners: 1,
            minVoterTurnoutPct: 25.5, minVoteThresholdPct: 50, allowRunoff: true, runoffTopN: 2, parentElectionId: 9,
            isByElection: true, remainingTermDays: 30, createdById: 7, concludedAt: 'ca', conclusionReason: 'r',
            certifiedById: 8, certifiedAt: 'cert', eligibleVoterCount: 10, totalVotesCast: 4, hasVoted: true,
            createdAt: 't0', updatedAt: 't1',
        });
        expect(e.position).toMatchObject({ id: 3, name: 'President', fillMethod: 'Elected' });
        expectMiniUser(e.createdBy, 7, 'Alice');
        expect(e.candidates).toHaveLength(1);
        // vote_count 0 is a real zero (??), vote_percentage arrives as a numeric string.
        expect(e.candidates![0]).toMatchObject({ id: 70, voteCount: 0, votePercentage: 12.5, platformStatement: 'p' });

        const bare = toGovernmentElection(row({
            id: 2, position_id: 3, title: 'T', description: null, election_type: 'SimpleMajority', status: 'Draft',
            min_candidates: 1, max_winners: 1, min_voter_turnout_pct: null, min_vote_threshold_pct: null,
            allow_runoff: false, runoff_top_n: 2, is_by_election: false, created_by_id: 7, created_at: 't', updated_at: 't',
        }));
        expect(bare).toMatchObject({ description: undefined, minVoterTurnoutPct: undefined, minVoteThresholdPct: undefined, position: undefined, createdBy: undefined, candidates: undefined, eligibleVoterCount: undefined });
    });

    it('toGovernmentElectionCandidate keeps null tallies undefined', () => {
        const c = toGovernmentElectionCandidate(row({ id: 1, election_id: 2, user_id: 3, platform_statement: null, declared_at: 'd', withdrawn_at: 'w', is_winner: true, vote_count: null, vote_percentage: null }));
        expect(c).toEqual({ id: 1, electionId: 2, userId: 3, user: undefined, platformStatement: undefined, declaredAt: 'd', withdrawnAt: 'w', isWinner: true, voteCount: undefined, votePercentage: undefined });
    });

    it('toGovernmentLegislation maps the record, comments and votes', () => {
        const l = toGovernmentLegislation(row({
            id: 1, title: 'Act', body: { type: 'doc' }, summary: 's', status: 'Passed', author_id: 7,
            sponsor_position_id: 3, parent_legislation_id: 2, is_constitutional_amendment: true,
            voting_start: 'vs', voting_end: 've', votes_for: 3, votes_against: 1, votes_abstain: 0,
            passed_at: 'p', vetoed_at: 'v', vetoed_by_id: 8, veto_reason: 'vr', repealed_at: 'r',
            repealed_by_legislation_id: 4, created_at: 't0', updated_at: 't1',
            author: USER_EMBED, vetoed_by: { ...USER_EMBED, id: 8, name: 'Bob' },
            sponsor_position: { id: 3, name: 'Senator', sort_order: 0, max_holders: 1, permissions_granted: [] },
            comments: [{ id: 5, legislation_id: 1, user_id: 7, content: 'hi', created_at: 'c', user: USER_EMBED }],
            legislation_votes: [{ id: 6, legislation_id: 1, user_id: 7, position_id: 3, vote: 'for', cast_at: 'ca', user: USER_EMBED, position: { id: 3, name: 'Senator', permissions_granted: [] } }],
        }));
        expect(l).toMatchObject({
            id: 1, title: 'Act', summary: 's', status: 'Passed', authorId: 7, sponsorPositionId: 3, parentLegislationId: 2,
            isConstitutionalAmendment: true, votingStart: 'vs', votingEnd: 've', votesFor: 3, votesAgainst: 1, votesAbstain: 0,
            passedAt: 'p', vetoedAt: 'v', vetoedById: 8, vetoReason: 'vr', repealedAt: 'r', repealedByLegislationId: 4,
        });
        expectMiniUser(l.author, 7, 'Alice');
        expectMiniUser(l.vetoedBy, 8, 'Bob');
        expect(l.sponsorPosition).toMatchObject({ id: 3, name: 'Senator' });
        expect(l.comments).toHaveLength(1);
        expect(l.comments![0]).toMatchObject({ id: 5, legislationId: 1, userId: 7, content: 'hi', createdAt: 'c' });
        expectMiniUser(l.comments![0].user, 7, 'Alice');
        expect(toGovernmentLegislationComment(row({ id: 9, legislation_id: 1, user_id: 7, content: 'x', created_at: 'c' })).user).toBeUndefined();
        expect(l.votes![0]).toMatchObject({ id: 6, legislationId: 1, userId: 7, positionId: 3, vote: 'for', castAt: 'ca' });
        expect(l.votes![0].position).toMatchObject({ id: 3, name: 'Senator' });

        const bare = toGovernmentLegislation(row({ id: 2, title: 'B', body: '', summary: null, status: 'Draft', author_id: 7, is_constitutional_amendment: false, votes_for: 0, votes_against: 0, votes_abstain: 0, created_at: 't', updated_at: 't' }));
        expect(bare).toMatchObject({ summary: undefined, author: undefined, sponsorPosition: undefined, vetoedBy: undefined, comments: undefined, votes: undefined });
    });

    it('toGovernmentLegislationVote without embeds leaves them undefined', () => {
        expect(toGovernmentLegislationVote(row({ id: 1, legislation_id: 2, user_id: 3, position_id: 4, vote: 'abstain', cast_at: 'c' })))
            .toEqual({ id: 1, legislationId: 2, userId: 3, user: undefined, positionId: 4, position: undefined, vote: 'abstain', castAt: 'c' });
    });

    describe('toGovernmentMotion description parsing', () => {
        const motion = (description: unknown, extra: Row = {}) => toGovernmentMotion(row({
            id: 1, title: 'M', description, status: 'Open', created_by_id: 7, restricted_to_position_ids: null,
            votes_for: 1, votes_against: 2, votes_abstain: 0, is_secret_ballot: false, created_at: 't', updated_at: 't', ...extra,
        }));

        it('re-parses a legacy JSON-encoded TipTap string into the object', () => {
            const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
            expect(motion(`  ${JSON.stringify(doc)}  `).description).toEqual(doc);
            expect(motion('[{"type":"paragraph"}]').description).toEqual([{ type: 'paragraph' }]);
        });
        it('keeps a stored object as-is', () => {
            expect(motion({ type: 'doc' }).description).toEqual({ type: 'doc' });
        });
        it('keeps plain text and malformed JSON as the raw string', () => {
            expect(motion('Plain motion text').description).toBe('Plain motion text');
            expect(motion('{not json').description).toBe('{not json');
        });
        it('maps an empty/absent description to undefined', () => {
            expect(motion('').description).toBeUndefined();
            expect(motion(null).description).toBeUndefined();
        });
        it('maps the vote record and creator, dropping empty optionals', () => {
            const m = motion(null, { restricted_to_position_ids: [3, 4], voting_start: 'vs', voting_end: 've', concluded_at: 'c', is_secret_ballot: true, created_by: USER_EMBED });
            expect(m).toMatchObject({ id: 1, title: 'M', status: 'Open', createdById: 7, restrictedToPositionIds: [3, 4], votingStart: 'vs', votingEnd: 've', votesFor: 1, votesAgainst: 2, votesAbstain: 0, isSecretBallot: true, concludedAt: 'c' });
            expectMiniUser(m.createdBy, 7, 'Alice');
            expect(motion(null)).toMatchObject({ restrictedToPositionIds: undefined, votingStart: undefined, concludedAt: undefined, createdBy: undefined });
        });
    });
});

describe('shared fragments', () => {
    it('USER_HYDRATE enumerates exactly the mini-user columns (no wildcard, no PII)', () => {
        expect(USER_HYDRATE).toBe('id, name, avatar_url, role_id, rank_id, rsi_handle');
    });

    it('every template position is well-formed and only apex seats grant gov:manage', () => {
        expect(GOVERNMENT_TEMPLATES.map(t => t.type)).toEqual([
            'military_junta', 'corporate_board', 'democratic_republic', 'constitutional_monarchy', 'westminster', 'technocracy', 'pirate_code',
        ]);
        for (const t of GOVERNMENT_TEMPLATES) {
            expect(t.branches.length).toBeGreaterThan(0);
            for (const b of t.branches) for (const p of b.positions) {
                expect(p.maxHolders).toBeGreaterThan(0);
                if (p.permissionsGranted?.includes('gov:manage')) expect(p.canCallElections).toBe(true);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

describe('broadcastGovernmentUpdate', () => {
    it('carries a single slice discriminator and nothing else', () => {
        broadcastGovernmentUpdate('elections');
        expect(govBroadcasts()).toEqual([{ slices: ['elections'] }]);
    });
    it('omitting the slice sends an empty payload (wholesale refetch)', () => {
        broadcastGovernmentUpdate();
        expect(govBroadcasts()).toEqual([{}]);
    });
});

// ---------------------------------------------------------------------------
// Voter hash
// ---------------------------------------------------------------------------

describe('computeVoterHash key precedence', () => {
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['BALLOT_PEPPER', 'SECRETS_ENCRYPTION_KEY', 'JWT_SECRET'];
    beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
    afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    const hmac = (key: string) => createHmac('sha256', key).update('7:42').digest('hex');

    it('BALLOT_PEPPER wins over SECRETS_ENCRYPTION_KEY so a key rotation keeps motion dedup', () => {
        process.env.BALLOT_PEPPER = 'pinned-old-key';
        process.env.SECRETS_ENCRYPTION_KEY = 'rotated-new-key';
        expect(computeVoterHash(7, 42)).toBe(hmac('pinned-old-key'));
    });
    it('without BALLOT_PEPPER the chain is SECRETS_ENCRYPTION_KEY then JWT_SECRET', () => {
        delete process.env.BALLOT_PEPPER;
        process.env.SECRETS_ENCRYPTION_KEY = 'sek';
        expect(computeVoterHash(7, 42)).toBe(hmac('sek'));
    });
    it('refuses with no key at all, naming every accepted variable', () => {
        for (const k of KEYS) delete process.env[k];
        expect(() => computeVoterHash(7, 42)).toThrow(/BALLOT_PEPPER \/ SECRETS_ENCRYPTION_KEY \(or JWT_SECRET\) is not configured/);
    });
});

// ---------------------------------------------------------------------------
// Ballot reads
// ---------------------------------------------------------------------------

const ballot = (candidate_id: number, rank_order: number | null = null, id = 0) => ({ candidate_id, rank_order, id });

describe('getVotesForElection — every ballot or none', () => {
    it('reads one ordered page and verifies the total against an exact count', async () => {
        const rows = [ballot(1, null, 1), ballot(2, null, 2)];
        on('government_election_votes', 'select', (q) => (q.selectOpts?.head ? { count: 2 } : { data: rows }));

        await expect(getVotesForElection(5)).resolves.toEqual(rows);

        const [page, count] = fake.queries;
        expect(page.columns).toBe('candidate_id, rank_order, id');
        expect(eqs(page)).toEqual({ election_id: 5 });
        expect(calls(page, 'order')).toEqual([['id', { ascending: true }]]);
        expect(calls(page, 'range')).toEqual([[0, 999]]);
        expect(count.columns).toBe('id');
        expect(count.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(count)).toEqual({ election_id: 5 });
    });

    it('keeps paging while pages are full and stops on the first short page', async () => {
        const full = Array.from({ length: 1000 }, (_, i) => ballot(1, null, i));
        const tail = [ballot(2, null, 1000)];
        on('government_election_votes', 'select', (q) => {
            if (q.selectOpts?.head) return { count: 1001 };
            const [from] = calls(q, 'range')[0] as number[];
            return { data: from === 0 ? full : tail };
        });
        const votes = await getVotesForElection(5);
        expect(votes).toHaveLength(1001);
        const ranges = fake.queries.filter(q => !q.selectOpts).map(q => calls(q, 'range')[0]);
        expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    });

    it('a page read error refuses (never a partial tally)', async () => {
        on('government_election_votes', 'select', { error: { message: 'timeout' } });
        await expect(getVotesForElection(5)).rejects.toThrow('Failed to fetch votes');
    });

    it('a count read error refuses', async () => {
        on('government_election_votes', 'select', (q) => (q.selectOpts?.head ? { error: { message: 'x' } } : { data: [] }));
        await expect(getVotesForElection(5)).rejects.toThrow('Failed to verify the ballot count');
    });

    // Converted: the two rows shared the default id 0, which now refuses as a repeated id
    // before the count is ever compared. Distinct ids keep this on the count path.
    it('a count that disagrees with the rows read (a ballot cast after the read position) refuses', async () => {
        on('government_election_votes', 'select', (q) => (q.selectOpts?.head ? { count: 3 } : { data: [ballot(1, null, 1), ballot(2, null, 2)] }));
        await expect(getVotesForElection(5)).rejects.toThrow('The ballot count changed while tallying — re-run the count.');
        expect(fake.queries.filter(q => q.selectOpts?.head)).toHaveLength(1);
    });

    it('an unknown (null) count refuses rather than trusting the pages', async () => {
        on('government_election_votes', 'select', (q) => (q.selectOpts?.head ? { count: null } : { data: [] }));
        await expect(getVotesForElection(5)).rejects.toThrow(/re-run the count/);
    });

    // Converted: every page used to be the SAME 1000 rows, which now refuses as repeated
    // ids on page 2. Each page carries its own ids, so the ceiling is what refuses.
    it('refuses past the page ceiling instead of reporting a partial count', async () => {
        on('government_election_votes', 'select', (q) => {
            const [from] = calls(q, 'range')[0] as number[];
            return { data: Array.from({ length: 1000 }, (_, i) => ballot(1, null, from + i)) };
        });
        await expect(getVotesForElection(5)).rejects.toThrow('Too many ballots to tally safely — refusing to report a partial count.');
        // 500 pages were read and the count was never consulted.
        expect(fake.queries).toHaveLength(500);
        expect(fake.queries.some(q => q.selectOpts?.head)).toBe(false);
    });
});

describe('getVoterCount — the turnout denominator fails closed', () => {
    it('counts the voter registry for the election', async () => {
        on('government_election_voter_registry', 'select', { count: 12 });
        await expect(getVoterCount(4)).resolves.toBe(12);
        const q = only('government_election_voter_registry', 'select');
        expect(q.columns).toBe('id');
        expect(q.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(q)).toEqual({ election_id: 4 });
    });
    it('a zero electorate is a real zero', async () => {
        on('government_election_voter_registry', 'select', { count: 0 });
        await expect(getVoterCount(4)).resolves.toBe(0);
    });
    it('a read error refuses', async () => {
        on('government_election_voter_registry', 'select', { error: { message: 'x' } });
        await expect(getVoterCount(4)).rejects.toThrow('Failed to count the electorate');
    });
    it('an unknown count refuses rather than reading as zero', async () => {
        on('government_election_voter_registry', 'select', { count: null });
        await expect(getVoterCount(4)).rejects.toThrow('Could not determine the electorate size — refusing to judge turnout.');
    });
});

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------

describe('counting tallies', () => {
    const votes = [ballot(1), ballot(2), ballot(1), ballot(3), ballot(1), ballot(2)];

    it('tallySimpleMajority counts one per row, sorts descending and seats the top N', () => {
        const r = tallySimpleMajority(votes, 2);
        expect(r.totalVotes).toBe(6);
        expect(r.allResults).toEqual([
            { candidateId: 1, voteCount: 3, percentage: 50 },
            { candidateId: 2, voteCount: 2, percentage: (2 / 6) * 100 },
            { candidateId: 3, voteCount: 1, percentage: (1 / 6) * 100 },
        ]);
        expect(r.winners.map(w => w.candidateId)).toEqual([1, 2]);
        expect(r.isConclusive).toBe(true);
        expect(r.reason).toBeUndefined();
    });

    it('nothing to count is inconclusive with a stated reason', () => {
        expect(tallySimpleMajority([], 1)).toEqual({ winners: [], allResults: [], totalVotes: 0, isConclusive: false, reason: 'No votes cast' });
    });

    it('plurality and approval count exactly like simple majority', () => {
        expect(tallyPlurality(votes, 1)).toEqual(tallySimpleMajority(votes, 1));
        expect(tallyApproval(votes, 3)).toEqual(tallySimpleMajority(votes, 3));
    });

    it('tallyPreferential (fallback) counts only first preferences and unranked rows', () => {
        const ranked = [ballot(1, 1), ballot(2, 2), ballot(2, 1), ballot(3, null), ballot(1, 3)];
        const r = tallyPreferential(ranked, 1);
        expect(r.totalVotes).toBe(3);
        expect(r.allResults.map(x => [x.candidateId, x.voteCount])).toEqual([[1, 1], [2, 1], [3, 1]]);
    });
});

describe('tallyProportional (D\'Hondt)', () => {
    it('allocates seats by quotient, ties going to the earlier candidate', () => {
        const v = [...Array(6).fill(ballot(1)), ...Array(3).fill(ballot(2)), ballot(3)];
        const r = tallyProportional(v, 3);
        // Seat 1: A(6). Seat 2: A 6/2=3 vs B 3 — tie, A keeps it. Seat 3: B(3) beats A 6/3=2.
        expect(r.winners.map(w => w.candidateId)).toEqual([1, 2]);
        expect(r.allResults.map(x => x.candidateId)).toEqual([1, 2, 3]);
        expect(r.totalVotes).toBe(10);
        expect(r.isConclusive).toBe(true);
        expect(r.reason).toBeUndefined();
    });

    it('a single dominant list takes every seat but is reported once', () => {
        const r = tallyProportional([ballot(9), ballot(9)], 2);
        expect(r.winners).toEqual([{ candidateId: 9, voteCount: 2, percentage: 100 }]);
    });

    it('no votes: no seats, inconclusive, with the reason', () => {
        expect(tallyProportional([], 3)).toEqual({ winners: [], allResults: [], totalVotes: 0, isConclusive: false, reason: 'No votes cast' });
    });
});

describe('tallyPreferentialFull (instant-runoff)', () => {
    let nextId = 1;
    const ranked = (voter: string, ...candidates: number[]) => candidates.map((c, i) => ({ voter_hash: voter, candidate_id: c, rank_order: i + 1, id: nextId++ }));
    type RankedRow = { voter_hash: string; candidate_id: number; rank_order: number; id: number };
    // Route the paged ballot read (honouring .range) and its exact count from one row set.
    function seed(rows: RankedRow[], count: number | null = rows.length) {
        on('government_election_votes', 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count };
            const [from, to] = calls(q, 'range')[0] as number[];
            return { data: rows.slice(from, to + 1) };
        });
    }
    beforeEach(() => { nextId = 1; });

    it('pages the ranked ballots with voter_hash on a total order — (rank_order, id) — for that election', async () => {
        seed(ranked('v1', 1));
        await tallyPreferentialFull(8, 1);
        const read = fake.queries.find(q => !q.selectOpts)!;
        expect(read.columns).toBe('voter_hash, candidate_id, rank_order, id');
        expect(eqs(read)).toEqual({ election_id: 8 });
        expect(calls(read, 'order')).toEqual([['rank_order', { ascending: true }], ['id', { ascending: true }]]);
        expect(calls(read, 'range')).toEqual([[0, 999]]);
    });

    // BUG FIX (pinned): the read was one unbounded select. PostgREST caps that at its
    // max-rows, and the count check then REFUSED every ranked election larger than the
    // cap — such an election could never conclude. It now pages to exhaustion.
    it('a ranked election larger than one page is read in full and concludes', async () => {
        // 1001 voters: 600 rank 1 > 2, 401 rank 2 > 1, so 2002 rows over three pages.
        const rows = [
            ...Array.from({ length: 600 }, (_, i) => ranked(`a${i}`, 1, 2)).flat(),
            ...Array.from({ length: 401 }, (_, i) => ranked(`b${i}`, 2, 1)).flat(),
        ].sort((x, y) => (x.rank_order - y.rank_order) || (x.id - y.id));
        seed(rows);
        const r = await tallyPreferentialFull(8, 1);
        expect(fake.queries.filter(q => !q.selectOpts).map(q => calls(q, 'range')[0])).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
        expect(r.isConclusive).toBe(true);
        expect(r.totalVotes).toBe(1001);
        expect(r.winners).toEqual([{ candidateId: 1, voteCount: 600, percentage: (600 / 1001) * 100 }]);
    });

    it('a ballot that shifts across a page boundary mid-read (a repeated id) refuses', async () => {
        const full = Array.from({ length: 1000 }, (_, i) => ({ voter_hash: `v${i}`, candidate_id: 1, rank_order: 1, id: i + 1 }));
        on('government_election_votes', 'select', (q: FakeQuery) => {
            if (q.selectOpts?.head) return { count: 1001 };
            const [from] = calls(q, 'range')[0] as number[];
            // Page 2 starts with the last row of page 1 again: a rank-1 ballot was cast
            // into page 1's span, pushing that row across — and the total still matches.
            return { data: from === 0 ? full : [full[999]] };
        });
        await expect(tallyPreferentialFull(8, 1)).rejects.toThrow('Could not read every ranked ballot — refusing to report a partial count.');
    });

    it('refuses past the page ceiling instead of reporting a partial count', async () => {
        on('government_election_votes', 'select', (q: FakeQuery) => {
            const [from] = calls(q, 'range')[0] as number[];
            return { data: Array.from({ length: 1000 }, (_, i) => ({ voter_hash: `v${from + i}`, candidate_id: 1, rank_order: 1, id: from + i })) };
        });
        await expect(tallyPreferentialFull(8, 1)).rejects.toThrow('Too many ballots to tally safely — refusing to report a partial count.');
        expect(fake.queries).toHaveLength(500);
        expect(fake.queries.some(q => q.selectOpts?.head)).toBe(false);
    });

    it('no ballots: inconclusive, "No votes cast"', async () => {
        seed([]);
        await expect(tallyPreferentialFull(8, 1)).resolves.toEqual({ winners: [], allResults: [], totalVotes: 0, isConclusive: false, reason: 'No votes cast' });
        // A page that comes back with no data at all reads as no rows (the count must agree).
        resetFake();
        on('government_election_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 0 } : { data: null }));
        await expect(tallyPreferentialFull(8, 1)).resolves.toMatchObject({ isConclusive: false, reason: 'No votes cast' });
    });

    it('an outright first-round majority wins immediately', async () => {
        seed([...ranked('v1', 1, 2), ...ranked('v2', 1, 3), ...ranked('v3', 2, 1)]);
        const r = await tallyPreferentialFull(8, 1);
        expect(r.isConclusive).toBe(true);
        expect(r.totalVotes).toBe(3);
        expect(r.winners).toEqual([{ candidateId: 1, voteCount: 2, percentage: (2 / 3) * 100 }]);
    });

    it('eliminates the last-placed candidate and transfers those ballots to the next preference', async () => {
        // Round 1: A=2, B=2, C=1 — no majority of 5. C is eliminated and v5's ballot
        // transfers to B, which then holds 3 of 5.
        seed([
            ...ranked('v1', 1, 2), ...ranked('v2', 1, 3),
            ...ranked('v3', 2, 1), ...ranked('v4', 2, 3),
            ...ranked('v5', 3, 2),
        ]);
        const r = await tallyPreferentialFull(8, 1);
        expect(r.isConclusive).toBe(true);
        expect(r.totalVotes).toBe(5);
        expect(r.winners).toEqual([{ candidateId: 2, voteCount: 3, percentage: 60 }]);
        expect(r.allResults.map(x => [x.candidateId, x.voteCount])).toEqual([[2, 3], [1, 2]]);
    });

    it('stops eliminating once the field is no larger than the seats', async () => {
        // A=3, B=2, C=1 of 6 for two seats: no majority; C (alone in last) goes, and A
        // and B fill the two seats.
        seed([...ranked('a1', 1), ...ranked('a2', 1), ...ranked('a3', 1), ...ranked('b1', 2), ...ranked('b2', 2), ...ranked('c1', 3)]);
        const r = await tallyPreferentialFull(8, 2);
        expect(r.isConclusive).toBe(true);
        expect(r.winners.map(w => w.candidateId)).toEqual([1, 2]);
    });

    // Converted: this used to pin 4 candidates tied on 1 vote for 2 seats being seated by
    // elimination order ([1, 2]). Which two survive is exactly what the tie decides.
    it('a field tied all the way down to the seats is a tie, not seated by elimination order', async () => {
        seed([...ranked('v1', 1), ...ranked('v2', 2), ...ranked('v3', 3), ...ranked('v4', 4)]);
        const r = await tallyPreferentialFull(8, 2);
        expect(r.isConclusive).toBe(false);
        expect(r.winners).toEqual([]);
        expect(r.tie).toEqual({ candidateIds: [1, 2, 3, 4], label: 'Ranked-choice tie between 4 candidates for 2 seats' });
    });

    it('exhausted ballots with no seat to fill end as "IRV inconclusive"', async () => {
        seed([...ranked('v1', 1), ...ranked('v2', 2), ...ranked('v3', 3)]);
        const r = await tallyPreferentialFull(8, 0);
        expect(r).toEqual({ winners: [], allResults: [], totalVotes: 3, isConclusive: false, reason: 'IRV inconclusive' });
    });

    it('refuses to re-tally ballots imported from another deployment', async () => {
        seed([
            { voter_hash: `${IMPORTED_BALLOT_HASH_PREFIX}a`, candidate_id: 1, rank_order: 1, id: 1 },
            { voter_hash: 'native', candidate_id: 2, rank_order: 1, id: 2 },
        ]);
        const r = await tallyPreferentialFull(8, 1);
        expect(r.isConclusive).toBe(false);
        expect(r.winners).toEqual([]);
        expect(r.totalVotes).toBe(0);
        expect(r.reason).toMatch(/imported from another deployment cannot be re-tallied here/);
    });

    // BUG FIX (pinned): this read discarded its error, so a transient fault came back as
    // "No votes cast" — and concludeElection then filed the election as Cancelled with that
    // false reason. A Cancelled election cannot be re-run; a refused one can.
    it('a ballot read error refuses instead of reading as "No votes cast"', async () => {
        on('government_election_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 2 } : { error: { message: 'statement timeout' } }));
        await expect(tallyPreferentialFull(8, 1)).rejects.toThrow('Failed to fetch votes');
    });

    // The rows read are verified against an exact count and refused on a gap.
    it('a count that disagrees with the rows read refuses instead of tallying a subset', async () => {
        seed([...ranked('v1', 1, 2), ...ranked('v2', 2, 1)], 1500);
        await expect(tallyPreferentialFull(8, 1)).rejects.toThrow('Could not read every ranked ballot — refusing to report a partial count.');
        const count = fake.queries.find(q => q.selectOpts?.head)!;
        expect(count.columns).toBe('id');
        expect(count.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(count)).toEqual({ election_id: 8 });
    });

    it('a count read error, or an unknown count, also refuses', async () => {
        on('government_election_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { error: { message: 'x' } } : { data: ranked('v1', 1) }));
        await expect(tallyPreferentialFull(8, 1)).rejects.toThrow('Failed to verify the ballot count');
        resetFake();
        seed(ranked('v1', 1), null);
        await expect(tallyPreferentialFull(8, 1)).rejects.toThrow(/partial count/);
    });

    it('a deciding tie in the count comes back inconclusive with the tie, for concludeElection', async () => {
        seed([...ranked('v1', 1, 2), ...ranked('v2', 2, 1)].sort((x, y) => (x.rank_order - y.rank_order) || (x.id - y.id)));
        const r = await tallyPreferentialFull(8, 1);
        expect(r).toEqual({
            winners: [], totalVotes: 2, isConclusive: false,
            allResults: [{ candidateId: 1, voteCount: 1, percentage: 50 }, { candidateId: 2, voteCount: 1, percentage: 50 }],
            tie: { candidateIds: [1, 2], label: 'Ranked-choice tie between 2 candidates in the final round' },
        });
        expect(r.reason).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Ties that decide a seat
// ---------------------------------------------------------------------------

describe('findSeatCutoffTie', () => {
    const res = (...counts: Array<[number, number]>) => counts.map(([candidateId, voteCount]) => ({ candidateId, voteCount, percentage: 0 }));

    // BUG FIX (pinned): only a tie at the TOP was detected, so with A 5, B 3, C 3 for two
    // seats the second seat went to whichever of B / C sorted first.
    it('a tie straddling the last seat is a tie between everyone on that count', () => {
        expect(findSeatCutoffTie(res([1, 5], [2, 3], [3, 3]), 2)).toEqual({ candidateIds: [2, 3], label: 'Tie between 2 candidates' });
        expect(findSeatCutoffTie(res([1, 5], [2, 3], [3, 3], [4, 3], [5, 1]), 2)).toEqual({ candidateIds: [2, 3, 4], label: 'Tie between 3 candidates' });
    });

    it('a tie for first wider than the seats is still a tie', () => {
        expect(findSeatCutoffTie(res([1, 4], [2, 4], [3, 4]), 2)).toEqual({ candidateIds: [1, 2, 3], label: 'Tie between 3 candidates' });
        expect(findSeatCutoffTie(res([1, 4], [2, 4]), 1)).toEqual({ candidateIds: [1, 2], label: 'Tie between 2 candidates' });
    });

    it('no tie at the cutoff — including a tie that fits inside the seats, or one below it — is no tie', () => {
        expect(findSeatCutoffTie(res([1, 3], [2, 3], [3, 1]), 2)).toBeNull();
        expect(findSeatCutoffTie(res([1, 5], [2, 3], [3, 1], [4, 1]), 2)).toBeNull();
    });

    it('a field no larger than the seats, or no seat at all, has no cutoff to tie on', () => {
        expect(findSeatCutoffTie(res([1, 2], [2, 2]), 2)).toBeNull();
        expect(findSeatCutoffTie(res([1, 2], [2, 2]), 0)).toBeNull();
        expect(findSeatCutoffTie([], 1)).toBeNull();
    });
});

describe('instantRunoff — a tie for last place is followed every way it can break', () => {
    const ids = (r: { winners: Array<{ candidateId: number }> }) => r.winners.map(w => w.candidateId);
    const repeat = (n: number, ballot: number[]) => Array.from({ length: n }, () => [...ballot]);

    // BUG FIX (pinned): the last-placed candidate was taken from the sort, so a tie for
    // last was broken by ballot order — and that choice could decide the seat.
    it('a dead heat in the final round is a tie, not a win for whoever sorted first', () => {
        const r = instantRunoff([[1], [1], [2], [2]], 1);
        expect(r.isConclusive).toBe(false);
        expect(r.winners).toEqual([]);
        expect(r.tie).toEqual({ candidateIds: [1, 2], label: 'Ranked-choice tie between 2 candidates in the final round' });
        expect(r.allResults.map(x => [x.candidateId, x.voteCount])).toEqual([[1, 2], [2, 2]]);
        expect(r.totalVotes).toBe(4);
    });

    it('a three-way dead heat for one seat is a tie between all three', () => {
        // Each way of breaking it leads to a DIFFERENT final-round tie, so it is this
        // three-way tie that leaves the seat undecided.
        const r = instantRunoff([[1], [2], [3]], 1);
        expect(r.isConclusive).toBe(false);
        expect(r.tie).toEqual({ candidateIds: [1, 2, 3], label: 'Ranked-choice tie between 3 candidates for 1 seat' });
    });

    it('an elimination tie that decides the seat is a tie', () => {
        // A 4, B 3, C 3 of 10: B and C tie for last. Eliminate B and its ballots go to C
        // (C 6, wins); eliminate C and its ballots go to B (B 6, wins).
        const r = instantRunoff([...repeat(4, [1]), ...repeat(3, [2, 3]), ...repeat(3, [3, 2])], 1);
        expect(r.isConclusive).toBe(false);
        expect(r.tie).toEqual({ candidateIds: [2, 3], label: 'Ranked-choice elimination tie between 2 candidates decides the result' });
        expect(r.allResults.map(x => [x.candidateId, x.voteCount])).toEqual([[1, 4], [2, 3], [3, 3]]);
    });

    it('an elimination tie whose every resolution seats the same winner is not a tie', () => {
        // A 4, B 2, C 2, D 1 of 9: no majority. D goes (its ballot exhausts). B and C then
        // tie for last, but both transfer to A, so A wins whichever goes first.
        const r = instantRunoff([...repeat(4, [1]), [2, 1], [2, 1], [3, 1], [3, 1], [4]], 1);
        expect(r.isConclusive).toBe(true);
        expect(r.tie).toBeUndefined();
        expect(ids(r)).toEqual([1]);
        expect(r.winners[0].voteCount).toBe(6);
    });

    // BUG FIX (pinned, review round 2): a majority with more than one seat fills the rest
    // by count, and that 'won' was compared on its sliced seats alone. A 5, B 2, C 2, X 1,
    // Y 1 of 11 for two seats, X → A and Y → B: eliminating X gives A 6 (majority) with B 2
    // against C 2 for seat 2; eliminating Y gives A 6, B 3, C 2. Both slice to {A, B}, so
    // they "agreed" and the search returned whichever branch came first — and which came
    // first was ballot order. X's ballot first: the tied branch, no clear winner. Y's
    // first: A and B seated. Same ballots, two results.
    describe('a multi-seat majority with a dead heat for the last seat', () => {
        const [A, B, C, X, Y] = [1, 2, 3, 4, 5];
        const body = [...repeat(5, [A]), [B], [B], [C], [C]];
        const xFirst = [[X, A], ...body, [Y, B]];
        const yFirst = [[Y, B], ...body, [X, A]];
        const summary = (r: ReturnType<typeof instantRunoff>) => ({
            isConclusive: r.isConclusive,
            winners: ids(r),
            tie: r.tie && { candidateIds: [...r.tie.candidateIds].sort(), label: r.tie.label },
            counts: r.allResults.map(x => [x.candidateId, x.voteCount]).sort((p, q) => p[0] - q[0]),
        });

        it('gives the same result whichever ballot comes first: the elimination tie decides it', () => {
            const expected = {
                isConclusive: false, winners: [],
                tie: { candidateIds: [X, Y], label: 'Ranked-choice elimination tie between 2 candidates decides the result' },
                counts: [[A, 5], [B, 2], [C, 2], [X, 1], [Y, 1]],
            };
            expect(summary(instantRunoff(xFirst, 2))).toEqual(expected);
            expect(summary(instantRunoff(yFirst, 2))).toEqual(expected);
        });

        it('a first-round majority with a dead heat for the last seat is itself a tie', () => {
            // A 3, B 1, C 1 of 5 for two seats: A holds a majority, B against C is level.
            const r = instantRunoff([[A], [A], [A], [B], [C]], 2);
            expect(r.isConclusive).toBe(false);
            expect(r.winners).toEqual([]);
            expect(r.tie).toEqual({ candidateIds: [B, C], label: 'Tie between 2 candidates' });
            expect(r.allResults.map(x => [x.candidateId, x.voteCount])).toEqual([[A, 3], [B, 1], [C, 1]]);
        });

        it('a multi-seat elimination tie whose every resolution seats the same set, with no cutoff tie, still concludes', () => {
            // A 5, B 3, X 1, Y 1 of 10: no majority; X and Y both transfer to A, so either
            // way A 6, B 3 and the survivor 1 — A and B seated, nothing level at the cutoff.
            const ballots = [...repeat(5, [A]), ...repeat(3, [B]), [X, A], [Y, A]];
            for (const order of [ballots, [...ballots].reverse()]) {
                const r = instantRunoff(order, 2);
                expect(r.isConclusive).toBe(true);
                expect(r.tie).toBeUndefined();
                expect(ids(r)).toEqual([A, B]);
            }
        });
    });

    it('when every way of breaking a tie runs into a later deciding tie, that later tie is reported', () => {
        // A 2, B 2, C 1, D 1 of 6 for one seat. C and D tie for last and neither
        // transfers, so either way the next round is A 2, B 2, plus the survivor on 1,
        // which goes — leaving A 2 against B 2: the final round decides nothing.
        const r = instantRunoff([[1], [1], [2], [2], [3], [4]], 1);
        expect(r.isConclusive).toBe(false);
        expect(r.tie).toEqual({ candidateIds: [1, 2], label: 'Ranked-choice tie between 2 candidates in the final round' });
    });

    it('zero-vote candidates tied for last are removed together, without deciding anything', () => {
        // 3 and 4 only ever appear as later preferences: zero first-preference votes.
        // Round 1: A 2, B 2, E 1, C 0, D 0 of 5 — no majority. C and D go together, then
        // E (alone in last) transfers to A, who holds 3 of 5.
        const r = instantRunoff([[1, 3], [1, 4], [2, 4], [2, 3], [5, 1]], 1);
        expect(r.isConclusive).toBe(true);
        expect(ids(r)).toEqual([1]);
        expect(r.winners[0].voteCount).toBe(3);
        // But when the zero-vote candidates would have to fill a seat, which one does is
        // decided by nothing — a tie.
        const thin = instantRunoff([[1, 3], [1, 4], [2, 3], [2, 4]], 3);
        expect(thin.isConclusive).toBe(false);
        expect(thin.tie?.candidateIds).toEqual([3, 4]);
        expect(thin.tie?.label).toBe('Ranked-choice elimination tie between 2 candidates decides the result');
    });

    it('a crowd of zero-vote candidates does not exhaust the tie search', () => {
        // 18 candidates who only ever appear as later preferences. Followed one at a time
        // they would be 2^18 elimination states — far past the budget, and the election
        // would fail closed as a tie for nothing. Removed together, it concludes.
        const tail = Array.from({ length: 18 }, (_, i) => 100 + i);
        const r = instantRunoff([[1, ...tail], [1, 3], [2, ...tail], [2, 3], [5, 1]], 1);
        expect(r.isConclusive).toBe(true);
        expect(r.tie).toBeUndefined();
        expect(ids(r)).toEqual([1]);
    });

    it('fails closed as a tie when the tie search outgrows its budget', () => {
        // 15 candidates, one first-preference vote each, one seat: every round is a full
        // tie, so the elimination states to follow (2^15) far exceed the budget.
        const r = instantRunoff(Array.from({ length: 15 }, (_, i) => [i + 1]), 1);
        expect(r.isConclusive).toBe(false);
        expect(r.winners).toEqual([]);
        expect(r.tie?.label).toBe('Ranked-choice count has too many tied eliminations to resolve safely');
    });
});
