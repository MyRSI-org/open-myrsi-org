import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/government/legislation.ts — bills (draft → proposed → debate → voting →
// passed/failed → vetoed/repealed), their comments and votes, and motions (open →
// voting → passed/failed, optionally secret-ballot and position-restricted).
//
// Body/description sanitisation is already pinned by tests/legislationBodySanitize;
// this suite pins the query shapes, the vote integrity rules, the state-machine
// filters and the fail-closed paths around them.

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());
vi.mock('../lib/supabaseServer', () => ({ supabase: { storage: { from: () => ({}) } }, handleSupabaseError: () => {} }));
// Keep the real (pure) save-side normalisation + image cap; observe read-side signing.
vi.mock('../lib/orgMediaDocs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/orgMediaDocs')>()),
    signDocMediaForClient: vi.fn(async (doc: unknown) => ({ signedFrom: doc })),
}));

import {
    fake, on, only, queries, eqs, calls, writeLog, resetFake, assertNoWildcards, govBroadcasts, type FakeQuery,
} from './cov-db-government-fake';
import {
    getLegislationState, getMotionsState, createLegislation, updateLegislation, proposeLegislation,
    startLegislationDebate, startLegislationVote, castLegislationVote, concludeLegislationVote,
    vetoLegislation, repealLegislation, addLegislationComment, deleteLegislationComment,
    createMotion, startMotionVote, castMotionVote, concludeMotion, cancelMotion,
} from '../lib/db/government/legislation';
import { computeVoterHash, USER_HYDRATE } from '../lib/db/government/internal';
import { signDocMediaForClient } from '../lib/orgMediaDocs';

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEG_COLUMNS = 'id, title, body, summary, status, author_id, sponsor_position_id, parent_legislation_id, is_constitutional_amendment, voting_start, voting_end, votes_for, votes_against, votes_abstain, passed_at, vetoed_at, vetoed_by_id, veto_reason, repealed_at, repealed_by_legislation_id, created_at, updated_at';
const MOTION_COLUMNS = 'id, title, description, status, created_by_id, restricted_to_position_ids, voting_start, voting_end, votes_for, votes_against, votes_abstain, is_secret_ballot, concluded_at, created_at, updated_at';

// A doc with a node the wiki allow-list drops, and one of OUR private signed image URLs
// (which the bill body — but not the motion description — collapses to its bare key).
const privateUrl = () => `${new URL(process.env.SUPABASE_URL!).origin}/storage/v1/object/sign/org-media/media/government/a.webp?token=t`;
const dirtyDoc = () => ({
    type: 'doc',
    content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Section 1' }] },
        { type: 'iframe', attrs: { src: 'https://evil.example' } },
        { type: 'image', attrs: { src: privateUrl() } },
    ],
});

beforeEach(() => { resetFake(); vi.mocked(signDocMediaForClient).mockClear(); });
afterEach(() => { assertNoWildcards(); });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('getLegislationState', () => {
    it('reads the newest 100 bills with explicit embeds and signs each body for the reader', async () => {
        on('government_legislation', 'select', { data: [
            { id: 1, title: 'A', body: { type: 'doc' }, status: 'Draft', author_id: 7, is_constitutional_amendment: false, votes_for: 0, votes_against: 0, votes_abstain: 0, created_at: 't', updated_at: 't' },
            { id: 2, title: 'B', body: '', status: 'Draft', author_id: 7, is_constitutional_amendment: false, votes_for: 0, votes_against: 0, votes_abstain: 0, created_at: 't', updated_at: 't' },
        ] });
        const out = await getLegislationState();
        const q = only('government_legislation', 'select');
        expect(q.columns).toContain(`author:users!government_legislation_author_id_fkey(${USER_HYDRATE})`);
        expect(q.columns).toContain('sponsor_position:government_positions!government_legislation_sponsor_position_id_fkey(id, name, icon)');
        expect(q.columns).toContain('legislation_votes:government_legislation_votes( id, legislation_id, user_id, position_id, vote, cast_at,');
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'limit')).toEqual([[100]]);
        // Only a non-empty body is signed.
        expect(signDocMediaForClient).toHaveBeenCalledTimes(1);
        expect(out[0].body).toEqual({ signedFrom: { type: 'doc' } });
        expect(out[1].body).toBe('');
    });

    it('a failed read degrades to an empty list', async () => {
        on('government_legislation', 'select', { error: { message: 'x' } });
        await expect(getLegislationState()).resolves.toEqual([]);
        expect(fake.safeFetchFallbacks).toEqual(['government_legislation']);
    });
});

