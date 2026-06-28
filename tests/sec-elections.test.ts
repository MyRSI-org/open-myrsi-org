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

        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                if (state.wantCount) {
                    return Promise.resolve({ data: state.headOnly ? null : rows(), error: null, count: rows().length });
                }
                const data = rows();
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
