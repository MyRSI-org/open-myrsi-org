import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler-level suite for api/actions/hr.ts.
//
// Every HR handler is a thin adapter, so the behaviour worth pinning is the
// ADAPTATION: which db-layer function each action reaches, with which arguments in
// which order (several take (id, actorId) or (id, targetId, actorId) — a swap acts
// on the wrong person), and that the db result comes back unchanged. On top of that:
//   * hr:get_state passes the injected user (the db layer scopes HR data by it);
//   * hr:save_interview merges the dispatcher-forced interviewerId INTO the results
//     so the attribution cannot come from the client-supplied results blob;
//   * hr:request_transfer (the one member-self-service write here) throttles before
//     writing, bounds and sanitises the reason, writes exactly four columns, and
//     FAILS LOUDLY when the insert resolves with an error.
// tests/sec-user-hr.test.ts keeps the original throttle/length/strip pins.

const spies = vi.hoisted(() => ({
    getHRState: vi.fn(),
    createHRApplication: vi.fn(),
    updateApplicationStatus: vi.fn(),
    updateApplicationData: vi.fn(),
    deleteHRApplication: vi.fn(),
    assignRecruiter: vi.fn(),
    createHRInterview: vi.fn(),
    updateHRInterview: vi.fn(),
    updateInterviewInterviewer: vi.fn(),
    deleteHRInterview: vi.fn(),
    saveInterviewResults: vi.fn(),
    reopenHRInterview: vi.fn(),
    createJobPosting: vi.fn(),
    updateJobPosting: vi.fn(),
    updateJobPostingStatus: vi.fn(),
    deleteJobPosting: vi.fn(),
    applyForJob: vi.fn(),
    processTransferRequest: vi.fn(),
    createInterviewTemplate: vi.fn(),
    updateInterviewTemplate: vi.fn(),
    deleteInterviewTemplate: vi.fn(),
    getHRInterviewTemplateDetails: vi.fn(),
    getMyInterviews: vi.fn(),
    createPersonnelPosition: vi.fn(),
    updatePersonnelPosition: vi.fn(),
    deletePersonnelPosition: vi.fn(),
    addApplicationLog: vi.fn(),
    getHRApplicationLogs: vi.fn(),
    getApplicationVettingData: vi.fn(),
    processJobApproval: vi.fn(),
    getEligibleHRInterviewers: vi.fn(),
    getEligibleHROfficers: vi.fn(),
    // supabase + throttle
    from: vi.fn(),
    insert: vi.fn(),
    assertSubmissionRateLimit: vi.fn(),
}));

vi.mock('../lib/db', () => {
    const { from, insert: _i, assertSubmissionRateLimit: _a, ...dbFns } = spies;
    return { supabase: { from }, ...dbFns };
});
vi.mock('../lib/submissionRateLimit', () => ({ assertSubmissionRateLimit: spies.assertSubmissionRateLimit }));
// lib/textSanitize is deliberately REAL: the persisted reason is the observable.

import { hrActions } from '../api/actions/hr';

type Handler = (p?: unknown) => unknown;
const call = (name: string, p?: unknown) => (hrActions as unknown as Record<string, Handler>)[name](p);

beforeEach(() => {
    for (const s of Object.values(spies)) s.mockReset();
    spies.insert.mockResolvedValue({ data: null, error: null });
    spies.from.mockReturnValue({ insert: spies.insert });
});

