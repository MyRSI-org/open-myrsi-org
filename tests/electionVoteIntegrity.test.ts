import { describe, it, expect, vi, beforeEach } from 'vitest';

// Elections vote-integrity guards:
//   one castElectionVote with selections=[{candidateId:X}×N] writes exactly one
//     government_election_votes row for X (no per-row stuffing).
//   a candidateId belonging to a different election is rejected (registry and
//     votes are never written — fail closed).
//   a second declareCandidacy by the same user for the same election is rejected.
//   an oversized selections array is rejected before any DB write.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    nextId: 1,
    // when set, the NEXT insert into this table returns a 23505 unique violation
    uniqueViolationOn: null as string | null,
}));

function applyEq(rows: Array<Record<string, unknown>>, filters: Record<string, unknown>, isNull: string[], inFilter: { col: string; vals: unknown[] } | null) {
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

        const doInsert = () => {
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (h.uniqueViolationOn === table) {
                h.uniqueViolationOn = null;
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            const vals = Array.isArray(state.values) ? state.values : [state.values];
            const inserted: Array<Record<string, unknown>> = [];
            for (const v of vals) {
                const row = { id: h.nextId++, withdrawn_at: null, ...(v as Record<string, unknown>) };
                list.push(row);
                inserted.push(row);
            }
            return { data: inserted[0] ?? null, error: null };
        };

        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                if (state.wantCount) {
                    return Promise.resolve({ data: state.headOnly ? null : rows(), error: null, count: rows().length });
                }
                const data = rows();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'insert') return Promise.resolve(doInsert());
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

import { castElectionVote, declareCandidacy, updateElection } from '../lib/db/government/elections';
import { ElectionType } from '../types';
import type { GovernmentElection } from '../types';

const VOTER = 50;

function seedElection(over: Record<string, unknown> = {}) {
    h.tables.government_elections = [{
        id: 1, status: 'Voting', election_type: 'SimpleMajority', max_winners: 1,
        min_candidates: 1, ...over,
    }];
}
function seedCandidates(cands: Array<{ id: number; election_id: number; user_id: number; withdrawn_at?: string | null }>) {
    h.tables.government_election_candidates = cands.map(c => ({ withdrawn_at: null, ...c }));
}

beforeEach(() => {
    h.tables = {};
    h.nextId = 1000;
    h.uniqueViolationOn = null;
});

const votesFor = (candidateId: number) =>
    (h.tables.government_election_votes ?? []).filter(r => r.candidate_id === candidateId).length;

describe('HIGH-4 ballot stuffing', () => {
    it('selections=[{candidateId:X}×N] writes EXACTLY ONE vote row for X', async () => {
        seedElection();
        seedCandidates([{ id: 7, election_id: 1, user_id: 70 }]);

        const stuffed = Array.from({ length: 50 }, () => ({ candidateId: 7 }));
        await castElectionVote(1, VOTER, stuffed);

        expect(votesFor(7)).toBe(1);
        expect((h.tables.government_election_votes ?? []).length).toBe(1);
    });

    it('approval ballots dedup per candidate and cap at max_winners distinct rows', async () => {
        seedElection({ election_type: 'Approval', max_winners: 2 });
        seedCandidates([
            { id: 7, election_id: 1, user_id: 70 },
            { id: 8, election_id: 1, user_id: 80 },
            { id: 9, election_id: 1, user_id: 90 },
        ]);

        // candidate 7 repeated many times, plus 8 and 9 — distinct {7,8,9} but cap is 2.
        const selections = [
            ...Array.from({ length: 30 }, () => ({ candidateId: 7 })),
            { candidateId: 8 }, { candidateId: 9 },
        ];
        await castElectionVote(1, VOTER, selections);

        // At most ONE row per candidate, and at most max_winners (2) rows total.
        expect(votesFor(7)).toBeLessThanOrEqual(1);
        expect((h.tables.government_election_votes ?? []).length).toBe(2);
        const distinct = new Set((h.tables.government_election_votes ?? []).map(r => r.candidate_id));
        expect(distinct.size).toBe(2);
    });
});

describe('gov#2 foreign-candidate scope', () => {
    it('rejects a candidateId from a different election and writes nothing', async () => {
        seedElection();
        seedCandidates([
            { id: 7, election_id: 1, user_id: 70 },   // belongs to election 1
            { id: 99, election_id: 2, user_id: 999 }, // belongs to election 2 (foreign)
        ]);

        await expect(castElectionVote(1, VOTER, [{ candidateId: 99 }]))
            .rejects.toThrow(/invalid candidate/i);

        // Fail closed: no ballot rows AND no participation registry row.
        expect((h.tables.government_election_votes ?? []).length).toBe(0);
        expect((h.tables.government_election_voter_registry ?? []).length).toBe(0);
    });
});

describe('gov#3 duplicate candidacy', () => {
    it('rejects a second declareCandidacy by the same user for the same election', async () => {
        h.tables.government_elections = [{ id: 1, status: 'Candidacy' }];
        h.tables.government_election_candidates = [];

        await declareCandidacy(1, VOTER, 'first');
        expect((h.tables.government_election_candidates ?? []).length).toBe(1);

        await expect(declareCandidacy(1, VOTER, 'second'))
            .rejects.toThrow(/already declared candidacy/i);
        // No duplicate row written.
        expect((h.tables.government_election_candidates ?? []).length).toBe(1);
    });

    it('treats a 23505 unique violation as the duplicate guard', async () => {
        h.tables.government_elections = [{ id: 1, status: 'Candidacy' }];
        h.tables.government_election_candidates = []; // pre-check passes (count 0)
        h.uniqueViolationOn = 'government_election_candidates'; // index races us

        await expect(declareCandidacy(1, VOTER, 'racey'))
            .rejects.toThrow(/already declared candidacy/i);
    });
});

describe('LOW selections cap', () => {
    it('rejects an oversized selections array before any DB write', async () => {
        seedElection();
        seedCandidates([{ id: 7, election_id: 1, user_id: 70 }]);

        const oversized = Array.from({ length: 5000 }, () => ({ candidateId: 7 }));
        await expect(castElectionVote(1, VOTER, oversized)).rejects.toThrow(/too many selections/i);

        expect((h.tables.government_election_votes ?? undefined)).toBeUndefined();
        expect((h.tables.government_election_voter_registry ?? undefined)).toBeUndefined();
    });
});

describe('the counting rules are frozen once an election leaves Draft', () => {
    // This build is deliberately AHEAD of hosted on election integrity — HMAC voter
    // hashing, an enforced turnout quorum, ballot dedup. All of that is worth nothing if
    // the rules those mechanisms enforce can be rewritten mid-count.
    //
    // updateElection had no status guard at all, and concludeElection reads these fields
    // AT CONCLUSION TIME. So an official could watch turnout fall short and drop
    // min_voter_turnout_pct, or see the standings and raise max_winners, or flip
    // allow_runoff to manufacture a second round — applied retroactively to ballots cast
    // under different rules, and presented as the authoritative result.
    const seedElection = (status: string) => {
        h.tables['government_elections'] = [{
            id: 900, status, title: 'Speaker', description: null, election_type: 'SimpleMajority',
            max_winners: 1, min_candidates: 1, min_voter_turnout_pct: 50,
            min_vote_threshold_pct: null, allow_runoff: false, runoff_top_n: 2,
        }];
    };
    const updatedRow = () => (h.tables['government_elections'] || [])[0] as Record<string, unknown>;

    it('refuses an outcome-field edit once voting has opened', async () => {
        seedElection('Voting');
        await expect(updateElection(900, { minVoterTurnoutPct: 5 })).rejects.toThrow(/only be changed while it is a draft/i);
        expect(updatedRow().min_voter_turnout_pct, 'the quorum was lowered mid-vote').toBe(50);
    });

    it('refuses it after the election has concluded, too', async () => {
        seedElection('Concluded');
        await expect(updateElection(900, { maxWinners: 3 })).rejects.toThrow(/draft/i);
        expect(updatedRow().max_winners).toBe(1);
    });

    it('covers every field that decides the outcome, not just the quorum', async () => {
        seedElection('Voting');
        const patches: Array<Partial<GovernmentElection>> = [
            { electionType: ElectionType.Preferential }, { maxWinners: 5 }, { minCandidates: 9 },
            { minVoterTurnoutPct: 1 }, { minVoteThresholdPct: 1 },
            { allowRunoff: true }, { runoffTopN: 9 },
        ];
        for (const patch of patches) {
            await expect(updateElection(900, patch), `${Object.keys(patch)[0]} is editable mid-election`).rejects.toThrow(/draft/i);
        }
    });

    it('still allows the rules to be set while the election is a Draft', async () => {
        seedElection('Draft');
        await expect(updateElection(900, { maxWinners: 3 })).resolves.not.toThrow();
    });

    it('leaves cosmetic and SCHEDULE fields editable throughout', async () => {
        // Moving a voting window is ordinary administration and changes no ballot's
        // meaning; refusing it would make the guard something officials route around.
        seedElection('Voting');
        await expect(updateElection(900, { title: 'Speaker (revised)' })).resolves.not.toThrow();
        await expect(updateElection(900, { votingEnd: '2026-12-01T00:00:00Z' })).resolves.not.toThrow();
    });

    it('fails CLOSED — an unreadable status refuses rather than assuming Draft', async () => {
        h.tables['government_elections'] = [];
        await expect(updateElection(901, { maxWinners: 3 })).rejects.toThrow();
    });
});
