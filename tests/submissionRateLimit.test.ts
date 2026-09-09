import { describe, it, expect, vi, beforeEach } from 'vitest';

// F9/F10: caps on member-initiated HR + job applications. The per-user throttle and
// the free-text length cap bound the unbounded record-creation + recruiter push
// fan-out an authenticated account could otherwise drive; UNIQUE(applicant_id,job_id)
// (schema) stops re-applying to one posting (mapped to a friendly error here).

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select' };
        const b: any = {};
        b.select = () => b;
        b.insert = () => { state.op = 'insert'; return b; };
        b.update = () => { state.op = 'update'; return b; };
        b.eq = () => b; b.ilike = () => b; b.is = () => b; b.in = () => b; b.order = () => b; b.limit = () => b;
        const settle = () => {
            hh.calls.push({ table, op: state.op });
            if (table === 'hr_job_postings') return Promise.resolve({ data: { title: 'Pilot', position_id: 1 }, error: null });
            if (table === 'users') return Promise.resolve({ data: { id: 5, name: 'A', discord_id: 'd', rsi_handle: 'h' }, error: null });
            if (table === 'hr_job_applications' && state.op === 'insert') return Promise.resolve({ data: null, error: hh.jobInsertError });
            if (table === 'hr_applications' && state.op === 'insert') return Promise.resolve({ data: { id: 'app1' }, error: null });
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle(); b.maybeSingle = () => settle();
        b.then = (r: any, j: any) => settle().then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}), safeFetch: async () => [],
    };
});
vi.mock('../lib/push', () => ({ sendPushToUsers: async () => {} }));

const hh = vi.hoisted(() => ({
    jobInsertError: null as null | { code?: string },
    // Which table/verb pairs actually reached the db — a self-scope denial has to
    // stop BEFORE the identity lookup and before the insert, not just throw late.
    calls: [] as Array<{ table: string; op: string }>,
}));

import { checkSubmissionRateLimit, _resetSubmissionRateLimit } from '../lib/submissionRateLimit';
import { createHRApplication, applyForJob } from '../lib/db/hr';

describe('submission rate limiter (F9/F10)', () => {
    beforeEach(() => _resetSubmissionRateLimit());

    it('allows 5 per minute, then blocks', () => {
        const t = 1_000_000;
        for (let i = 0; i < 5; i++) expect(checkSubmissionRateLimit(7, t).ok).toBe(true);
        expect(checkSubmissionRateLimit(7, t).ok).toBe(false);
    });

    it('resets after the minute window', () => {
        const t = 1_000_000;
        for (let i = 0; i < 5; i++) checkSubmissionRateLimit(7, t);
        expect(checkSubmissionRateLimit(7, t).ok).toBe(false);
        expect(checkSubmissionRateLimit(7, t + 61_000).ok).toBe(true);
    });

    it('enforces a daily cap (30) across separate minute windows', () => {
        let t = 1_000_000, allowed = 0;
        for (let i = 0; i < 100; i++) { if (checkSubmissionRateLimit(7, t).ok) allowed++; t += 61_000; }
        expect(allowed).toBe(30);
    });

    it('tracks users independently and fails open for a missing id', () => {
        const t = 1_000_000;
        for (let i = 0; i < 5; i++) checkSubmissionRateLimit(7, t);
        expect(checkSubmissionRateLimit(7, t).ok).toBe(false);
        expect(checkSubmissionRateLimit(8, t).ok).toBe(true);
        expect(checkSubmissionRateLimit(undefined, t).ok).toBe(true);
    });
});

describe('HR application length + duplicate guards (F9/F10)', () => {
    beforeEach(() => { hh.jobInsertError = null; hh.calls = []; });

    it('rejects an over-length application statement (createHRApplication)', async () => {
        await expect(createHRApplication({ rsiHandle: 'h', notes: 'x'.repeat(5001), userId: 1 } as any))
            .rejects.toThrow(/too long/i);
    });

    it('rejects an over-length job-application statement (applyForJob)', async () => {
        await expect(applyForJob({ jobId: 'j1', userId: 5, statement: 'x'.repeat(5001) }))
            .rejects.toThrow(/too long/i);
    });

    it('maps a duplicate job application (23505) to a friendly error', async () => {
        hh.jobInsertError = { code: '23505' };
        await expect(applyForJob({ jobId: 'j1', userId: 5, statement: 'ok' }))
            .rejects.toThrow(/already applied/i);
    });
});

// createHRApplication is reachable by ANY authenticated session: user:submit_application
// maps to the `user:manage:self` pseudo-perm, which short-circuits the dispatcher's
// permission check entirely (Clients included). The row it writes carries
// linked_user_id, which drives the Client->Member auto-promotion on Hired AND
// deleteHRApplication's referral_source-keyed cascade against the linked user's
// pending transfer / job applications — so an unscoped handle is a confused deputy
// aimed at whichever HR admin processes it. Recruiter tier keeps the legitimate
// file-for-a-prospect path (AddProspectModal routes through THIS action).
describe('createHRApplication self-scope (any-session forgery)', () => {
    beforeEach(() => { hh.calls = []; });

    const member = (rsiHandle: string) => ({ id: 5, role: 'Member', permissions: ['hr:view', 'user:manage:self'], rsiHandle });
    const inserted = () => hh.calls.some(c => c.table === 'hr_applications' && c.op === 'insert');

    it('refuses a plain member filing against another roster handle', async () => {
        await expect(createHRApplication({ rsiHandle: 'victim', userId: 5, user: member('attacker') } as any))
            .rejects.toThrow(/your own RSI handle/i);
        expect(inserted()).toBe(false);
    });

    it('allows a member filing for their own handle, case-insensitively', async () => {
        await expect(createHRApplication({ rsiHandle: 'Attacker', userId: 5, user: member('attacker') } as any))
            .resolves.toBeDefined();
        expect(inserted()).toBe(true);
    });

    it('allows an hr:recruiter to file for anyone (keeps AddProspectModal working)', async () => {
        await expect(createHRApplication({
            rsiHandle: 'someoneelse', userId: 9,
            user: { id: 9, role: 'Member', permissions: ['hr:recruiter'], rsiHandle: 'recruiter' },
        } as any)).resolves.toBeDefined();
        expect(inserted()).toBe(true);
    });

    it('fails closed when the actor has no rsi handle of their own', async () => {
        await expect(createHRApplication({ rsiHandle: 'someoneelse', userId: 5, user: member('') } as any))
            .rejects.toThrow(/your own RSI handle/i);
        expect(inserted()).toBe(false);
    });

    it('rejects a malformed handle before the identity lookup runs', async () => {
        await expect(createHRApplication({ rsiHandle: '%', userId: 5, user: member('%') } as any))
            .rejects.toThrow(/not a valid RSI handle/i);
        expect(hh.calls.some(c => c.table === 'users')).toBe(false);
    });

    // Ordering pin: the length cap must keep running BEFORE the self-scope check.
    // Move the guard above it and the no-actor case in the previous describe block
    // ("rejects an over-length application statement") flips to the self-scope denial.
    it('still reports an over-length statement before the self-scope check', async () => {
        await expect(createHRApplication({ rsiHandle: 'victim', notes: 'x'.repeat(5001), userId: 5, user: member('attacker') } as any))
            .rejects.toThrow(/too long/i);
    });
});
