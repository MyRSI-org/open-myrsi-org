import { describe, it, expect, vi } from 'vitest';

// HR non-recruiter redaction must not leak through sibling fields:
//   redactInterview also blanks the joined applicantName / interviewer / panel /
//     schedule, not just notes/scores.
//   redactApplicantsForViewer drops linkedUserId / assignedRecruiterId /
//     assignedRecruiter / status so a non-recruiter cannot cross-reference
//     linkedUserId against the roster to learn an application's outcome.

// hr.ts initialises Supabase at module load via ./common; stub it so the pure
// redaction helpers can be imported without a live DB.
vi.mock('../lib/db/common', () => {
    const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
    };
    return {
        supabase: { from: () => chain },
        handleSupabaseError: () => {},
        broadcastToOrg: () => {},
        getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});

import {
    redactInterviewsForViewer,
    redactApplicantsForViewer,
    isHrRecruiter, redactTransfersForViewer } from '../lib/db/hr';
import { ApplicationStatus } from '../types';
import type { HydratedHRInterview, HydratedHRApplication } from '../types';

const REAL_APPLICANT = 'Jane Q. Recruit';
const REAL_INTERVIEWER = 'Sgt. Interviewer';
const REAL_PANELIST = 'Cpl. Panelist';

function makeInterview(): HydratedHRInterview {
    return {
        id: 'int-1',
        applicationId: 'app-1',
        templateId: 7,
        template: { id: 7, name: 'Standard', description: '', questions: [] },
        interviewerId: 42,
        interviewer: { id: 42, name: REAL_INTERVIEWER } as HydratedHRInterview['interviewer'],
        panelMembers: [{ id: 43, name: REAL_PANELIST } as HydratedHRInterview['panelMembers'][number]],
        scheduledAt: '2026-07-01T12:00:00.000Z',
        completedAt: '2026-07-01T13:00:00.000Z',
        overallNotes: 'Strong candidate, recommend.',
        finalScore: 88,
        status: 'Completed',
        isRecommended: true,
        responses: [{ questionId: 1, responseBody: 'good answer', score: 9 }],
        applicantName: REAL_APPLICANT,
    };
}

function makeApplicant(): HydratedHRApplication {
    return {
        id: 'app-1',
        applicantName: REAL_APPLICANT,
        applicantDiscordId: 'discord-12345',
        rsiHandle: 'JaneRecruit',
        status: ApplicationStatus.Rejected,
        referralSource: 'WEBSITE_APPLICATION',
        notes: 'Initial statement here',
        assignedRecruiterId: 99,
        assignedRecruiter: { id: 99, name: 'Recruiter Bob' } as HydratedHRApplication['assignedRecruiter'],
        linkedUserId: 42,
        createdAt: '2026-06-01T00:00:00.000Z',
        vettingData: { stage: 'adjudication' },
        interviews: [makeInterview()],
        logs: [],
    };
}

