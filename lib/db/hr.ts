
import {
    HydratedHRApplication, ApplicationStatus, HRInterviewTemplate,
    JobPosting, HydratedHRInterview, PersonnelPosition,
    formatReferralSource
} from '../../types.js';
import type { Tables } from './rows.js';
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg, getSystemRoles } from './common.js';
import { escapeLikePattern } from '../pgrest.js';
import { toHydratedApplication, toHRInterviewTemplate, toJobPosting, toHydratedInterview, toMiniUser, toTransferRequest, toPersonnelPosition } from './mappers.js';
import { logHrPositionChange } from './users.js';
import { sendPushToUsers } from '../push.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.hr' });

// The non-null embeds row type accepted by toHydratedInterview, augmented with
// the joins these queries add (applicant_name via application, panel members).
type InterviewMapperRow = NonNullable<Parameters<typeof toHydratedInterview>[0]>;
type PanelMember = NonNullable<NonNullable<InterviewMapperRow['panel']>[number]>;
type InterviewQueryRow = InterviewMapperRow & {
    id: string;
    scheduled_at?: string | null;
    application?: { applicant_name?: string | null } | null;
};

// Local payload shapes mirroring the strictly-typed callers in api/actions/hr.ts.
// Defined here (rather than imported) to avoid a circular dependency, since
// api/actions/hr.ts imports this module.
interface CreateHRApplicationPayload {
    rsiHandle: string;
    name?: string;
    referral?: string;
    notes?: string;
    discordId?: string;
    userId?: number;
    assignedRecruiterId?: number | null;
}
interface CreateHRInterviewPayload {
    applicationId: string;
    templateId: number;
    interviewerId: number;
    scheduledAt: string;
    panelMemberIds?: number[];
    userId?: number;
}
interface UpdateHRInterviewPayload {
    templateId?: number;
    interviewerId?: number;
    scheduledAt?: string;
    panelMemberIds?: number[];
}
interface InterviewResponseResult {
    questionId: number;
    text: string;
    score: number;
}
interface SaveInterviewResultsPayload {
    notes?: string;
    finalScore?: number;
    isRecommended?: boolean;
    responses?: InterviewResponseResult[];
    interviewerId?: number;
}
interface JobPostingPayload {
    id?: string;
    title?: string;
    department?: string;
    description?: string;
    requirements?: string[];
    status?: string;
    userId?: number;
    positionId?: number;
}
interface JobStatusPayload {
    id: string;
    status: string;
}
interface InterviewTemplatePayload {
    id?: number;
    name: string;
    description?: string;
    questions?: string[];
}
interface PersonnelPositionPayload {
    id?: number;
    name: string;
    description?: string;
    icon?: string;
}

/** Array names of the 6-key hr bundle, used as broadcast slice
 *  discriminators so clients refetch only the affected array(s) instead of
 *  the whole bundle. Id-only/discriminator-only payloads — the db-changes
 *  channel is anon-readable. */
type HrSlice = 'applicants' | 'interviews' | 'jobs' | 'templates' | 'transfers' | 'positions';

/** Call with the array(s) the mutation touched; with NO args clients fall
 *  back to the full 'hr' refetch. */
function broadcastHRUpdate(...slices: HrSlice[]) {
    broadcastToOrg('hr_update', slices.length > 0 ? { slices } : {});
}

// Helper to notify HR staff
async function notifyHRStaff(title: string, body: string, data: Record<string, unknown>) {
    // Find roles that have HR permissions
    const { data: roles } = await supabase
        .from('role_permissions')
        .select('role_id, permission:permissions!inner(name)')
        .in('permission.name', ['hr:recruiter', 'hr:manager', 'hr:admin']);

    const roleIds = new Set<number>();
    roles?.forEach((r: { role_id: number }) => roleIds.add(r.role_id));

    // Also include the Admin role
    const sysRoles = await getSystemRoles();
    if (sysRoles.admin) roleIds.add(sysRoles.admin.id);

    if (roleIds.size === 0) return;

    // Get users with these roles
    const userQuery = supabase
        .from('users')
        .select('id')
        .in('role_id', Array.from(roleIds))
        .is('deleted_at', null);

    const { data: users } = await userQuery;
    const userIds = users?.map(u => u.id) || [];

    if (userIds.length > 0) {
        await sendPushToUsers(userIds, {
            title,
            body,
            tag: 'hr-alert',
            data
        });
    }
}