// [action, payload, db function, exact expected args]
const PASS_THROUGH: Array<[string, Record<string, unknown> | undefined, keyof typeof spies, unknown[]]> = [
    ['hr:update_app_status', { id: 'app-1', status: 'Accepted', notes: 'welcome', userId: 7 }, 'updateApplicationStatus', ['app-1', 'Accepted', 'welcome', 7]],
    ['hr:update_application_data', { id: 'app-1', data: { vetting: 'clear' } }, 'updateApplicationData', ['app-1', { vetting: 'clear' }]],
    ['hr:delete_application', { id: 'app-1' }, 'deleteHRApplication', ['app-1']],
    ['hr:assign_recruiter', { id: 'app-1', recruiterId: 33, userId: 7 }, 'assignRecruiter', ['app-1', 33, 7]],
    ['hr:update_interview', { interviewId: 'int-1', updates: { scheduledAt: '2026-11-03T10:00:00Z' }, userId: 7 }, 'updateHRInterview', ['int-1', { scheduledAt: '2026-11-03T10:00:00Z' }, 7]],
    ['hr:update_interview_interviewer', { interviewId: 'int-1', newInterviewerId: 44, userId: 7 }, 'updateInterviewInterviewer', ['int-1', 44, 7]],
    ['hr:delete_interview', { interviewId: 'int-1', userId: 7 }, 'deleteHRInterview', ['int-1', 7]],
    ['hr:reopen_interview', { interviewId: 'int-1', userId: 7 }, 'reopenHRInterview', ['int-1', 7]],
    ['hr:delete_job', { id: 'job-1' }, 'deleteJobPosting', ['job-1']],
    ['hr:process_transfer', { id: 'tr-1', status: 'Approved', notes: 'ok' }, 'processTransferRequest', ['tr-1', 'Approved', 'ok']],
    ['hr:delete_template', { id: 5 }, 'deleteInterviewTemplate', [5]],
    ['hr:get_template_details', { id: 5 }, 'getHRInterviewTemplateDetails', [5]],
    ['hr:get_my_interviews', { userId: 7 }, 'getMyInterviews', [7]],
    ['hr:delete_position', { id: 9 }, 'deletePersonnelPosition', [9]],
    ['hr:get_application_logs', { applicationId: 'app-1' }, 'getHRApplicationLogs', ['app-1']],
    ['hr:get_application_data', { id: 'app-1' }, 'getApplicationVettingData', ['app-1']],
    ['hr:process_job_approval', { applicationId: 'app-1' }, 'processJobApproval', ['app-1']],
];

describe('pass-through handlers reach the right db function with the right arguments', () => {
    it.each(PASS_THROUGH)('%s', async (action, payload, fn, args) => {
        const sentinel = { from: fn };
        spies[fn].mockResolvedValue(sentinel);
        await expect(call(action, payload)).resolves.toBe(sentinel);
        expect(spies[fn]).toHaveBeenCalledTimes(1);
        expect(spies[fn]).toHaveBeenCalledWith(...args);
    });

    it('hr:add_log reorders to (applicationId, actionType, message, userId)', async () => {
        await call('hr:add_log', { applicationId: 'app-1', message: 'called candidate', actionType: 'note', userId: 7 });
        expect(spies.addApplicationLog).toHaveBeenCalledWith('app-1', 'note', 'called candidate', 7);
    });

    it('a db rejection propagates unchanged', async () => {
        spies.assignRecruiter.mockRejectedValue(new Error('Recruiter must hold hr:recruiter'));
        await expect(call('hr:assign_recruiter', { id: 'app-1', recruiterId: 33, userId: 7 })).rejects.toThrow('Recruiter must hold hr:recruiter');
    });
});

describe('whole-payload handlers forward the payload object', () => {
    it.each([
        ['hr:create_application', 'createHRApplication', { rsiHandle: 'Jane_Doe', name: 'Jane', userId: 7, assignedRecruiterId: null }],
        ['hr:create_interview', 'createHRInterview', { applicationId: 'app-1', templateId: 2, interviewerId: 44, scheduledAt: '2026-11-03T10:00:00Z', userId: 7 }],
        ['hr:create_job', 'createJobPosting', { title: 'Medic', department: 'Rescue', userId: 7 }],
        ['hr:update_job', 'updateJobPosting', { id: 'job-1', title: 'Medic II', department: 'Rescue' }],
        ['hr:update_job_status', 'updateJobPostingStatus', { id: 'job-1', status: 'Closed' }],
        ['hr:apply_job', 'applyForJob', { jobId: 'job-1', userId: 7, statement: 'I fly a Cutlass Red' }],
        ['hr:create_template', 'createInterviewTemplate', { name: 'Pilot screen', questions: ['Why?'] }],
        ['hr:update_template', 'updateInterviewTemplate', { id: 2, name: 'Pilot screen v2' }],
        ['hr:create_position', 'createPersonnelPosition', { name: 'Quartermaster', icon: 'box' }],
        ['hr:update_position', 'updatePersonnelPosition', { id: 9, name: 'Chief QM' }],
    ] as Array<[string, keyof typeof spies, Record<string, unknown>]>)('%s', async (action, fn, payload) => {
        spies[fn].mockResolvedValue({ ok: action });
        await expect(call(action, payload)).resolves.toEqual({ ok: action });
        expect(spies[fn]).toHaveBeenCalledWith(payload);
    });
});

