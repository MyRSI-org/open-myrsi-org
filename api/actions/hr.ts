
import * as db from '../../lib/db.js';
import type { ApplicationStatus } from '../../types.js';
import { assertSubmissionRateLimit } from '../../lib/submissionRateLimit.js';
import { stripHtml } from '../../lib/textSanitize.js';

// Free-text length cap for member-initiated submissions. Matches MAX_APPLICATION_TEXT
// in lib/db/hr.ts (the application/job-statement cap) so the self-service transfer
// reason can't park a multi-MB blob in hr_transfer_requests.
const MAX_TRANSFER_REASON = 5000;

// --- Payload shapes ---
// Application/interview/job ids are uuid strings; user, recruiter, template
// and position ids are numbers.

// Empty marker base retained so handler payload shapes stay grouped; single-org
// has no per-request organization scoping.
 
interface OrgScopedPayload {}

 
interface GetHRStatePayload { user?: { role?: string; permissions?: string[] } }

interface CreateApplicationPayload extends OrgScopedPayload {
    rsiHandle: string;
    name: string;
    referral?: string;
    notes?: string;
    discordId?: string;
    userId?: number;
    assignedRecruiterId?: number | null;
}

interface UpdateAppStatusPayload extends OrgScopedPayload {
    id: string;
    status: ApplicationStatus;
    notes?: string;
    userId?: number;
}

interface UpdateApplicationDataPayload extends OrgScopedPayload {
    id: string;
    data: Record<string, unknown>;
}

interface DeleteApplicationPayload extends OrgScopedPayload {
    id: string;
}

interface AssignRecruiterPayload extends OrgScopedPayload {
    id: string;
    recruiterId: number;
    userId: number;
}

interface CreateInterviewPayload extends OrgScopedPayload {
    applicationId: string;
    templateId: number;
    interviewerId: number;
    scheduledAt: string;
    panelMemberIds?: number[];
    userId?: number;
}

// Fields the db update path reads off an interview `updates` object.
interface InterviewUpdates {
    templateId?: number;
    interviewerId?: number;
    scheduledAt?: string;
    panelMemberIds?: number[];
}

interface UpdateInterviewPayload extends OrgScopedPayload {
    interviewId: string;
    updates: InterviewUpdates;
    userId: number;
}

interface UpdateInterviewInterviewerPayload extends OrgScopedPayload {
    interviewId: string;
    newInterviewerId: number;
    userId: number;
}

interface DeleteInterviewPayload extends OrgScopedPayload {
    interviewId: string;
    userId: number;
}

// One scored answer to an interview question.
interface InterviewResponseResult {
    questionId: number;
    text: string;
    score: number;
}

// The `results` blob saved when an interview is completed.
interface InterviewResults {
    notes?: string;
    finalScore?: number;
    isRecommended?: boolean;
    responses?: InterviewResponseResult[];
}

interface SaveInterviewPayload extends OrgScopedPayload {
    id: string;
    results: InterviewResults;
    interviewerId?: number;
}

interface ReopenInterviewPayload extends OrgScopedPayload {
    interviewId: string;
    userId: number;
}

interface CreateJobPayload extends OrgScopedPayload {
    title: string;
    department: string;
    description?: string;
    requirements?: string[];
    status?: string;
    userId?: number;
    positionId?: number;
}

interface UpdateJobPayload extends CreateJobPayload {
    id: string;
}

interface UpdateJobStatusPayload extends OrgScopedPayload {
    id: string;
    status: string;
}

interface DeleteJobPayload extends OrgScopedPayload {
    id: string;
}

interface ApplyJobPayload {
    jobId: string;
    userId: number;
    statement: string;
}

interface RequestTransferPayload extends OrgScopedPayload {
    userId: number;
    currentUnitId: number | null;
    targetUnitId: number;
    reason: string;
}

interface ProcessTransferPayload extends OrgScopedPayload {
    id: string;
    status: string;
    notes?: string;
}

interface CreateTemplatePayload extends OrgScopedPayload {
    name: string;
    description?: string;
    questions?: string[];
}

interface UpdateTemplatePayload extends CreateTemplatePayload {
    id: number;
}

interface DeleteTemplatePayload extends OrgScopedPayload {
    id: number;
}

interface GetTemplateDetailsPayload {
    id: number;
}

interface GetMyInterviewsPayload {
    userId: number;
}

interface CreatePositionPayload extends OrgScopedPayload {
    name: string;
    description?: string;
    icon?: string;
}

interface UpdatePositionPayload extends CreatePositionPayload {
    id: number;
}

interface DeletePositionPayload extends OrgScopedPayload {
    id: number;
}

interface AddLogPayload {
    applicationId: string;
    message: string;
    actionType: string;
    userId: number | null;
}

interface GetApplicationLogsPayload {
    applicationId: string;
}