describe('HR non-recruiter redaction', () => {
    describe('redactInterviewsForViewer — applicantName/identity leak', () => {
        it('blanks applicantName, interviewer, panel, schedule for a non-recruiter', () => {
            const [out] = redactInterviewsForViewer([makeInterview()], false);
            expect(out.applicantName).toBe('');
            expect(out.interviewerId).toBe(0);
            expect(out.interviewer).toEqual({});
            expect(out.panelMembers).toEqual([]);
            expect(out.scheduledAt).toBe('');
            // Notes and scores stay redacted too.
            expect(out.overallNotes).toBeUndefined();
            expect(out.finalScore).toBeUndefined();
            expect(out.isRecommended).toBeUndefined();
            expect(out.responses).toEqual([]);
            // Nothing identifying survives serialization.
            const json = JSON.stringify(out);
            expect(json).not.toContain(REAL_APPLICANT);
            expect(json).not.toContain(REAL_INTERVIEWER);
            expect(json).not.toContain(REAL_PANELIST);
        });

        it('returns the full interview unchanged for a recruiter', () => {
            const [out] = redactInterviewsForViewer([makeInterview()], true);
            expect(out.applicantName).toBe(REAL_APPLICANT);
            expect(out.interviewerId).toBe(42);
            expect(out.interviewer).toMatchObject({ name: REAL_INTERVIEWER });
            expect(out.panelMembers).toHaveLength(1);
            expect(out.scheduledAt).toBe('2026-07-01T12:00:00.000Z');
            expect(out.overallNotes).toBe('Strong candidate, recommend.');
            expect(out.finalScore).toBe(88);
            expect(out.isRecommended).toBe(true);
            expect(out.responses).toHaveLength(1);
        });
    });

    describe('redactApplicantsForViewer — linkedUserId de-anonymization', () => {
        it('nulls linkedUserId / assignedRecruiterId / assignedRecruiter and coarsens status for a non-recruiter', () => {
            const [out] = redactApplicantsForViewer([makeApplicant()], false);
            // The cross-reference keys must be gone.
            expect(out.linkedUserId).toBeUndefined();
            expect(out.assignedRecruiterId).toBeUndefined();
            expect(out.assignedRecruiter).toBeUndefined();
            // Status is coarsened so a blanked row carries no decision signal.
            expect(out.status).toBeUndefined();
            // Identity fields blanked (existing behaviour preserved).
            expect(out.applicantName).toBe('');
            expect(out.rsiHandle).toBe('');
            expect(out.applicantDiscordId).toBe('');
            expect(out.vettingData).toBeUndefined();
            // Nested interviews ride through the same redaction.
            expect(out.interviews[0].applicantName).toBe('');
            expect(out.interviews[0].interviewer).toEqual({});
            // The row cannot be linked back to roster user 42 nor expose the
            // rejection decision.
            const json = JSON.stringify(out);
            expect(json).not.toContain(REAL_APPLICANT);
            expect(json).not.toContain('Recruiter Bob');
            expect(json).not.toContain(ApplicationStatus.Rejected);
            // linked roster id 42 must not be discoverable on this row.
            expect(out.linkedUserId).not.toBe(42);
        });

        it('returns the full applicant unchanged for a recruiter', () => {
            const [out] = redactApplicantsForViewer([makeApplicant()], true);
            expect(out.linkedUserId).toBe(42);
            expect(out.assignedRecruiterId).toBe(99);
            expect(out.assignedRecruiter).toMatchObject({ name: 'Recruiter Bob' });
            expect(out.status).toBe(ApplicationStatus.Rejected);
            expect(out.applicantName).toBe(REAL_APPLICANT);
            expect(out.rsiHandle).toBe('JaneRecruit');
            expect(out.applicantDiscordId).toBe('discord-12345');
            expect(out.vettingData).toEqual({ stage: 'adjudication' });
            // Recruiter interview is untouched.
            expect(out.interviews[0].applicantName).toBe(REAL_APPLICANT);
            expect(out.interviews[0].finalScore).toBe(88);
        });
    });

    describe('isHrRecruiter gating (permission only — no role-name bypass)', () => {
        it('treats hr:recruiter holders as recruiters, plain hr:view as not', () => {
            expect(isHrRecruiter({ permissions: ['hr:recruiter'] })).toBe(true);
            expect(isHrRecruiter({ permissions: ['hr:view'] })).toBe(false);
            expect(isHrRecruiter(null)).toBe(false);
        });
        // The Admin role NAME is not authority: `role` is inferred from the role
        // row's free-text name, so a permissionless custom role called 'Commander'
        // read every case file through the bundle AND the hr_* slices.
        it('does NOT treat a forged Admin role NAME with no permissions as a recruiter', () => {
            expect(isHrRecruiter({ role: 'Admin', permissions: [] } as unknown as Parameters<typeof isHrRecruiter>[0])).toBe(false);
        });
    });
});

describe('transfer requests are PROJECTED for a non-recruiter, not merely blanked', () => {
    // Blanking reason/adminNotes left everything that identifies the request: who asked
    // (the user embed carries name, avatar and rsi_handle), their current unit, the
    // unit they want, and the outcome. hr:view is a seeded Member permission, so every
    // member could read the org's whole internal-mobility picture — who is trying to
    // leave which unit, and whether it was approved.
    const rows = [
        { id: 't1', userId: 7, reason: 'Want ops', adminNotes: 'officer note', status: 'Pending' },
        { id: 't2', userId: 99, reason: 'Personal', adminNotes: 'do not approve', status: 'Denied' },
    ];

    it('a recruiter still sees everything', () => {
        expect(redactTransfersForViewer(rows, true, 7)).toEqual(rows);
    });

    it('a non-recruiter sees ONLY their own request', () => {
        const out = redactTransfersForViewer(rows, false, 7);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('t1');
        expect(JSON.stringify(out), "another member's transfer reached the wire").not.toContain('Personal');
        expect(JSON.stringify(out)).not.toContain('do not approve');
    });

    it("the officer's private note is stripped even on your own row", () => {
        expect(redactTransfersForViewer(rows, false, 7)[0].adminNotes).toBeUndefined();
    });

    it('your own reason survives — you wrote it', () => {
        expect(redactTransfersForViewer(rows, false, 7)[0].reason).toBe('Want ops');
    });

    it('an unidentified viewer gets nothing, not everything', () => {
        expect(redactTransfersForViewer(rows, false, undefined)).toEqual([]);
        expect(redactTransfersForViewer(rows, false, 0)).toEqual([]);
        expect(redactTransfersForViewer(rows, false, NaN)).toEqual([]);
    });
});