describe('hr:get_state', () => {
    it('passes the injected user so the db layer can scope HR data to it', async () => {
        const user = { role: 'Member', permissions: ['hr:view'] };
        spies.getHRState.mockResolvedValue({ applications: [] });
        await expect(call('hr:get_state', { user })).resolves.toEqual({ applications: [] });
        expect(spies.getHRState).toHaveBeenCalledWith(user);
    });
});

describe('hr:save_interview', () => {
    it('stamps the dispatcher-forced interviewerId over any interviewerId inside the results blob', async () => {
        const results = { notes: 'solid', finalScore: 8, isRecommended: true, responses: [{ questionId: 1, text: 'a', score: 4 }] };
        await call('hr:save_interview', { id: 'int-1', results: { ...results, interviewerId: 999 }, interviewerId: 7 });
        expect(spies.saveInterviewResults).toHaveBeenCalledWith('int-1', { ...results, interviewerId: 7 });
    });
});

describe('the zero-argument HR picker reads', () => {
    it('hr:get_eligible_interviewers / hr:get_eligible_officers take no caller input', async () => {
        const picker = [{ id: 1, name: 'Ava', avatarUrl: null }];
        spies.getEligibleHRInterviewers.mockResolvedValue(picker);
        spies.getEligibleHROfficers.mockResolvedValue([]);
        await expect(call('hr:get_eligible_interviewers', { scope: '__proto__' })).resolves.toEqual(picker);
        await expect(call('hr:get_eligible_officers', { scope: 'all' })).resolves.toEqual([]);
        expect(spies.getEligibleHRInterviewers).toHaveBeenCalledWith();
        expect(spies.getEligibleHROfficers).toHaveBeenCalledWith();
    });
});

describe('hr:request_transfer', () => {
    const base = { userId: 9, currentUnitId: 2, targetUnitId: 4, reason: 'Want to fly medevac' };

    it('throttles first, then writes exactly the four transfer columns to hr_transfer_requests', async () => {
        await expect(call('hr:request_transfer', base)).resolves.toBeUndefined();
        expect(spies.assertSubmissionRateLimit).toHaveBeenCalledWith(9);
        expect(spies.from).toHaveBeenCalledWith('hr_transfer_requests');
        expect(spies.insert).toHaveBeenCalledTimes(1);
        expect(spies.insert).toHaveBeenCalledWith({
            user_id: 9, current_unit_id: 2, target_unit_id: 4, reason: 'Want to fly medevac',
        });
        expect(spies.assertSubmissionRateLimit.mock.invocationCallOrder[0]).toBeLessThan(spies.insert.mock.invocationCallOrder[0]);
    });

    it('a reason of exactly 5000 characters is accepted; 5001 is refused before any write', async () => {
        await call('hr:request_transfer', { ...base, reason: 'r'.repeat(5000) });
        expect((spies.insert.mock.calls[0][0] as { reason: string }).reason).toHaveLength(5000);

        spies.insert.mockClear();
        await expect(call('hr:request_transfer', { ...base, reason: 'r'.repeat(5001) })).rejects.toThrow('Reason is too long.');
        expect(spies.insert).not.toHaveBeenCalled();
    });

    it('strips tags and control characters from the persisted reason', async () => {
        await call('hr:request_transfer', { ...base, reason: '  <b>medevac</b>\u0007 please  ' });
        expect((spies.insert.mock.calls[0][0] as { reason: string }).reason).toBe('medevac please');
    });

    it('a missing reason persists as an empty string rather than undefined', async () => {
        await call('hr:request_transfer', { ...base, reason: undefined });
        expect((spies.insert.mock.calls[0][0] as { reason: string }).reason).toBe('');
    });

    it('an insert that RESOLVES with an error is surfaced (generic message, no raw db text), not reported as success', async () => {
        spies.insert.mockResolvedValue({ data: null, error: { code: '23503', message: 'fk violation on target_unit_id' } });
        const err = await Promise.resolve(call('hr:request_transfer', base)).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('Failed to submit transfer request.');
    });

    it('a throttle rejection blocks the write', async () => {
        spies.assertSubmissionRateLimit.mockImplementation(() => { throw new Error('Too many submissions'); });
        await expect(call('hr:request_transfer', base)).rejects.toThrow('Too many submissions');
        expect(spies.from).not.toHaveBeenCalled();
        expect(spies.insert).not.toHaveBeenCalled();
    });
});