describe('getMotionsState', () => {
    const motion = (id: number, status: string, extra: Row = {}) => ({ id, title: `M${id}`, description: null, status, created_by_id: 7, votes_for: 0, votes_against: 0, votes_abstain: 0, is_secret_ballot: false, created_at: 't', updated_at: 't', ...extra });

    it('reads the newest 50 motions with the creator embed', async () => {
        on('government_motions', 'select', { data: [] });
        await expect(getMotionsState()).resolves.toEqual([]);
        const q = only('government_motions', 'select');
        expect(q.columns).toBe(`${MOTION_COLUMNS}, created_by:users!government_motions_created_by_id_fkey(${USER_HYDRATE})`);
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'limit')).toEqual([[50]]);
    });

    it('stamps the viewer\'s own vote on motions in Voting only', async () => {
        on('government_motions', 'select', { data: [motion(1, 'Voting'), motion(2, 'Voting'), motion(3, 'Passed')] });
        on('government_motion_votes', 'select', { data: [{ motion_id: 2, vote: 'against' }] });
        const out = await getMotionsState(42);
        const v = only('government_motion_votes', 'select');
        expect(v.columns).toBe('motion_id, vote');
        expect(eqs(v)).toEqual({ user_id: 42 });
        expect(calls(v, 'in')).toEqual([['motion_id', [1, 2]]]);
        expect(out.map(m => [m.id, m.hasVoted, m.myVote])).toEqual([[1, undefined, undefined], [2, true, 'against'], [3, undefined, undefined]]);
    });

    it('makes no vote read without a viewer or without a motion in Voting, and survives a failed one', async () => {
        on('government_motions', 'select', { data: [motion(1, 'Voting')] });
        await getMotionsState();
        expect(queries('government_motion_votes')).toHaveLength(0);
        resetFake();
        on('government_motions', 'select', { data: [motion(1, 'Open')] });
        await getMotionsState(42);
        expect(queries('government_motion_votes')).toHaveLength(0);
        resetFake();
        on('government_motions', 'select', { data: [motion(1, 'Voting')] });
        on('government_motion_votes', 'select', { error: { message: 'x' } });
        const [m] = await getMotionsState(42);
        expect(m.hasVoted).toBeUndefined();
    });

    it('a failed motions read degrades to an empty list', async () => {
        on('government_motions', 'select', { error: { message: 'x' } });
        await expect(getMotionsState(42)).resolves.toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Bill lifecycle
// ---------------------------------------------------------------------------

describe('createLegislation', () => {
    it('inserts a sanitised Draft authored by the caller and returns it', async () => {
        on('government_legislation', 'insert', { data: { id: 3, title: 'Act', body: {}, status: 'Draft', author_id: 7, is_constitutional_amendment: true, votes_for: 0, votes_against: 0, votes_abstain: 0, created_at: 't', updated_at: 't' } });
        const l = await createLegislation({ title: 'Act', body: dirtyDoc(), summary: 'S', sponsorPositionId: 4, parentLegislationId: 2, isConstitutionalAmendment: true, userId: 7 });
        const q = only('government_legislation', 'insert');
        const v = q.values as Row;
        expect(v).toMatchObject({ title: 'Act', summary: 'S', status: 'Draft', author_id: 7, sponsor_position_id: 4, parent_legislation_id: 2, is_constitutional_amendment: true });
        const body = JSON.stringify(v.body);
        expect(body).not.toContain('iframe');
        expect(body).toContain('"src":"media/government/a.webp"');
        expect(body).not.toContain('token=');
        expect(q.returning).toBe(LEG_COLUMNS);
        expect(l).toMatchObject({ id: 3, status: 'Draft', authorId: 7 });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('defaults the optional fields and keeps the legacy empty body', async () => {
        on('government_legislation', 'insert', { data: null });
        await expect(createLegislation({ title: 'Act', userId: 7 })).resolves.toBeNull();
        expect(only('government_legislation', 'insert').values).toEqual({
            title: 'Act', body: '', summary: null, status: 'Draft', author_id: 7,
            sponsor_position_id: null, parent_legislation_id: null, is_constitutional_amendment: false,
        });
    });

    it('a write failure surfaces the caller message', async () => {
        on('government_legislation', 'insert', { error: { message: 'x' } });
        await expect(createLegislation({ title: 'Act', userId: 7 })).rejects.toThrow('Failed to create legislation');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('updateLegislation', () => {
    it('refuses to change a bill while it is being voted on', async () => {
        on('government_legislation', 'select', { data: { status: 'Voting' } });
        await expect(updateLegislation(3, { title: 'Bait and switch' })).rejects.toThrow('Cannot modify legislation while voting is active');
        const s = only('government_legislation', 'select');
        expect(s.columns).toBe('status');
        expect(eqs(s)).toEqual({ id: 3 });
        expect(writeLog()).toEqual([]);
    });

    // BUG FIX (pinned): the status read discarded its error, so an unreadable status
    // read as "not Voting" and a bill's text could be rewritten mid-vote on exactly the
    // fault that made the guard unverifiable. It now fails closed like updateElection.
    it('fails closed when the status cannot be read', async () => {
        on('government_legislation', 'select', { error: { message: 'statement timeout' } });
        await expect(updateLegislation(3, { title: 'x' })).rejects.toThrow('Failed to load legislation');
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('writes the supplied fields with a sanitised body', async () => {
        on('government_legislation', 'select', { data: { status: 'Debate' } });
        await updateLegislation(3, { title: 'T', body: dirtyDoc(), summary: 'S', sponsorPositionId: 5, isConstitutionalAmendment: false });
        const u = only('government_legislation', 'update');
        const v = u.values as Row;
        expect(v).toMatchObject({ title: 'T', summary: 'S', sponsor_position_id: 5, is_constitutional_amendment: false, updated_at: expect.stringMatching(ISO) });
        expect(JSON.stringify(v.body)).not.toContain('iframe');
        expect(eqs(u)).toEqual({ id: 3 });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('a patch without the body leaves it untouched', async () => {
        on('government_legislation', 'select', { data: { status: 'Draft' } });
        await updateLegislation(3, {});
        expect(only('government_legislation', 'update').values).toEqual({ updated_at: expect.stringMatching(ISO) });
    });

    it('a write failure surfaces the caller message', async () => {
        on('government_legislation', 'select', { data: { status: 'Draft' } });
        on('government_legislation', 'update', { error: { message: 'x' } });
        await expect(updateLegislation(3, { title: 'x' })).rejects.toThrow('Failed to update legislation');
    });
});

describe('bill state transitions only move from the right state', () => {
    it.each([
        ['proposeLegislation', proposeLegislation, { status: 'Proposed' }, { id: 3, status: 'Draft' }, null, 'Failed to propose legislation'],
        ['startLegislationDebate', startLegislationDebate, { status: 'Debate' }, { id: 3, status: 'Proposed' }, null, 'Failed to start debate'],
        ['startLegislationVote', startLegislationVote, { status: 'Voting', voting_start: expect.stringMatching(ISO) }, { id: 3 }, ['status', ['Proposed', 'Debate']], 'Failed to start vote'],
    ] as const)('%s', async (_name, fn, values, eqFilters, inFilter, failure) => {
        await fn(3);
        const u = only('government_legislation', 'update');
        expect(u.values).toEqual({ ...values, updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual(eqFilters);
        expect(calls(u, 'in')).toEqual(inFilter ? [inFilter] : []);
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);

        resetFake();
        on('government_legislation', 'update', { error: { message: 'x' } });
        await expect(fn(3)).rejects.toThrow(failure);
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('castLegislationVote', () => {
    function seedVote({ status = 'Voting', canVote = true as boolean | null, existing = null as Row | null } = {}) {
        on('government_legislation', 'select', { data: status ? { status } : null });
        on('government_position_holders', 'select', { data: canVote === null ? null : { position_id: 4, position: { can_vote_legislation: canVote } } });
        on('government_legislation_votes', 'select',
            { data: existing },
            { data: [{ vote: 'for' }, { vote: 'against' }, { vote: 'for' }, { vote: 'abstain' }, { vote: 'against' }, { vote: 'for' }, { vote: 'bogus' }] });
    }

    it('is refused unless the bill is in Voting', async () => {
        on('government_legislation', 'select', { data: { status: 'Debate' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('Legislation is not in voting phase');
        resetFake();
        on('government_legislation', 'select', { data: null });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('Legislation is not in voting phase');
        expect(writeLog()).toEqual([]);
    });

    it('requires the caller to currently hold THAT position with legislative voting rights', async () => {
        seedVote({ canVote: false });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('You do not hold a position with legislative voting rights');
        const h = only('government_position_holders', 'select');
        expect(h.columns).toBe('position_id, position:government_positions(can_vote_legislation)');
        expect(eqs(h)).toEqual({ user_id: 7, position_id: 4 });
        expect(calls(h, 'is')).toEqual([['ended_at', null]]);
        resetFake();
        seedVote({ canVote: null });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow(/legislative voting rights/);
        expect(writeLog()).toEqual([]);
    });

    it('records the vote then recomputes the tallies from every vote row', async () => {
        seedVote();
        await castLegislationVote(3, 7, 4, 'for');
        const pre = queries('government_legislation_votes', 'select')[0];
        expect(pre.columns).toBe('id');
        expect(eqs(pre)).toEqual({ legislation_id: 3, user_id: 7 });
        expect(only('government_legislation_votes', 'insert').values).toEqual({ legislation_id: 3, user_id: 7, position_id: 4, vote: 'for' });
        const recount = queries('government_legislation_votes', 'select')[1];
        expect(recount.columns).toBe('vote');
        expect(eqs(recount)).toEqual({ legislation_id: 3 });
        // An unknown vote value is not counted anywhere.
        const u = only('government_legislation', 'update');
        expect(u.values).toEqual({ votes_for: 3, votes_against: 2, votes_abstain: 1, updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 3 });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    // Pinned fix: the recount used to discard its read error and fall through
    // `votes || []`, overwriting the cached tally with 0/0/0 — and concludeLegislationVote
    // decides pass/fail from that cache, so a transient fault after the last vote filed a
    // passing bill as 'Failed'. The tally must be left untouched and the error surfaced.
    it('an unreadable recount refuses to overwrite the cached tally (the ballot row is kept)', async () => {
        on('government_legislation', 'select', { data: { status: 'Voting' } });
        on('government_position_holders', 'select', { data: { position_id: 4, position: { can_vote_legislation: true } } });
        on('government_legislation_votes', 'select', { data: null }, { error: { message: 'recount timeout' } });
        await expect(castLegislationVote(3, 7, 4, 'against'))
            .rejects.toThrow('Your vote was recorded, but the legislation tally could not be recounted');
        // The vote itself was stored and the recount was attempted against THIS bill...
        expect(only('government_legislation_votes', 'insert').values).toEqual({ legislation_id: 3, user_id: 7, position_id: 4, vote: 'against' });
        const recount = queries('government_legislation_votes', 'select')[1];
        expect(recount.columns).toBe('vote');
        expect(eqs(recount)).toEqual({ legislation_id: 3 });
        // ...but no tally write was issued at all, so the cached counts survive.
        expect(queries('government_legislation', 'update')).toHaveLength(0);
        expect(writeLog()).toEqual(['government_legislation_votes:insert']);
        // Converted: this pinned NO broadcast. The ballot is stored, so the id-only
        // broadcast now goes out regardless (tests/cov3-government-review-followups).
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('a failed tally write surfaces instead of passing as a successful vote', async () => {
        seedVote();
        on('government_legislation', 'update', { error: { message: 'write timeout' } });
        await expect(castLegislationVote(3, 7, 4, 'for'))
            .rejects.toThrow('Your vote was recorded, but the legislation tally could not be saved');
        // The write carried the correct recount; only its failure is new behaviour.
        const u = only('government_legislation', 'update');
        expect(u.values).toEqual({ votes_for: 3, votes_against: 2, votes_abstain: 1, updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 3 });
        // Converted from "no broadcast": the stored ballot is announced (ids only).
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('one person, one vote: pre-check and the unique violation both refuse', async () => {
        seedVote({ existing: { id: 1 } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('You have already voted on this legislation.');
        expect(writeLog()).toEqual([]);
        resetFake();
        seedVote();
        on('government_legislation_votes', 'insert', { error: { code: '23505', message: 'dup' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('You have already voted on this legislation.');
        expect(queries('government_legislation', 'update')).toHaveLength(0);
    });

    it('any other write failure surfaces the caller message', async () => {
        seedVote();
        on('government_legislation_votes', 'insert', { error: { code: 'XX000', message: 'x' } });
        await expect(castLegislationVote(3, 7, 4, 'for')).rejects.toThrow('Failed to cast legislation vote');
        expect(govBroadcasts()).toEqual([]);
    });
});

// Route a paged ballot read (honouring .range) and its exact count from one vote list.
function seedBallotRows(table: 'government_legislation_votes' | 'government_motion_votes', votes: string[], count: number | null = votes.length) {
    const rows = votes.map((vote, i) => ({ id: i + 1, vote }));
    on(table, 'select', (q: FakeQuery) => {
        if (q.selectOpts?.head) return { count };
        const [from, to] = calls(q, 'range')[0] as number[];
        return { data: rows.slice(from, to + 1) };
    });
}

// BUG FIX (pinned): the conclusion decided pass/fail from the CACHED votes_* columns. The
// cache is refreshed after each cast on a best-effort path (the ballot is stored first),
// so a failed refresh after the deciding vote could pass a bill its ballots defeated, or
// the reverse. The decision now comes from a fresh recount of the ballot rows — paged on
// a total order, verified against an exact count, failing closed — and the cache is
// rewritten from that recount.
// Converted (review follow-up): a conclusion now accepts only a bill in 'Voting', its
// UPDATE is conditional on that status and returns the claimed row (.select('id')), and it
// returns { passed, status, title } for the announcement. Every success fixture below
// therefore seeds a Voting bill and a claiming UPDATE; the refusals are pinned in
// tests/cov3-government-review-followups.test.ts.
function seedBill(over: Row = {}, update: Row = { data: [{ id: 3 }] }) {
    on('government_legislation', 'select', { data: { id: 3, status: 'Voting', title: 'Act', ...over } });
    on('government_legislation', 'update', update);
}

describe('concludeLegislationVote', () => {
    it('recounts the ballot rows, passes on more for than against, and rewrites the cache from the recount', async () => {
        seedBill();
        seedBallotRows('government_legislation_votes', ['for', 'against', 'for', 'abstain', 'for', 'bogus', 'against']);
        await expect(concludeLegislationVote(3)).resolves.toEqual({ passed: true, status: 'Passed', title: 'Act' });

        const leg = only('government_legislation', 'select');
        expect(leg.columns).toBe('id, status, title');
        expect(eqs(leg)).toEqual({ id: 3 });
        expect(leg.terminal).toBe('maybeSingle');
        const [page, count] = queries('government_legislation_votes', 'select');
        expect(page.columns).toBe('id, vote');
        expect(eqs(page)).toEqual({ legislation_id: 3 });
        expect(calls(page, 'order')).toEqual([['id', { ascending: true }]]);
        expect(calls(page, 'range')).toEqual([[0, 999]]);
        expect(count.columns).toBe('id');
        expect(count.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(count)).toEqual({ legislation_id: 3 });

        const u = only('government_legislation', 'update');
        // An unknown vote value is counted nowhere (but still read, so the total matches).
        expect(u.values).toEqual({
            status: 'Passed', passed_at: expect.stringMatching(ISO), voting_end: expect.stringMatching(ISO),
            votes_for: 3, votes_against: 2, votes_abstain: 1, updated_at: expect.stringMatching(ISO),
        });
        expect(eqs(u)).toEqual({ id: 3, status: 'Voting' });
        expect(u.returning).toBe('id');
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('a tie fails the bill', async () => {
        seedBill();
        seedBallotRows('government_legislation_votes', ['for', 'against', 'abstain', 'abstain']);
        await expect(concludeLegislationVote(3)).resolves.toEqual({ passed: false, status: 'Failed', title: 'Act' });
        expect(only('government_legislation', 'update').values).toMatchObject({ status: 'Failed', passed_at: null, votes_for: 1, votes_against: 1, votes_abstain: 2 });
    });

    it('decides from the ballots even when the cached tally says otherwise', async () => {
        // The cache (never read) would say 5–0 for; the ballots say 1–2 against.
        seedBill({ votes_for: 5, votes_against: 0 });
        seedBallotRows('government_legislation_votes', ['for', 'against', 'against']);
        await expect(concludeLegislationVote(3)).resolves.toMatchObject({ passed: false, status: 'Failed' });
        expect(only('government_legislation', 'update').values).toMatchObject({ status: 'Failed', votes_for: 1, votes_against: 2 });
    });

    it('a page that comes back with no data reads as no rows, and the count must agree', async () => {
        seedBill();
        on('government_legislation_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { count: 0 } : { data: null }));
        await expect(concludeLegislationVote(3)).resolves.toMatchObject({ passed: false, status: 'Failed' });
        expect(only('government_legislation', 'update').values).toMatchObject({ status: 'Failed', votes_for: 0, votes_against: 0, votes_abstain: 0 });
    });

    it('pages a large ballot set to exhaustion', async () => {
        seedBill();
        seedBallotRows('government_legislation_votes', [...Array(1500).fill('for'), ...Array(600).fill('against')]);
        await expect(concludeLegislationVote(3)).resolves.toMatchObject({ passed: true, status: 'Passed' });
        const ranges = queries('government_legislation_votes', 'select').filter(q => !q.selectOpts).map(q => calls(q, 'range')[0]);
        expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
        expect(only('government_legislation', 'update').values).toMatchObject({ votes_for: 1500, votes_against: 600, votes_abstain: 0 });
    });

    it('an unknown bill, an unreadable bill, or a failed write, refuses', async () => {
        on('government_legislation', 'select', { data: null });
        await expect(concludeLegislationVote(3)).rejects.toThrow('Legislation not found');
        expect(writeLog()).toEqual([]);
        expect(queries('government_legislation_votes')).toHaveLength(0);
        resetFake();
        on('government_legislation', 'select', { error: { message: 'timeout' } });
        await expect(concludeLegislationVote(3)).rejects.toThrow('Failed to load legislation');
        expect(writeLog()).toEqual([]);
        resetFake();
        seedBill({}, { error: { message: 'x' } });
        seedBallotRows('government_legislation_votes', ['for']);
        await expect(concludeLegislationVote(3)).rejects.toThrow('Failed to conclude vote');
        expect(govBroadcasts()).toEqual([]);
    });

    describe('the recount fails closed — nothing is concluded', () => {
        it('a ballot page read error refuses', async () => {
            seedBill();
            on('government_legislation_votes', 'select', { error: { message: 'timeout' } });
            await expect(concludeLegislationVote(3)).rejects.toThrow('Failed to recount the legislation ballots');
            expect(writeLog()).toEqual([]);
            expect(govBroadcasts()).toEqual([]);
        });

        it('a count read error refuses', async () => {
            seedBill();
            on('government_legislation_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { error: { message: 'x' } } : { data: [{ id: 1, vote: 'for' }] }));
            await expect(concludeLegislationVote(3)).rejects.toThrow('Failed to verify the legislation ballot count');
            expect(writeLog()).toEqual([]);
        });

        it('a count that disagrees with the rows read (a ballot cast mid-recount, or a capped read) refuses', async () => {
            seedBill();
            seedBallotRows('government_legislation_votes', ['for', 'for'], 3);
            await expect(concludeLegislationVote(3)).rejects.toThrow('The legislation ballot count changed while it was being recounted — conclude it again.');
            expect(writeLog()).toEqual([]);
        });

        it('an unknown (null) count refuses rather than trusting the pages', async () => {
            seedBill();
            seedBallotRows('government_legislation_votes', [], null);
            await expect(concludeLegislationVote(3)).rejects.toThrow(/conclude it again/);
            expect(writeLog()).toEqual([]);
        });

        // Converted: every page used to be the SAME 1000 rows, which now refuses as
        // repeated ids on page 2. Each page carries its own ids, so the ceiling refuses.
        it('refuses past the page ceiling instead of concluding on a partial count', async () => {
            seedBill();
            on('government_legislation_votes', 'select', (q: FakeQuery) => {
                const [from] = calls(q, 'range')[0] as number[];
                return { data: Array.from({ length: 1000 }, (_, i) => ({ id: from + i, vote: 'for' })) };
            });
            await expect(concludeLegislationVote(3)).rejects.toThrow('Too many legislation ballots to recount safely — refusing to conclude on a partial count.');
            expect(queries('government_legislation_votes', 'select')).toHaveLength(500);
            expect(queries('government_legislation_votes', 'select').some(q => q.selectOpts?.head)).toBe(false);
            expect(writeLog()).toEqual([]);
        });
    });
});

describe('vetoLegislation', () => {
    it('requires a currently-held position with veto power', async () => {
        on('government_position_holders', 'select', { data: [{ position: { can_veto_legislation: false } }, { position: null }] });
        await expect(vetoLegislation(3, 7, 'no')).rejects.toThrow('You do not hold a position with veto power');
        // Exactly one holdings read: the unused head-count query that preceded it is gone.
        const powers = only('government_position_holders', 'select');
        expect(powers.columns).toBe('position:government_positions(can_veto_legislation)');
        expect(powers.selectOpts).toBeUndefined();
        expect(eqs(powers)).toEqual({ user_id: 7 });
        expect(calls(powers, 'is')).toEqual([['ended_at', null]]);
        expect(writeLog()).toEqual([]);
    });

    it('an unreadable holdings list refuses (no veto on a read fault)', async () => {
        on('government_position_holders', 'select', { error: { message: 'x' } });
        await expect(vetoLegislation(3, 7, 'no')).rejects.toThrow(/veto power/);
        expect(writeLog()).toEqual([]);
    });

    it('vetoes only a Passed bill, recording who and why', async () => {
        on('government_position_holders', 'select', { data: [{ position: { can_veto_legislation: true } }] });
        await vetoLegislation(3, 7, 'Unconstitutional');
        const u = only('government_legislation', 'update');
        expect(u.values).toEqual({ status: 'Vetoed', vetoed_at: expect.stringMatching(ISO), vetoed_by_id: 7, veto_reason: 'Unconstitutional', updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 3, status: 'Passed' });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('an empty reason is stored as null; a write failure surfaces', async () => {
        on('government_position_holders', 'select', { data: [{ position: { can_veto_legislation: true } }] });
        await vetoLegislation(3, 7, '');
        expect((only('government_legislation', 'update').values as Row).veto_reason).toBeNull();
        resetFake();
        on('government_position_holders', 'select', { data: [{ position: { can_veto_legislation: true } }] });
        on('government_legislation', 'update', { error: { message: 'x' } });
        await expect(vetoLegislation(3, 7, 'r')).rejects.toThrow('Failed to veto legislation');
    });
});

describe('repealLegislation', () => {
    it('repeals only a Passed bill, linking the repealing act when there is one', async () => {
        await repealLegislation(3, 9);
        const u = only('government_legislation', 'update');
        expect(u.values).toEqual({ status: 'Repealed', repealed_at: expect.stringMatching(ISO), repealed_by_legislation_id: 9, updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 3, status: 'Passed' });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
        resetFake();
        await repealLegislation(3, null);
        expect((only('government_legislation', 'update').values as Row).repealed_by_legislation_id).toBeNull();
    });

    it('a write failure surfaces', async () => {
        on('government_legislation', 'update', { error: { message: 'x' } });
        await expect(repealLegislation(3, null)).rejects.toThrow('Failed to repeal legislation');
    });
});

describe('legislation comments', () => {
    it('strips markup and control characters and caps the length before storing', async () => {
        on('government_legislation_comments', 'insert', { data: { id: 5, legislation_id: 3, user_id: 7, content: 'stored', created_at: 't' } });
        const c = await addLegislationComment(3, 7, `  <script>x</script><b>Aye</b>\u0007 ${'z'.repeat(5000)}`);
        const q = only('government_legislation_comments', 'insert');
        const v = q.values as Row;
        expect(v.legislation_id).toBe(3);
        expect(v.user_id).toBe(7);
        expect(v.content).toMatch(/^xAye z+$/);
        expect((v.content as string).length).toBe(4000);
        expect(q.returning).toBe('id, legislation_id, user_id, content, created_at');
        expect(c).toEqual({ id: 5, legislationId: 3, userId: 7, user: undefined, content: 'stored', createdAt: 't' });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
    });

    it('a non-string comment is stored empty; a null insert maps to null; a failure surfaces', async () => {
        on('government_legislation_comments', 'insert', { data: null });
        await expect(addLegislationComment(3, 7, { evil: true } as never)).resolves.toBeNull();
        expect((only('government_legislation_comments', 'insert').values as Row).content).toBe('');
        resetFake();
        on('government_legislation_comments', 'insert', { error: { message: 'x' } });
        await expect(addLegislationComment(3, 7, 'x')).rejects.toThrow('Failed to add comment');
    });

    it('deletes a comment by id', async () => {
        await deleteLegislationComment(5);
        expect(eqs(only('government_legislation_comments', 'delete'))).toEqual({ id: 5 });
        expect(govBroadcasts()).toEqual([{ slices: ['legislation'] }]);
        resetFake();
        on('government_legislation_comments', 'delete', { error: { message: 'x' } });
        await expect(deleteLegislationComment(5)).rejects.toThrow('Failed to delete comment');
    });
});

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

describe('createMotion', () => {
    it('inserts an Open motion with a sanitised description (no media key collapse) and returns it', async () => {
        on('government_motions', 'insert', { data: { id: 2, title: 'M', description: null, status: 'Open', created_by_id: 7, votes_for: 0, votes_against: 0, votes_abstain: 0, is_secret_ballot: true, created_at: 't', updated_at: 't' } });
        const m = await createMotion({ title: 'M', description: dirtyDoc(), isSecretBallot: true, userId: 7 });
        const q = only('government_motions', 'insert');
        const v = q.values as Row;
        expect(v).toMatchObject({ title: 'M', status: 'Open', created_by_id: 7, restricted_to_position_ids: null, is_secret_ballot: true });
        const desc = JSON.stringify(v.description);
        expect(desc).not.toContain('iframe');
        // Deliberately NOT normalised to the bare key: motions are never re-signed on read.
        expect(desc).toContain('token=t');
        expect(q.returning).toBe(MOTION_COLUMNS);
        expect(queries('government_positions')).toHaveLength(0);
        expect(m).toMatchObject({ id: 2, status: 'Open', isSecretBallot: true });
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);
    });

    it('validates the restricted positions: deduped, integers only, every one must exist', async () => {
        on('government_positions', 'select', { data: [{ id: 3 }, { id: 4 }] });
        on('government_motions', 'insert', { data: null });
        await expect(createMotion({ title: 'M', restrictedToPositionIds: [3, 4, 3, 1.5], userId: 7 })).resolves.toBeNull();
        const p = only('government_positions', 'select');
        expect(p.columns).toBe('id');
        expect(calls(p, 'in')).toEqual([['id', [3, 4]]]);
        expect(only('government_motions', 'insert').values).toEqual({
            title: 'M', description: null, status: 'Open', created_by_id: 7, restricted_to_position_ids: [3, 4], is_secret_ballot: false,
        });
    });

    it('refuses a restriction naming a position that does not exist (or an unreadable list)', async () => {
        on('government_positions', 'select', { data: [{ id: 3 }] });
        await expect(createMotion({ title: 'M', restrictedToPositionIds: [3, 999], userId: 7 })).rejects.toThrow('One or more restricted positions do not exist.');
        expect(writeLog()).toEqual([]);
        resetFake();
        on('government_positions', 'select', { error: { message: 'x' } });
        await expect(createMotion({ title: 'M', restrictedToPositionIds: [3], userId: 7 })).rejects.toThrow(/do not exist/);
        expect(writeLog()).toEqual([]);
    });

    it('an empty restriction list stores no restriction; a write failure surfaces', async () => {
        on('government_motions', 'insert', { error: { message: 'x' } });
        await expect(createMotion({ title: 'M', restrictedToPositionIds: [], userId: 7 })).rejects.toThrow('Failed to create motion');
        expect((only('government_motions', 'insert').values as Row).restricted_to_position_ids).toBeNull();
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('motion state transitions', () => {
    it('startMotionVote opens voting only on an Open motion', async () => {
        await startMotionVote(2);
        const u = only('government_motions', 'update');
        expect(u.values).toEqual({ status: 'Voting', voting_start: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 2, status: 'Open' });
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);
        resetFake();
        on('government_motions', 'update', { error: { message: 'x' } });
        await expect(startMotionVote(2)).rejects.toThrow('Failed to start motion vote');
    });

    it('cancelMotion cancels only an Open or Voting motion', async () => {
        await cancelMotion(2);
        const u = only('government_motions', 'update');
        expect(u.values).toEqual({ status: 'Cancelled', concluded_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 2 });
        expect(calls(u, 'in')).toEqual([['status', ['Open', 'Voting']]]);
        resetFake();
        on('government_motions', 'update', { error: { message: 'x' } });
        await expect(cancelMotion(2)).rejects.toThrow('Failed to cancel motion');
    });

    // Same fix as concludeLegislationVote: decided from a fresh recount, never the cache.
    // Converted like it, too: a Voting motion, a status-conditional UPDATE that returns the
    // claimed row, and { passed, status, title } back.
    function seedOpenVote(over: Row = {}, update: Row = { data: [{ id: 2 }] }) {
        on('government_motions', 'select', { data: { id: 2, status: 'Voting', title: 'Adjourn', ...over } });
        on('government_motions', 'update', update);
    }

    it('concludeMotion recounts the ballots: passes on more for than against, fails a tie, refuses an unknown motion', async () => {
        seedOpenVote({ votes_for: 0, votes_against: 9 });
        seedBallotRows('government_motion_votes', ['for', 'for', 'for', 'for', 'against', 'abstain']);
        await expect(concludeMotion(2)).resolves.toEqual({ passed: true, status: 'Passed', title: 'Adjourn' });
        const m = only('government_motions', 'select');
        expect(m.columns).toBe('id, status, title');
        expect(eqs(m)).toEqual({ id: 2 });
        const [page, count] = queries('government_motion_votes', 'select');
        expect(page.columns).toBe('id, vote');
        expect(eqs(page)).toEqual({ motion_id: 2 });
        expect(calls(page, 'order')).toEqual([['id', { ascending: true }]]);
        expect(calls(page, 'range')).toEqual([[0, 999]]);
        expect(count.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(count)).toEqual({ motion_id: 2 });
        const u = only('government_motions', 'update');
        expect(u.values).toEqual({
            status: 'Passed', concluded_at: expect.stringMatching(ISO), voting_end: expect.stringMatching(ISO),
            votes_for: 4, votes_against: 1, votes_abstain: 1, updated_at: expect.stringMatching(ISO),
        });
        expect(eqs(u)).toEqual({ id: 2, status: 'Voting' });
        expect(u.returning).toBe('id');
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);

        resetFake();
        seedOpenVote();
        seedBallotRows('government_motion_votes', ['for', 'against']);
        await expect(concludeMotion(2)).resolves.toEqual({ passed: false, status: 'Failed', title: 'Adjourn' });
        expect((only('government_motions', 'update').values as Row).status).toBe('Failed');

        resetFake();
        on('government_motions', 'select', { data: null });
        await expect(concludeMotion(2)).rejects.toThrow('Motion not found');
        expect(queries('government_motion_votes')).toHaveLength(0);

        resetFake();
        seedOpenVote({}, { error: { message: 'x' } });
        seedBallotRows('government_motion_votes', ['for']);
        await expect(concludeMotion(2)).rejects.toThrow('Failed to conclude motion');
        expect(govBroadcasts()).toEqual([]);
    });

    it('concludeMotion fails closed on an unreadable motion, an unreadable recount, or a moving count', async () => {
        on('government_motions', 'select', { error: { message: 'x' } });
        await expect(concludeMotion(2)).rejects.toThrow('Failed to load motion');
        expect(writeLog()).toEqual([]);

        resetFake();
        seedOpenVote();
        on('government_motion_votes', 'select', { error: { message: 'timeout' } });
        await expect(concludeMotion(2)).rejects.toThrow('Failed to recount the motion ballots');
        expect(writeLog()).toEqual([]);

        resetFake();
        seedOpenVote();
        on('government_motion_votes', 'select', (q: FakeQuery) => (q.selectOpts?.head ? { error: { message: 'x' } } : { data: [] }));
        await expect(concludeMotion(2)).rejects.toThrow('Failed to verify the motion ballot count');

        resetFake();
        seedOpenVote();
        seedBallotRows('government_motion_votes', ['for'], 2);
        await expect(concludeMotion(2)).rejects.toThrow('The motion ballot count changed while it was being recounted — conclude it again.');
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('castMotionVote', () => {
    // Distinct 2/3/1 counts, plus an unknown vote value that must not be counted anywhere.
    const tallyRows = { data: [{ vote: 'against' }, { vote: 'for' }, { vote: 'abstain' }, { vote: 'against' }, { vote: 'bogus' }, { vote: 'against' }, { vote: 'for' }] };
    function seedMotion(motion: Row | null, existing: Row | null = null) {
        on('government_motions', 'select', { data: motion });
        on('government_motion_votes', 'select', { data: existing }, tallyRows);
    }

    it('is refused unless the motion is in Voting', async () => {
        seedMotion({ status: 'Open' });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('Motion is not in voting phase');
        expect(only('government_motions', 'select').columns).toBe('status, is_secret_ballot, restricted_to_position_ids');
        resetFake();
        seedMotion(null);
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('Motion is not in voting phase');
        expect(writeLog()).toEqual([]);
    });

    it('a restricted motion requires a currently-held listed position', async () => {
        seedMotion({ status: 'Voting', is_secret_ballot: false, restricted_to_position_ids: [3, 4] });
        on('government_position_holders', 'select', { count: 0 });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('You do not hold a required position to vote on this motion');
        const h = only('government_position_holders', 'select');
        expect(h.selectOpts).toEqual({ count: 'exact', head: true });
        expect(eqs(h)).toEqual({ user_id: 7 });
        expect(calls(h, 'is')).toEqual([['ended_at', null]]);
        expect(calls(h, 'in')).toEqual([['position_id', [3, 4]]]);
        expect(writeLog()).toEqual([]);
    });

    it('an unreadable restriction count refuses', async () => {
        seedMotion({ status: 'Voting', is_secret_ballot: false, restricted_to_position_ids: [3] });
        on('government_position_holders', 'select', { error: { message: 'x' } });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow(/required position/);
        expect(writeLog()).toEqual([]);
    });

    it('a public ballot records the voter, then recomputes the tallies', async () => {
        seedMotion({ status: 'Voting', is_secret_ballot: false, restricted_to_position_ids: [3] });
        on('government_position_holders', 'select', { count: 1 });
        await castMotionVote(2, 7, 'against');
        const pre = queries('government_motion_votes', 'select')[0];
        expect(pre.columns).toBe('id');
        expect(eqs(pre)).toEqual({ motion_id: 2, user_id: 7 });
        expect(only('government_motion_votes', 'insert').values).toEqual({ motion_id: 2, user_id: 7, vote: 'against' });
        const recount = queries('government_motion_votes', 'select')[1];
        expect(recount.columns).toBe('vote');
        expect(eqs(recount)).toEqual({ motion_id: 2 });
        const u = only('government_motions', 'update');
        expect(u.values).toEqual({ votes_for: 2, votes_against: 3, votes_abstain: 1, updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 2 });
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);
    });

    it('a secret ballot stores only the keyed voter hash — never the user id', async () => {
        seedMotion({ status: 'Voting', is_secret_ballot: true, restricted_to_position_ids: [] });
        await castMotionVote(2, 7, 'for');
        const hash = computeVoterHash(2, 7);
        const pre = queries('government_motion_votes', 'select')[0];
        expect(eqs(pre)).toEqual({ motion_id: 2, voter_hash: hash });
        const ins = only('government_motion_votes', 'insert');
        expect(ins.values).toEqual({ motion_id: 2, voter_hash: hash, vote: 'for' });
        expect(ins.values).not.toHaveProperty('user_id');
        expect(queries('government_position_holders')).toHaveLength(0);
    });

    it.each([
        ['public', false],
        ['secret', true],
    ] as const)('%s ballot: one vote per member (pre-check, then the unique index)', async (_kind, secret) => {
        seedMotion({ status: 'Voting', is_secret_ballot: secret, restricted_to_position_ids: null }, { id: 1 });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('You have already voted on this motion.');
        expect(writeLog()).toEqual([]);

        resetFake();
        seedMotion({ status: 'Voting', is_secret_ballot: secret, restricted_to_position_ids: null });
        on('government_motion_votes', 'insert', { error: { code: '23505', message: 'dup' } });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('You have already voted on this motion.');
        expect(queries('government_motions', 'update')).toHaveLength(0);

        resetFake();
        seedMotion({ status: 'Voting', is_secret_ballot: secret, restricted_to_position_ids: null });
        on('government_motion_votes', 'insert', { error: { code: 'XX000', message: 'x' } });
        await expect(castMotionVote(2, 7, 'for')).rejects.toThrow('Failed to cast motion vote');
        expect(govBroadcasts()).toEqual([]);
    });

    // Pinned fix: same defect as the bill recount — a discarded read error used to
    // write 0/0/0, and concludeMotion decides from that cache.
    it.each([
        ['public', false],
        ['secret', true],
    ] as const)('%s ballot: an unreadable recount refuses to overwrite the cached tally', async (_kind, secret) => {
        on('government_motions', 'select', { data: { status: 'Voting', is_secret_ballot: secret, restricted_to_position_ids: null } });
        on('government_motion_votes', 'select', { data: null }, { error: { message: 'recount timeout' } });
        await expect(castMotionVote(2, 7, 'abstain'))
            .rejects.toThrow('Your vote was recorded, but the motion tally could not be recounted');
        expect(only('government_motion_votes', 'insert').values).toMatchObject({ motion_id: 2, vote: 'abstain' });
        const recount = queries('government_motion_votes', 'select')[1];
        expect(recount.columns).toBe('vote');
        expect(eqs(recount)).toEqual({ motion_id: 2 });
        expect(queries('government_motions', 'update')).toHaveLength(0);
        expect(writeLog()).toEqual(['government_motion_votes:insert']);
        // Converted from "no broadcast": the stored ballot is announced (ids only).
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);
    });

    it('a failed motion tally write surfaces instead of passing as a successful vote', async () => {
        seedMotion({ status: 'Voting', is_secret_ballot: false, restricted_to_position_ids: null });
        on('government_motions', 'update', { error: { message: 'write timeout' } });
        await expect(castMotionVote(2, 7, 'against'))
            .rejects.toThrow('Your vote was recorded, but the motion tally could not be saved');
        const u = only('government_motions', 'update');
        expect(u.values).toEqual({ votes_for: 2, votes_against: 3, votes_abstain: 1, updated_at: expect.stringMatching(ISO) });
        expect(eqs(u)).toEqual({ id: 2 });
        // Converted from "no broadcast": the stored ballot is announced (ids only).
        expect(govBroadcasts()).toEqual([{ slices: ['motions'] }]);
    });
});