interface ProcessJobApprovalPayload extends OrgScopedPayload {
    applicationId: string;
}

export const hrActions = {
    'hr:get_state': ({ user }: GetHRStatePayload) => db.getHRState(user),
    'hr:create_application': (payload: CreateApplicationPayload) => db.createHRApplication(payload),
    'hr:update_app_status': ({ id, status, notes, userId }: UpdateAppStatusPayload) => db.updateApplicationStatus(id, status, notes, userId),
    'hr:update_application_data': ({ id, data }: UpdateApplicationDataPayload) => db.updateApplicationData(id, data),
    'hr:delete_application': ({ id }: DeleteApplicationPayload) => db.deleteHRApplication(id),
    'hr:assign_recruiter': ({ id, recruiterId, userId }: AssignRecruiterPayload) => db.assignRecruiter(id, recruiterId, userId),
    'hr:create_interview': (payload: CreateInterviewPayload) => db.createHRInterview(payload),
    'hr:update_interview': ({ interviewId, updates, userId }: UpdateInterviewPayload) => db.updateHRInterview(interviewId, updates, userId),
    'hr:update_interview_interviewer': ({ interviewId, newInterviewerId, userId }: UpdateInterviewInterviewerPayload) => db.updateInterviewInterviewer(interviewId, newInterviewerId, userId),
    'hr:delete_interview': ({ interviewId, userId }: DeleteInterviewPayload) => db.deleteHRInterview(interviewId, userId),
    'hr:save_interview': ({ id, results, interviewerId }: SaveInterviewPayload) => db.saveInterviewResults(id, { ...results, interviewerId }),
    'hr:reopen_interview': ({ interviewId, userId }: ReopenInterviewPayload) => db.reopenHRInterview(interviewId, userId),
    'hr:create_job': (payload: CreateJobPayload) => db.createJobPosting(payload),
    'hr:update_job': (payload: UpdateJobPayload) => db.updateJobPosting(payload),
    'hr:update_job_status': (payload: UpdateJobStatusPayload) => db.updateJobPostingStatus(payload),
    'hr:delete_job': ({ id }: DeleteJobPayload) => db.deleteJobPosting(id),
    'hr:apply_job': (payload: ApplyJobPayload) => db.applyForJob(payload),
    'hr:request_transfer': async (payload: RequestTransferPayload) => {
        // Member-initiated self-service write: mirror user:submit_application /
        // user:apply_job — throttle per authenticated user (each row surfaces in every
        // HR manager's transfers view), and bound the free-text reason. Reject an
        // over-long reason outright (no silent truncation), then strip HTML/control
        // chars from the persisted string as defense-in-depth.
        assertSubmissionRateLimit(payload.userId);
        if (payload.reason && payload.reason.length > MAX_TRANSFER_REASON) {
            throw new Error('Reason is too long.');
        }
        await db.supabase.from('hr_transfer_requests').insert({
            user_id: payload.userId,
            current_unit_id: payload.currentUnitId,
            target_unit_id: payload.targetUnitId,
            reason: stripHtml(payload.reason, MAX_TRANSFER_REASON)
        });
    },
    'hr:process_transfer': ({ id, status, notes }: ProcessTransferPayload) => db.processTransferRequest(id, status, notes),
    'hr:create_template': (payload: CreateTemplatePayload) => db.createInterviewTemplate(payload),
    'hr:update_template': (payload: UpdateTemplatePayload) => db.updateInterviewTemplate(payload),
    'hr:delete_template': ({ id }: DeleteTemplatePayload) => db.deleteInterviewTemplate(id),
    'hr:get_template_details': ({ id }: GetTemplateDetailsPayload) => db.getHRInterviewTemplateDetails(id),
    'hr:get_my_interviews': ({ userId }: GetMyInterviewsPayload) => db.getMyInterviews(userId),
    'hr:create_position': (payload: CreatePositionPayload) => db.createPersonnelPosition(payload),
    'hr:update_position': (payload: UpdatePositionPayload) => db.updatePersonnelPosition(payload),
    'hr:delete_position': ({ id }: DeletePositionPayload) => db.deletePersonnelPosition(id),
    'hr:add_log': ({ applicationId, message, actionType, userId }: AddLogPayload) => db.addApplicationLog(applicationId, actionType, message, userId),
    'hr:get_application_logs': ({ applicationId }: GetApplicationLogsPayload) => db.getHRApplicationLogs(applicationId),
    // Lazy-load a single application's vetting data on modal/case-file open
    // (no longer shipped in the bulk getHRApplications list). Recruiter-gated.
    'hr:get_application_data': ({ id }: { id: string }) => db.getApplicationVettingData(id),
    'hr:process_job_approval': ({ applicationId }: ProcessJobApprovalPayload) => db.processJobApproval(applicationId),
};