// Interviews are fetched separately, not joined here.
export async function getHRApplications(): Promise<HydratedHRApplication[]> {
    let query = supabase.from('hr_applications')
        .select(`
            id, applicant_name, applicant_discord_id, rsi_handle, status, referral_source, notes, assigned_recruiter_id, linked_user_id, created_at, vetting_data,
            assignedRecruiter:users!hr_applications_assigned_recruiter_id_fkey(id, name, avatar_url, role_id, rsi_handle)
        `);

    query = query.order('created_at', { ascending: false }).limit(200);
    const data = await safeFetch<Parameters<typeof toHydratedApplication>[0][]>(
        query as unknown as PromiseLike<{ data: Parameters<typeof toHydratedApplication>[0][] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to get applicants',
    );

    // Map applications without logs/interviews initially.
    // vettingData (background-check verdicts + free-text adjudication — the most
    // sensitive applicant PII) is NOT shipped in the bulk list: the UI lazy-loads
    // it per-applicant via hr:get_application_data on open, keeping ~200 sensitive
    // blobs off every recruiter's HR-state payload and every hr_update refetch.
    const apps = data.map(toHydratedApplication).map((a) => ({ ...a, vettingData: undefined }));
    return apps;
}

// Helper: fetch panel members separately to avoid breaking interview queries
// if the hr_interview_panel migration hasn't been run yet.
// Caches the "table missing" verdict only — transient errors do NOT poison
// the cache (otherwise a single PostgREST schema-reload race or network blip
// silently disables the feature until the next process restart).
let _panelTableMissing: boolean = false;
async function fetchPanelMembers(interviewIds: string[]): Promise<Map<string, PanelMember[]>> {
    const panelMap = new Map<string, PanelMember[]>();
    if (interviewIds.length === 0 || _panelTableMissing) return panelMap;
    try {
        const { data: panelData, error } = await supabase.from('hr_interview_panel')
            .select('interview_id, user:users(id, name, avatar_url, role_id, rsi_handle)')
            .in('interview_id', interviewIds);
        if (error) throw error;
        for (const p of ((panelData || []) as unknown as Array<PanelMember & { interview_id: string }>)) {
            if (!panelMap.has(p.interview_id)) panelMap.set(p.interview_id, []);
            panelMap.get(p.interview_id)!.push(p);
        }
    } catch (e) {
        // Distinguish "table missing" (permanent until migration runs) from
        // transient errors (schema cache reload, pooler hiccup, network blip).
        // Permanent → cache the negative result and skip silently.
        // Transient → log once per call and try again next time.
        const err = e as { code?: string; message?: string; error?: { code?: string; message?: string } } | null;
        const code = err?.code || err?.error?.code || '';
        const msg = String(err?.message || err?.error?.message || e || '');
        const isMissingTable =
            code === '42P01' ||                  // postgres "relation does not exist"
            code === 'PGRST205' ||               // postgrest "could not find the table"
            /relation .* does not exist/i.test(msg) ||
            /Could not find the table/i.test(msg);
        if (isMissingTable) {
            if (!_panelTableMissing) {
                log.warn('panel members table not available — run migrations/add-interview-panel.sql');
            }
            _panelTableMissing = true;
        } else {
            // Transient — log but do not cache the failure. Subsequent calls
            // will retry the query.
            log.warn('panel members fetch failed (transient)', { message: msg });
        }
    }
    return panelMap;
}

// Fetch all interviews as a flat list.
export async function getAllHRInterviews(): Promise<HydratedHRInterview[]> {
    const applicationJoin = 'application:hr_applications!hr_interviews_application_id_fkey(applicant_name)';

    let query = supabase.from('hr_interviews')
        .select(`
            id, application_id, template_id, interviewer_id, scheduled_at, completed_at, overall_notes, final_score, status, is_recommended,
            template:hr_interview_templates!hr_interviews_template_id_fkey(id, name, description),
            interviewer:users!hr_interviews_interviewer_id_fkey(id, name, avatar_url, role_id, rsi_handle),
            responses:hr_interview_responses(question_id, response_body, score),
            ${applicationJoin}
        `);

    query = query.order('scheduled_at', { ascending: true }).limit(100);

    const data = await safeFetch<InterviewQueryRow[]>(
        query as unknown as PromiseLike<{ data: InterviewQueryRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to get interviews',
    );

    // Fetch panel members separately (resilient to missing migration)
    const panelMap = await fetchPanelMembers(data.map(d => d.id));

    return data.map(d => ({
        ...toHydratedInterview({ ...d, panel: panelMap.get(d.id) || [] }),
        applicantName: d.application?.applicant_name || 'Unknown'
    }));
}

export async function getHRApplicationLogs(applicationId: string) {
    const logsQuery = supabase.from('hr_application_logs')
        .select('id, application_id, user_id, action_type, message, created_at, user:users(id, name, avatar_url, role_id, rsi_handle)')
        .eq('application_id', applicationId)
        .order('created_at', { ascending: false });

    type HRApplicationLogRow = Tables<'hr_application_logs'> & { user?: Parameters<typeof toMiniUser>[0] };
    const logsData = await safeFetch<HRApplicationLogRow[]>(
        logsQuery as unknown as PromiseLike<{ data: HRApplicationLogRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to get logs',
    );

    return logsData.map((l) => ({
        id: l.id,
        applicationId: l.application_id,
        userId: l.user_id,
        actionType: l.action_type,
        message: l.message,
        createdAt: l.created_at,
        user: toMiniUser(l.user) || undefined
    }));
}

// Single-application vetting data, lazy-loaded by the vetting modal / case-file view
// on open (the bulk getHRApplications list no longer carries vetting_data). Returns
// the raw vetting JSON or null. Recruiter-gated in the dispatcher (hr:recruiter).
export async function getApplicationVettingData(id: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await supabase.from('hr_applications').select('vetting_data').eq('id', id).maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get application vetting data' });
    return (data?.vetting_data as Record<string, unknown>) ?? null;
}

// Free-text statement / notes on an application. Generous, but bounded so a single
// submission can't park a multi-MB blob (the express.json body limit is far larger).
const MAX_APPLICATION_TEXT = 5000;

export async function createHRApplication(payload: CreateHRApplicationPayload) {
    if (payload.notes && payload.notes.length > MAX_APPLICATION_TEXT) {
        throw new Error('Statement is too long.');
    }
    // 1. Check if RSI Handle belongs to a registered user
    const userQuery = supabase.from('users').select('id, discord_id, name').ilike('rsi_handle', escapeLikePattern(payload.rsiHandle));

    const { data: existingUser } = await userQuery.maybeSingle();

    const linkedUserId = existingUser ? existingUser.id : null;
    const applicantDiscordId = existingUser ? existingUser.discord_id : (payload.discordId || 'Unknown');
    // If registered, use their profile name, otherwise assume payload name
    const applicantName = existingUser ? existingUser.name : payload.name;

    // Use assignedRecruiterId if present (can be null), otherwise fallback to userId (creator)
    const assignedRecruiterId = payload.assignedRecruiterId !== undefined ? payload.assignedRecruiterId : payload.userId;

    const { data, error } = await supabase.from('hr_applications').insert({
        applicant_name: applicantName,
        applicant_discord_id: applicantDiscordId,
        rsi_handle: payload.rsiHandle,
        referral_source: payload.referral,
        notes: payload.notes,
        linked_user_id: linkedUserId,
        assigned_recruiter_id: assignedRecruiterId
    }).select('id, applicant_name, applicant_discord_id, rsi_handle, status, referral_source, notes, assigned_recruiter_id, linked_user_id, created_at, vetting_data').single();

    handleSupabaseError({ error, message: 'Failed to file application' });

    if (data) {
        // Log creation
        await addApplicationLog(data.id, 'STATUS_CHANGE', 'Application received.', payload.userId || null); // payload.userId passed from RPC if available

        // Notify HR Staff
        await notifyHRStaff(
            'New Case File',
            `${formatReferralSource(payload.referral)} filed for ${applicantName}`,
            { url: '/hr', applicationId: data.id }
        );
    }

    broadcastHRUpdate('applicants');
    // Never return the raw inserted row — a future hr_applications column would
    // auto-ship to the creator. Map through the same allow-list shape as the read
    // path, vettingData blanked.
    return data ? { ...toHydratedApplication(data as unknown as Parameters<typeof toHydratedApplication>[0]), vettingData: undefined } : data;
}

export async function updateApplicationStatus(id: string, status: ApplicationStatus, notes?: string, userId?: number) {
    // The `notes` payload here is a log/rationale message (decision rationale,
    // system-override reason, etc.), NOT an update to hr_applications.notes —
    // that column holds the immutable initial statement / report rendered as
    // "Initial Statement / Report" in the case file UI. Writing the rationale
    // here would clobber the original report. The log entry below captures the
    // rationale; the column is left alone.
    const updates: Partial<Tables<'hr_applications'>> = { status, updated_at: new Date().toISOString() };

    const { error } = await supabase.from('hr_applications').update(updates)
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to update application' });

    // Hoisted for the user_update broadcast below — the hired user's id lets
    // clients slice-refetch just their roster row instead of the whole main
    // subset. Stays null when the prospect has no linked tenant user yet.
    let hiredLinkedUserId: number | null = null;

    // Auto-promote Client to Member when a recruitment application is hired
    if (status === ApplicationStatus.Hired) {
        const { data: app } = await supabase.from('hr_applications').select('linked_user_id, referral_source')
            .eq('id', id)

            .single();
        hiredLinkedUserId = app?.linked_user_id ?? null;

        if (app?.linked_user_id) {
            // Auto-promote Client to Member on hire, regardless of referral source.
            // Manually-added prospects come in with referral_source values like
            // 'NEW_USER' or 'REFERRAL' rather than 'WEBSITE_APPLICATION', but a
            // hired Client should always become a Member — otherwise their probation
            // entry is invisible in the dashboard's probation list (which filters
            // out Clients) and they remain unable to act as a member of the org.
            // No-op for users who are already Member-or-higher (job applicants etc).
            const sysRoles = await getSystemRoles();
            if (sysRoles.client && sysRoles.member) {
                const { data: targetUser } = await supabase.from('users').select('role_id').eq('id', app.linked_user_id).single();
                if (targetUser && targetUser.role_id === sysRoles.client.id) {
                    try {
                        const { promoteUserToMember } = await import('./users.js');
                        await promoteUserToMember(app.linked_user_id);
                    } catch (e) {
                        log.warn('hire auto-promote to member failed', { applicationId: id, userId: app.linked_user_id, err: e });
                    }
                }
            }

            // Auto-set probation period if configured
            const { data: hrConfigRow } = await supabase.from('settings').select('value').eq('key', 'hrConfig').maybeSingle();
            const probationDays = hrConfigRow?.value?.probationDays;
            if (probationDays && probationDays > 0) {
                const now = new Date();
                const end = new Date(now);
                end.setDate(end.getDate() + probationDays);
                const { error: probErr } = await supabase.from('users').update({
                    probation_start: now.toISOString(),
                    probation_end: end.toISOString()
                }).eq('id', app.linked_user_id);
                if (probErr) {
                    log.warn('failed to set probation on user', { userId: app.linked_user_id, applicationId: id, message: probErr.message });
                }
            }
        } else {
            // Hired but no linked tenant user — probation can't be auto-applied.
            // Most common when the prospect was added manually before they logged
            // in via Discord. The hire still completes; HR will need to set
            // probation manually once the user record appears.
            const { data: hrConfigRow } = await supabase.from('settings').select('value').eq('key', 'hrConfig').maybeSingle();
            const probationDays = hrConfigRow?.value?.probationDays;
            if (probationDays && probationDays > 0) {
                log.warn('hire approved but linked_user_id is null — probation not applied; candidate must log in via discord first', { applicationId: id, probationDays });
            }
        }
    }

    if (userId) {
        // Combine status + notes into a single log entry when both arrive together
        // (the common path — handleDecision in UnifiedCaseFileView always sends notes
        // alongside a status flip). Logging two separate entries with a generic
        // "Recruiter notes updated." duplicates the timeline and hides the actual
        // decision rationale that the recruiter typed.
        const trimmedNote = typeof notes === 'string' ? notes.trim() : '';
        const noteSnippet = trimmedNote.length > 280 ? `${trimmedNote.slice(0, 277)}...` : trimmedNote;

        if (status && trimmedNote) {
            await addApplicationLog(id, 'STATUS_CHANGE', `Status updated to ${status} — ${noteSnippet}`, userId);
        } else if (status) {
            await addApplicationLog(id, 'STATUS_CHANGE', `Status updated to ${status}`, userId);
        } else if (notes !== undefined && trimmedNote) {
            await addApplicationLog(id, 'NOTE', `Recruiter note: ${noteSnippet}`, userId);
        }
        // If notes is an empty string with no status change, skip the log entirely —
        // there's nothing meaningful to record.
    }
    broadcastHRUpdate('applicants');
    // If a hire occurred, user data changed (role, probation) — broadcast
    // user_update so all clients refresh. Carry the hired user's id when known
    // so clients slice-refetch one roster row; the empty fallback (no linked
    // tenant user yet) keeps the full main refetch.
    if (status === ApplicationStatus.Hired) {
        broadcastToOrg('user_update', hiredLinkedUserId ? { userId: hiredLinkedUserId } : {});
    }
}

export async function updateApplicationData(id: string, data: Record<string, unknown>) {
    const { error } = await supabase.from('hr_applications').update({ vetting_data: data })
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to update application data' });
    broadcastHRUpdate('applicants');
}

export async function deleteHRApplication(id: string) {
    // 1. Fetch application details to identify linked records for cleanup
    const { data: app, error: appError } = await supabase.from('hr_applications').select('linked_user_id, referral_source')
        .eq('id', id)

        .maybeSingle();
    if (appError || !app) throw new Error("Application not found or access denied.");

    if (app && app.linked_user_id) {
        // Cleanup Linked Transfer Requests
        if (app.referral_source === 'INTERNAL_TRANSFER') {
            await supabase.from('hr_transfer_requests')
                .delete()
                .eq('user_id', app.linked_user_id)
                .eq('status', 'Pending');
        }

        // Cleanup Linked Job Applications
        if (app.referral_source && (
            app.referral_source === 'INTERNAL_JOB' ||
            app.referral_source.startsWith('Internal Application:') ||
            app.referral_source.startsWith('Job:')
        )) {
            await supabase.from('hr_job_applications')
                .delete()
                .eq('applicant_id', app.linked_user_id)
                .eq('status', 'Pending');
        }
    }

    // 2. Delete the application itself
    const { error } = await supabase.from('hr_applications').delete()
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to delete application' });
    // Cascade cleanup also touches hr_transfer_requests (the transfers
    // slice). hr_job_applications rows are cleaned too, but those are NOT
    // the jobs slice (that's hr_job_postings, untouched here).
    broadcastHRUpdate('applicants', 'transfers');
}

export async function assignRecruiter(id: string, recruiterId: number, userId: number) {
    const { error } = await supabase.from('hr_applications').update({ assigned_recruiter_id: recruiterId })
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to assign recruiter' });

    const { data: recruiter } = await supabase.from('users').select('name').eq('id', recruiterId).single();
    await addApplicationLog(id, 'ASSIGNMENT', `Assigned to ${recruiter?.name || 'recruiter'}`, userId);

    sendPushToUsers([recruiterId], {
        title: 'Case Assignment',
        body: `You have been assigned to Case File ${id.split('-')[0].toUpperCase()}.`,
        tag: 'hr-assignment',
        data: { url: '/hr', applicationId: id }
    });
    broadcastHRUpdate('applicants');
}

export async function addApplicationLog(applicationId: string, actionType: string, message: string, userId: number | null) {
    if (!userId) return;
    await supabase.from('hr_application_logs').insert({
        application_id: applicationId,
        user_id: userId,
        action_type: actionType,
        message: message
    });
}

// Questions are loaded on demand (getHRInterviewTemplateDetails), not here.
export async function getHRInterviewTemplates(): Promise<HRInterviewTemplate[]> {
    const query = supabase.from('hr_interview_templates').select('id, name, description');

    const { data, error } = await query;
    if (error) {
        if (error.code === '42P01') return [];
        handleSupabaseError({ error, message: 'Failed to get templates' });
    }
    return (data || []).map(t => toHRInterviewTemplate({ ...t, questions: [] }));
}

export async function getHRInterviewTemplateDetails(id: number): Promise<HRInterviewTemplate> {
    const { data, error } = await supabase.from('hr_interview_templates')
        .select('id, name, description, questions:hr_interview_questions(id, template_id, question_text, order_index)')
        .eq('id', id)
        .single();
    if (error) handleSupabaseError({ error, message: 'Failed to get template details' });
    return toHRInterviewTemplate(data as unknown as Parameters<typeof toHRInterviewTemplate>[0]);
}

export async function createHRInterview(payload: CreateHRInterviewPayload) {
    // Verify the application exists before scheduling against it.
    const { count } = await supabase.from('hr_applications').select('id', { count: 'exact', head: true }).eq('id', payload.applicationId);
    if (!count) throw new Error("Application not found or access denied.");

    const { data, error } = await supabase.from('hr_interviews').insert({ application_id: payload.applicationId, template_id: payload.templateId, interviewer_id: payload.interviewerId, scheduled_at: payload.scheduledAt }).select('id, application_id, template_id, interviewer_id, scheduled_at, completed_at, overall_notes, final_score, status, is_recommended').single();
    handleSupabaseError({ error, message: 'Failed to create interview' });

    // Insert panel members if provided
    const panelMemberIds: number[] = payload.panelMemberIds || [];
    if (panelMemberIds.length > 0 && data) {
        await supabase.from('hr_interview_panel').insert(
            panelMemberIds.map(uid => ({ interview_id: data.id, user_id: uid }))
        );
    }

    if (payload.userId) {
        await addApplicationLog(payload.applicationId, 'INTERVIEW', 'Interview scheduled.', payload.userId);
    }

    // Notify lead interviewer and panel members
    const notifyIds = [payload.interviewerId, ...panelMemberIds].filter(Boolean);
    if (notifyIds.length > 0) {
        sendPushToUsers(notifyIds, {
            title: 'Interview Scheduled',
            body: `You have a new interview scheduled for ${new Date(payload.scheduledAt).toLocaleString()}.`,
            tag: 'interview',
            data: { url: '/hr', interviewId: data?.id }
        });
    }

    broadcastHRUpdate('interviews');
    // Allow-list mapped, never the raw row.
    return data ? toHydratedInterview(data) : data;
}

export async function updateHRInterview(interviewId: string, payload: UpdateHRInterviewPayload, userId: number) {
    const { data: interview } = await supabase.from('hr_interviews').select('application_id, interviewer_id').eq('id', interviewId).single();
    if (!interview) throw new Error("Interview not found.");

    const updates: Partial<Tables<'hr_interviews'>> = {};
    if (payload.templateId !== undefined) updates.template_id = payload.templateId;
    if (payload.interviewerId !== undefined) updates.interviewer_id = payload.interviewerId;
    if (payload.scheduledAt !== undefined) updates.scheduled_at = payload.scheduledAt;

    const { error } = await supabase.from('hr_interviews').update(updates).eq('id', interviewId);
    handleSupabaseError({ error, message: 'Failed to update interview' });

    // Update panel members if provided
    if (payload.panelMemberIds !== undefined) {
        // Replace all panel members: delete existing, insert new
        await supabase.from('hr_interview_panel').delete().eq('interview_id', interviewId);
        const panelMemberIds: number[] = payload.panelMemberIds || [];
        if (panelMemberIds.length > 0) {
            await supabase.from('hr_interview_panel').insert(
                panelMemberIds.map(uid => ({ interview_id: interviewId, user_id: uid }))
            );
        }
    }

    // Log the update
    const changes: string[] = [];
    if (payload.scheduledAt) changes.push('rescheduled');
    if (payload.interviewerId && payload.interviewerId !== interview.interviewer_id) changes.push('lead interviewer reassigned');
    if (payload.templateId) changes.push('protocol changed');
    if (payload.panelMemberIds !== undefined) changes.push('panel updated');

    if (changes.length > 0 && userId) {
        await addApplicationLog(interview.application_id, 'INTERVIEW', `Interview updated: ${changes.join(', ')}.`, userId);
    }

    // Notify new lead interviewer if changed
    if (payload.interviewerId && payload.interviewerId !== interview.interviewer_id) {
        sendPushToUsers([payload.interviewerId], {
            title: 'Interview Assigned',
            body: `An interview has been ${payload.scheduledAt ? 'rescheduled and ' : ''}assigned to you.`,
            tag: 'interview',
            data: { url: '/hr', interviewId }
        });
    }

    broadcastHRUpdate('interviews');
}

export async function updateInterviewInterviewer(interviewId: string, newInterviewerId: number, userId: number) {
    const { data: interview } = await supabase.from('hr_interviews').select('application_id').eq('id', interviewId).single();
    const { error } = await supabase.from('hr_interviews').update({ interviewer_id: newInterviewerId }).eq('id', interviewId);
    handleSupabaseError({ error, message: 'Failed to reassign interview' });

    if (interview && userId) {
        const { data: user } = await supabase.from('users').select('name').eq('id', newInterviewerId).single();
        await addApplicationLog(interview.application_id, 'INTERVIEW', `Interview reassigned to ${user?.name}`, userId);

        sendPushToUsers([newInterviewerId], {
            title: 'Interview Assigned',
            body: `An interview has been reassigned to you.`,
            tag: 'interview',
            data: { url: '/hr', interviewId: interviewId }
        });
    }
}

export async function deleteHRInterview(interviewId: string, userId: number) {
    const { data: interview } = await supabase.from('hr_interviews').select('application_id').eq('id', interviewId).single();
    const { error } = await supabase.from('hr_interviews').delete().eq('id', interviewId);
    handleSupabaseError({ error, message: 'Failed to delete interview' });

    if (interview && userId) {
        await addApplicationLog(interview.application_id, 'INTERVIEW', `Interview cancelled/deleted.`, userId);
    }
    broadcastHRUpdate('interviews');
}

export async function saveInterviewResults(id: string, payload: SaveInterviewResultsPayload) {
    const { data: interview } = await supabase.from('hr_interviews').select('application_id').eq('id', id).single();

    await supabase.from('hr_interviews').update({
        completed_at: new Date().toISOString(),
        overall_notes: payload.notes,
        final_score: payload.finalScore,
        status: 'Completed',
        is_recommended: payload.isRecommended
    }).eq('id', id);

    await supabase.from('hr_interview_responses').delete().eq('interview_id', id);
    if (payload.responses) await supabase.from('hr_interview_responses').insert(payload.responses.map((r) => ({ interview_id: id, question_id: r.questionId, response_body: r.text, score: r.score })));

    if (interview && payload.interviewerId) {
        await addApplicationLog(interview.application_id, 'INTERVIEW', `Interview completed. Score: ${payload.finalScore}. Recommended: ${payload.isRecommended ? 'Yes' : 'No'}`, payload.interviewerId);
    }
    // NOTE: this broadcast is the ONLY propagation for hr_interview_responses
    // changes (the table is not in the postgres_changes list).
    broadcastHRUpdate('interviews');
}

export async function reopenHRInterview(interviewId: string, userId: number) {
    const { data: interview } = await supabase.from('hr_interviews').select('application_id').eq('id', interviewId).single();

    const { error } = await supabase.from('hr_interviews').update({
        status: 'Scheduled',
        completed_at: null
    }).eq('id', interviewId);
    handleSupabaseError({ error, message: 'Failed to reopen interview' });

    if (interview && userId) {
        await addApplicationLog(interview.application_id, 'INTERVIEW', `Interview reopened for editing.`, userId);
    }
    broadcastHRUpdate('interviews');
}

export async function getMyInterviews(userId: number): Promise<HydratedHRInterview[]> {
    // Fetch interviews where user is either lead interviewer or a panel member
    const selectFields = `
        id, application_id, template_id, interviewer_id, scheduled_at, completed_at, overall_notes, final_score, status, is_recommended,
        template:hr_interview_templates!hr_interviews_template_id_fkey(id, name, description),
        interviewer:users!hr_interviews_interviewer_id_fkey(id, name, avatar_url, role_id, rsi_handle),
        responses:hr_interview_responses(question_id, response_body, score),
        application:hr_applications!hr_interviews_application_id_fkey(applicant_name)
    `;

    // Query 1: Lead interviewer
    const leadQuery = supabase.from('hr_interviews')
        .select(selectFields)
        .eq('interviewer_id', userId)
        .order('scheduled_at', { ascending: true });

    // Query 2: Panel member (find interview IDs first, then fetch full data)
    // Wrapped in try/catch in case hr_interview_panel table doesn't exist yet
    let panelInterviewIds: string[] = [];
    try {
        const { data: panelRows, error } = await supabase.from('hr_interview_panel')
            .select('interview_id')
            .eq('user_id', userId);
        if (!error) panelInterviewIds = (panelRows || []).map(r => r.interview_id);
    } catch {
        // Table may not exist — gracefully skip panel member lookup
    }

    const leadData = await safeFetch<InterviewQueryRow[]>(
        leadQuery as unknown as PromiseLike<{ data: InterviewQueryRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to get my interviews',
    );

    let panelInterviewData: InterviewQueryRow[] = [];
    if (panelInterviewIds.length > 0) {
        const panelQuery = supabase.from('hr_interviews')
            .select(selectFields)
            .in('id', panelInterviewIds)
            .order('scheduled_at', { ascending: true });
        panelInterviewData = await safeFetch<InterviewQueryRow[]>(
            panelQuery as unknown as PromiseLike<{ data: InterviewQueryRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
            [],
            'Failed to get panel interviews',
        );
    }

    // Merge and deduplicate (user could be both lead and panel member)
    const seen = new Set<string>();
    const merged: InterviewQueryRow[] = [];
    for (const d of [...leadData, ...panelInterviewData]) {
        if (!seen.has(d.id)) {
            seen.add(d.id);
            merged.push(d);
        }
    }

    // Sort by scheduled_at
    merged.sort((a, b) => new Date(a.scheduled_at || 0).getTime() - new Date(b.scheduled_at || 0).getTime());

    // Fetch panel members separately (resilient to missing migration)
    const panelMap = await fetchPanelMembers(merged.map(d => d.id));

    return merged.map(d => ({
        ...toHydratedInterview({ ...d, panel: panelMap.get(d.id) || [] }),
        applicantName: d.application?.applicant_name || 'Unknown'
    }));
}

export async function getJobPostings(): Promise<JobPosting[]> {
    const query = supabase.from('hr_job_postings').select('id, title, department, description, requirements, status, created_at, position_id, position:personnel_positions(id, name, description, icon, department)').order('created_at', { ascending: false });

    return safeFetch<JobPosting[]>(
        query as unknown as PromiseLike<{ data: JobPosting[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to fetch job gazette',
    ).then(data => data.map(d => toJobPosting(d as unknown as Parameters<typeof toJobPosting>[0])));
}

export async function createJobPosting(payload: JobPostingPayload) {
    const { data, error } = await supabase.from('hr_job_postings').insert({
        title: payload.title,
        department: payload.department,
        description: payload.description,
        requirements: payload.requirements,
        status: payload.status || 'Open',
        created_by_id: payload.userId,
        position_id: payload.positionId
    }).select('id, title, department, description, requirements, status, created_at, position_id, position:personnel_positions(id, name, description, icon, department)').single();
    handleSupabaseError({ error, message: 'Failed to create job posting' });
    return toJobPosting(data as unknown as Parameters<typeof toJobPosting>[0]);
}

export async function updateJobPosting(payload: JobPostingPayload) {
    const { error } = await supabase.from('hr_job_postings').update({ title: payload.title, department: payload.department, description: payload.description, requirements: payload.requirements, status: payload.status, position_id: payload.positionId })
        .eq('id', payload.id)
        ;
    handleSupabaseError({ error, message: 'Failed to update job posting' });
}

export async function updateJobPostingStatus(payload: JobStatusPayload) {
    const { error } = await supabase.from('hr_job_postings').update({ status: payload.status })
        .eq('id', payload.id)
        ;
    handleSupabaseError({ error, message: 'Failed to update job status' });
}

export async function deleteJobPosting(id: string) {
    const { error } = await supabase.from('hr_job_postings').delete()
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to delete job posting' });
}

export async function applyForJob(payload: { jobId: string, userId: number, statement: string }) {
    if (payload.statement && payload.statement.length > MAX_APPLICATION_TEXT) {
        throw new Error('Statement is too long.');
    }
    // 1. Get Job Details first
    const { data: job, error: jobError } = await supabase.from('hr_job_postings').select('title, position_id').eq('id', payload.jobId).single();
    if (jobError || !job) throw new Error("Job not found");

    // 2. Get User Details
    const { data: user, error: userError } = await supabase.from('users').select('id, name, discord_id, rsi_handle').eq('id', payload.userId).single();
    if (userError || !user) throw new Error("User not found or access denied");

    // 3. Create Job Application Record. UNIQUE(applicant_id, job_id) stops a member
    // re-applying to the same posting (each apply also files an ATS row + pushes HR).
    const { error: jobAppError } = await supabase.from('hr_job_applications').insert({
        job_id: payload.jobId,
        applicant_id: payload.userId,
        statement: payload.statement,
    });
    if (jobAppError) {
        if ((jobAppError as { code?: string }).code === '23505') throw new Error('You have already applied to this job.');
        handleSupabaseError({ error: jobAppError, message: 'Failed to submit job application' });
    }

    // 4. Create HR Application (ATS Entry) to ensure it appears in the ATS Console
    // We link it to the registered user and note the job in the source.
    const { data: app, error: hrAppError } = await supabase.from('hr_applications').insert({
        applicant_name: user.name,
        applicant_discord_id: user.discord_id,
        rsi_handle: user.rsi_handle,
        status: 'Applied',
        referral_source: `Internal Application: ${job.title}`,
        notes: payload.statement,
        linked_user_id: user.id
    }).select('id').single();

    if (hrAppError) handleSupabaseError({ error: hrAppError, message: 'Failed to create ATS record' });

    // Notify HR
    await notifyHRStaff(
        'Job Application',
        `${user.name} applied for ${job.title}.`,
        { url: '/hr', applicationId: app?.id }
    );

    // New ATS entry; the jobs array itself is unchanged.
    broadcastHRUpdate('applicants');
}

export async function processJobApproval(applicationId: string) {
    // 1. Fetch the HR application to get linked_user_id
    const { data: app, error: appError } = await supabase.from('hr_applications').select('linked_user_id')
        .eq('id', applicationId)

        .single();
    if (appError || !app || !app.linked_user_id) throw new Error('Application not found or no linked user.');

    // 2. Find the job application record to get the job_id
    const { data: jobApp, error: jobAppError } = await supabase.from('hr_job_applications')
        .select('job_id')
        .eq('applicant_id', app.linked_user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    if (jobAppError || !jobApp) throw new Error('No linked job application found.');

    // 3. Look up the job posting to get position_id
    const { data: job, error: jobError } = await supabase.from('hr_job_postings')
        .select('position_id')
        .eq('id', jobApp.job_id)
        .single();
    if (jobError || !job || !job.position_id) throw new Error('Job posting not found or has no linked position.');

    // 4. Read the prior position so we can log the change to history, then
    //    update (scoped to caller's org). Read+update is two round trips,
    //    but this path runs at most once per hire — not the hot path.
    const { data: prior } = await supabase.from('users')
        .select('position_id')
        .eq('id', app.linked_user_id)

        .maybeSingle();
    const oldPositionId: number | null = (prior?.position_id as number | null) ?? null;

    const { error: userError } = await supabase.from('users')
        .update({ position_id: job.position_id })
        .eq('id', app.linked_user_id)
        ;
    handleSupabaseError({ error: userError, message: 'Failed to update user position' });

    // 5. Log the position change so the service-record timeline picks it up.
    await logHrPositionChange(app.linked_user_id, oldPositionId, job.position_id);

    // 6. Broadcast update
    broadcastToOrg('user_update', { userId: app.linked_user_id });
}

export async function processTransferRequest(id: string, status: string, notes?: string) {
    // 1. Update the request status and timestamp
    const { error } = await supabase.from('hr_transfer_requests').update({ status, admin_notes: notes, updated_at: new Date().toISOString() })
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to update transfer status' });

    // 2. If approved, move the user. IMPORTANT: Only update unit_id, not position_id here.
    if (status === 'Approved') {
        const { data: request } = await supabase.from('hr_transfer_requests')
            .select('user_id, target_unit_id')
            .eq('id', id)

            .single();

        if (request) {
            const { error: userError } = await supabase.from('users')
                .update({
                    unit_id: request.target_unit_id
                })
                .eq('id', request.user_id)
                ;
            handleSupabaseError({ error: userError, message: 'Failed to update user unit assignment' });

            // Notify User
            sendPushToUsers([request.user_id], {
                title: 'Transfer Approved',
                body: `Your transfer request has been approved.`,
                tag: 'transfer-update'
            });
        }
    }
}

export async function createInterviewTemplate(payload: InterviewTemplatePayload) {
    const { data: template, error } = await supabase.from('hr_interview_templates').insert({ name: payload.name, description: payload.description}).select('id, name, description').single();
    handleSupabaseError({ error, message: 'Failed to create template' });
    if (!template) throw new Error('Failed to create template');
    if (payload.questions && payload.questions.length > 0) {
        await supabase.from('hr_interview_questions').insert(payload.questions.map((q: string, i: number) => ({ template_id: template.id, question_text: q, order_index: i + 1 })));
    }
    // hr_interview_templates is not in the postgres_changes list — this
    // broadcast is the ONLY propagation path for template changes (they
    // previously didn't propagate at all until a full reload).
    broadcastHRUpdate('templates');
    return toHRInterviewTemplate({ ...template, questions: payload.questions!.map((q: string, i: number) => ({ id: i, template_id: template.id, question_text: q, order_index: i + 1 })) } as unknown as Parameters<typeof toHRInterviewTemplate>[0]);
}

export async function updateInterviewTemplate(payload: InterviewTemplatePayload) {
    // Verify the template exists before touching child questions.
    const { count } = await supabase.from('hr_interview_templates').select('id', { count: 'exact', head: true })
        .eq('id', payload.id)
        ;
    if (!count) throw new Error('Template not found');

    const { error } = await supabase.from('hr_interview_templates').update({ name: payload.name, description: payload.description })
        .eq('id', payload.id)
        ;
    handleSupabaseError({ error, message: 'Failed to update template' });
    await supabase.from('hr_interview_questions').delete().eq('template_id', payload.id);
    if (payload.questions && payload.questions.length > 0) {
        await supabase.from('hr_interview_questions').insert(payload.questions.map((q: string, i: number) => ({ template_id: payload.id, question_text: q, order_index: i + 1 })));
    }
    broadcastHRUpdate('templates');
}

export async function deleteInterviewTemplate(id: number) {
    await supabase.from('hr_interview_templates').delete()
        .eq('id', id)
        ;
    broadcastHRUpdate('templates');
}

// --- POSITION MANAGEMENT ---

export async function getPersonnelPositions(): Promise<PersonnelPosition[]> {
    const query = supabase.from('personnel_positions').select('id, name, description, icon, department, created_at').order('name');

    const { data, error } = await query;
    if (error) {
        // Safe check for table existence issues during upgrade
        if (error.code === '42P01') return [];
        handleSupabaseError({ error, message: 'Failed to get positions' });
    }
    return (data || []).map(toPersonnelPosition);
}

export async function createPersonnelPosition(payload: PersonnelPositionPayload) {
    const { data, error } = await supabase.from('personnel_positions').insert({
        name: payload.name,
        description: payload.description,
        icon: payload.icon
    }).select('id, name, description, icon, department, created_at').single();
    handleSupabaseError({ error, message: 'Failed to create position' });
    return toPersonnelPosition(data);
}

export async function updatePersonnelPosition(payload: PersonnelPositionPayload) {
    const { error } = await supabase.from('personnel_positions').update({
        name: payload.name,
        description: payload.description,
        icon: payload.icon
    }).eq('id', payload.id);
    handleSupabaseError({ error, message: 'Failed to update position' });
}

export async function deletePersonnelPosition(id: number) {
    const { error } = await supabase.from('personnel_positions').delete()
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to delete position' });
}

// --- HR viewer redaction ----------------------------------
// The full ATS (recruiter notes, vetting data, interview scores/notes/
// responses, applicant Discord IDs, transfer admin notes) is recruiter-grade.
// The seeded Member role holds the base `hr:view` perm; it must NOT receive
// case-file internals. Redact unless the caller is Admin or holds hr:recruiter.
// Job board (jobs/positions/templates) + basic application status stay visible
// at hr:view.
//
// Exported as standalone helpers so getHRState AND the per-array realtime slice
// subsets (hr_applicants / hr_interviews / hr_transfers in api/query.ts) share
// ONE redaction source of truth — a slice endpoint that skipped these would
// re-leak the redacted fields.

export function isHrRecruiter(requester?: { role?: string; permissions?: string[] } | null): boolean {
    return requester?.role === 'Admin'
        || (Array.isArray(requester?.permissions) && requester!.permissions!.includes('hr:recruiter'));
}

// Empty-but-shape-correct stand-ins for the identity relations that the
// interview joins carry (interviewer / panel). Non-recruiters get a typeless
// placeholder so the array shape survives JSON without leaking real members.
const REDACTED_USER = {} as HydratedHRInterview['interviewer'];

const redactInterview = (i: HydratedHRInterview): HydratedHRInterview => ({
    ...i,
    // Interview internals (scores, notes, responses) are recruiter-grade.
    overallNotes: undefined,
    finalScore: undefined,
    isRecommended: undefined,
    responses: [],
    // …and so is everything that identifies WHO the interview is about or who is
    // running it. getAllHRInterviews joins the real applicant_name onto every row
    // and the interviewer/panel/schedule reveal the applicant's pipeline; a
    // non-recruiter hr:view member must see none of it (matches how
    // redactApplicantsForViewer blanks applicant identity).
    applicantName: '',
    interviewerId: 0,
    interviewer: REDACTED_USER,
    panelMembers: [],
    scheduledAt: '',
});

export function redactApplicantsForViewer(applicants: HydratedHRApplication[], recruiter: boolean): HydratedHRApplication[] {
    if (recruiter) return applicants;
    return applicants.map((a) => ({
        ...a,
        // Applicant identity (real name, RSI handle, Discord id) is recruiter-
        // grade — and applicants may be external recruits not in the roster, so
        // this is the only place that PII would surface. Blank it all for
        // non-recruiters; createdAt/counts remain.
        applicantName: '',
        rsiHandle: '',
        applicantDiscordId: '',
        referralSource: undefined,
        notes: undefined,
        vettingData: undefined,
        // Null the cross-reference keys (linkedUserId/assignedRecruiterId/
        // assignedRecruiter) and coarsen status so a non-recruiter can't
        // cross-reference linkedUserId against the roster to learn "user #42 has a
        // REJECTED application" — a blanked row must carry no usable signal about a
        // known roster member.
        linkedUserId: undefined,
        assignedRecruiterId: undefined,
        assignedRecruiter: undefined,
        status: undefined as unknown as ApplicationStatus,
        interviews: (a.interviews || []).map(redactInterview),
    }));
}

export function redactInterviewsForViewer(interviews: HydratedHRInterview[], recruiter: boolean): HydratedHRInterview[] {
    return recruiter ? interviews : interviews.map(redactInterview);
}

export function redactTransfersForViewer<T extends { reason?: string; adminNotes?: string }>(transfers: T[], recruiter: boolean): T[] {
    return recruiter ? transfers : transfers.map((t) => ({ ...t, reason: '', adminNotes: undefined }));
}

/** Transfers array producer — shared by getHRState and the hr_transfers
 *  realtime slice subset. */
export async function getTransferRequests() {
    const transferQuery = supabase.from('hr_transfer_requests').select('id, user_id, current_unit_id, target_unit_id, reason, status, admin_notes, created_at, updated_at, user:users!hr_transfer_requests_user_id_fkey(id, name, avatar_url, role_id, rsi_handle), targetUnit:units!hr_transfer_requests_target_unit_id_fkey(id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted)').order('created_at', { ascending: false }).limit(100);
    type TransferRow = Parameters<typeof toTransferRequest>[0];
    const transfers = await safeFetch<TransferRow[]>(
        transferQuery as unknown as PromiseLike<{ data: TransferRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Transfer fetch fail',
    );
    return transfers.map(toTransferRequest);
}

export async function getHRState(requester?: { role?: string; permissions?: string[] } | null) {
    const [applicants, interviews, templates, jobs, safeTransfers, positions] = await Promise.all([
        getHRApplications(),
        getAllHRInterviews(),
        getHRInterviewTemplates(),
        getJobPostings(),
        getTransferRequests(),
        getPersonnelPositions()
    ]);

    const recruiter = isHrRecruiter(requester);
    return {
        hr: {
            applicants: redactApplicantsForViewer(applicants, recruiter),
            interviews: redactInterviewsForViewer(interviews, recruiter),
            templates,
            jobs,
            transfers: redactTransfersForViewer(safeTransfers, recruiter),
            positions,
        },
    };
}