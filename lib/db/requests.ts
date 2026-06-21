

import { ServiceRequest, ServiceRequestStatus, UrgencyLevel, HydratedServiceRequest } from '../../types.js';
import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { escapeLikePattern } from '../pgrest.js';
import { toServiceRequest } from './mappers.js';
import { adminAdjustUserReputation } from './users.js';
import { sendPushToStaff, sendPushToUsers } from '../push.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';

// Completion report passed to completeRequest. Mirrors the RPC payload shape in
// api/actions/requests.ts (lib/db cannot import from the action layer — wrong
// dependency direction), and is a superset of updateRequestStatus's report arg.
interface RequestReport {
    notes?: string;
    uecEarned?: number;
    medigelConsumed?: number;
    clientReputationChange?: number;
    outcome?: string;
}

function broadcastRequestUpdate(requestId: string) {
    broadcastToOrg('request_update', { requestId });
}

// Notify clients that a user was added to or removed from a request's responder
// list. Replaces a postgres_changes INSERT listener that went silent when
// `request_responders` was dropped from the supabase_realtime publication
// (see migrations/add-user-presence.sql). Without this, no in-app toast/sound
// fires when someone is assigned or unassigned — only push notifications.
function broadcastResponderChange(requestId: string, userId: number, action: 'assigned' | 'unassigned') {
    broadcastToOrg('responder_change', { requestId, userId, action });
}

const generateRequestId = () => `SR-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

export async function createServiceRequest(req: Partial<ServiceRequest>, userId: number): Promise<HydratedServiceRequest> {
    // Check for existing active requests
    const { count } = await supabase.from('service_requests')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', userId)
        .in('status', [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged, ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress]);

    if (count && count > 0) {
        throw new Error('Action Blocked: You already have an active service request in progress.');
    }

    const id = generateRequestId();
    const safeLocation = stripHtmlSingleLine(req.location, 200);
    const safeDescription = stripHtml(req.description, 4000);
    const { data, error } = await supabase.from('service_requests').insert({
        id,
        client_id: userId,
        service_type: req.serviceType,
        location: safeLocation,
        description: safeDescription,
        urgency: req.urgency,
        threat_level: req.threatLevel,
        party_info: req.partyInfo,
        secondary_client_handles: req.secondaryClientHandles,
        status: ServiceRequestStatus.Submitted
    }).select().single();

    if (!error) {
        await supabase.from('status_history').insert({
            request_id: id, status: ServiceRequestStatus.Submitted, updated_by: userId, note: 'Request created'
        });

        // Notify Staff
        const urgencyIcon = req.urgency === UrgencyLevel.Critical ? '🔴' : req.urgency === UrgencyLevel.High ? '🟠' : '🔵';
        sendPushToStaff({
            title: `${urgencyIcon} New Request: ${req.serviceType}`,
            body: `${safeLocation} - ${safeDescription.substring(0, 50)}...`,
            tag: 'new-request',
            data: { url: '/requests', requestId: id }
        });
    }

    handleSupabaseError({ error, message: 'Failed to create request' });
    return toServiceRequest(data);
}

export async function createAdHocServiceRequest(req: Partial<ServiceRequest>, userId: number): Promise<HydratedServiceRequest> {
    const id = generateRequestId();

    const userQuery = supabase.from('users')
        .select('id')
        .ilike('rsi_handle', escapeLikePattern(req.unregisteredClientRsiHandle || ''));

    const { data: existingUser } = await userQuery.maybeSingle();

    const { data, error } = await supabase.from('service_requests').insert({
        id,
        client_id: existingUser?.id,
        unregistered_client_rsi_handle: stripHtmlSingleLine(req.unregisteredClientRsiHandle, 100),
        service_type: req.serviceType,
        location: stripHtmlSingleLine(req.location, 200),
        description: stripHtml(req.description, 4000),
        urgency: req.urgency,
        threat_level: req.threatLevel,
        party_info: req.partyInfo,
        secondary_client_handles: req.secondaryClientHandles,
        status: ServiceRequestStatus.Submitted
    }).select().single();

    if (!error) {
        await supabase.from('status_history').insert({
            request_id: id, status: ServiceRequestStatus.Submitted, updated_by: userId, note: 'Ad-hoc request logged'
        });

        // Notify Staff
        sendPushToStaff({
            title: `📝 Ad-Hoc Request Logged`,
            body: `${req.serviceType} at ${req.location} for ${req.unregisteredClientRsiHandle}`,
            tag: 'new-request',
            data: { url: '/requests', requestId: id }
        });
    }
    handleSupabaseError({ error, message: 'Failed to create ad-hoc request' });
    return toServiceRequest(data);
}

export async function addRequestPartyMember(requestId: string, handle: string) {

    const { data } = await supabase.from('service_requests').select('secondary_client_handles')
        .eq('id', requestId)
        
        .maybeSingle();
    if (!data) throw new Error('Request not found in this organization');
    const currentHandles: string[] = data.secondary_client_handles || [];
    if (!currentHandles.some(h => h.toLowerCase() === handle.toLowerCase())) {
        const newHandles = [...currentHandles, handle];
        const { error } = await supabase.from('service_requests').update({ secondary_client_handles: newHandles })
            .eq('id', requestId)
            ;
        handleSupabaseError({ error, message: 'Failed to add party member' });
        await broadcastRequestUpdate(requestId);
    }
}

export async function removeRequestPartyMember(requestId: string, handle: string) {

    const { data } = await supabase.from('service_requests').select('secondary_client_handles')
        .eq('id', requestId)
        
        .maybeSingle();
    if (!data) throw new Error('Request not found in this organization');
    const currentHandles: string[] = data.secondary_client_handles || [];
    const newHandles = currentHandles.filter(h => h.toLowerCase() !== handle.toLowerCase());

    const { error } = await supabase.from('service_requests').update({ secondary_client_handles: newHandles })
        .eq('id', requestId)
        ;
    handleSupabaseError({ error, message: 'Failed to remove party member' });
    await broadcastRequestUpdate(requestId);
}

export async function updateRequestStatus(requestId: string, status: string, userId: number, notes?: string, report?: { uecEarned?: number; medigelConsumed?: number }, updates?: Record<string, unknown>) {

    // Allowlist instead of spreading an arbitrary client blob (mass-assignment guard).
    // The only field any caller passes through `updates` is `urgency` (request:triage).
    const updateData: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (updates && typeof updates.urgency !== 'undefined') updateData.urgency = updates.urgency;
    if (report) {
        if (report.uecEarned !== undefined) updateData.uec_earned = report.uecEarned;
        if (report.medigelConsumed !== undefined) updateData.medigel_consumed = report.medigelConsumed;
    }

    // CRITICAL: Enforce Tenant Isolation (Service Role Bypass Prevention)
    const { error } = await supabase.from('service_requests').update(updateData)
        .eq('id', requestId)
        ;

    if (!error) {
        await supabase.from('status_history').insert({ request_id: requestId, status, updated_by: userId, note: notes });

        // Notify Client if applicable
        const { data: req } = await supabase.from('service_requests').select('client_id, service_type').eq('id', requestId).single();
        if (req && req.client_id) {
            const clientTitle = status === ServiceRequestStatus.Accepted ? 'Request Accepted' :
                status === ServiceRequestStatus.InProgress ? 'Mission Active' :
                    status === ServiceRequestStatus.Success ? 'Mission Complete' :
                        `Request Update: ${status}`;

            const clientBody = status === ServiceRequestStatus.Accepted ? `A unit has been assigned to your ${req.service_type} request.` :
                status === ServiceRequestStatus.InProgress ? `Team is on-site/en-route for your ${req.service_type} request.` :
                    `Status changed to ${status}.`;

            if ([ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress, ServiceRequestStatus.Success, ServiceRequestStatus.Cancelled, ServiceRequestStatus.Refused].includes(status as ServiceRequestStatus)) {
                sendPushToUsers([req.client_id], {
                    title: clientTitle,
                    body: clientBody,
                    tag: 'request-update',
                    data: { url: '/', requestId: requestId }
                });
            }
        }
        await broadcastRequestUpdate(requestId);
    }
    handleSupabaseError({ error, message: 'Failed to update request status' });
}

export async function acceptRequest(requestId: string, memberId: number, userId: number) {

    // Verify Org ownership first since insert on child table doesn't check parent org automatically without JOIN RLS or explicit check
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    const { error } = await supabase.from('request_responders').insert({ request_id: requestId, user_id: memberId });
    if (!error) {
        await updateRequestStatus(requestId, ServiceRequestStatus.Accepted, userId, 'Request accepted', undefined, { lead_responder_id: memberId });
        broadcastResponderChange(requestId, memberId, 'assigned');

        if (memberId !== userId) {
            sendPushToUsers([memberId], {
                title: 'Mission Assignment',
                body: `You have been assigned to request ${requestId}.`,
                tag: 'assignment',
                data: { url: '/requests', requestId: requestId }
            });
        }
    }
    handleSupabaseError({ error, message: 'Failed to accept request' });
}

export async function adminAcceptAndAssignRequest(requestId: string, leadResponderId: number, userId: number, notes: string, urgency?: UrgencyLevel) {

    // Verify Org ownership
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    const { error } = await supabase.from('request_responders').upsert(
        { request_id: requestId, user_id: leadResponderId },
        { onConflict: 'request_id,user_id', ignoreDuplicates: true }
    );

    if (!error) {
        const updates: Record<string, unknown> = { lead_responder_id: leadResponderId };
        if (urgency) updates.urgency = urgency;
        await updateRequestStatus(requestId, ServiceRequestStatus.Accepted, userId, notes, undefined, updates);
        broadcastResponderChange(requestId, leadResponderId, 'assigned');

        // Notify the lead
        sendPushToUsers([leadResponderId], {
            title: 'Mission Command Assigned',
            body: `You have been designated Lead Responder for ${requestId}.`,
            tag: 'assignment',
            data: { url: '/requests', requestId: requestId }
        });
    }
    handleSupabaseError({ error, message: 'Failed to assign request' });
}

type RequestActor = { id: number; role?: string; permissions?: string[] };

// Duty over a request = staff who run the dispatch board (NOT the member-default
// request:start/complete/accept perms). Used to gate the reputation write inside
// completeRequest and to authorize start/complete on requests one isn't assigned to.
function hasRequestDuty(user: { role?: string; permissions?: string[] } | undefined): boolean {
    const perms = Array.isArray(user?.permissions) ? user!.permissions! : [];
    return user?.role === 'Admin'
        || perms.includes('request:dispatch') || perms.includes('request:triage')
        || perms.includes('request:set_lead') || perms.includes('request:manage_responders')
        || perms.includes('request:update');
}

/**
 * request:start / request:complete are in the Member default set but act on a
 * caller-supplied request id, so verify the caller is actually a responder on (or
 * has duty over) the request. Without this, any Member could drive arbitrary
 * requests to completion — and via the completion report reach the reputation RPC.
 * Duty holders manage any request; otherwise only the lead/assigned responder.
 */
export async function assertRequestResponderOrDuty(requestId: string, user: RequestActor): Promise<void> {
    if (hasRequestDuty(user)) return;
    const { data: req } = await supabase.from('service_requests').select('lead_responder_id').eq('id', requestId).maybeSingle();
    if (!req) throw new Error('Request not found.');
    if (req.lead_responder_id === user.id) return;
    const { data: responder } = await supabase.from('request_responders')
        .select('user_id').eq('request_id', requestId).eq('user_id', user.id).maybeSingle();
    if (responder) return;
    throw new Error('Forbidden: you are not assigned to this request.');
}

export async function completeRequest(requestId: string, report: RequestReport, userId: number, actor?: RequestActor) {

    await updateRequestStatus(requestId, report.outcome || ServiceRequestStatus.Success, userId, report.notes, report, undefined);
    // The completion report's reputation adjustment reaches the admin-only
    // reputation RPC, so honor it ONLY for a duty holder — a member-reachable
    // completion must not be able to move a client's reputation (priv-esc).
    if (report.clientReputationChange && hasRequestDuty(actor)) {
        const { data: req } = await supabase.from('service_requests').select('client_id')
            .eq('id', requestId)

            .maybeSingle();
        if (req && req.client_id) {
            const { data: user } = await supabase.from('users').select('reputation')
                .eq('id', req.client_id)

                .maybeSingle();
            if (user) {
                const newRep = Math.max(0, Math.min(100, user.reputation + report.clientReputationChange));
                await adminAdjustUserReputation(req.client_id, newRep, userId, `Mission ${requestId} outcome`);
            }
        }
    }
}

/**
 * The client-driven request actions (cancel, rate) are permission-gated
 * (request:cancel / request:rate — both held by every Client) but act on a
 * request id the caller supplies, so an ownership check is required: a Client who
 * learns another user's request id could otherwise cancel or rate it.
 * Duty-permission holders (the dispatch board) may act on any request; everyone
 * else only on their own. Throws on violation.
 */
export async function assertRequestOwnerOrDuty(requestId: string, user: { id: number; role?: string; permissions?: string[] }): Promise<void> {
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    const isDuty = user.role === 'Admin'
        || perms.includes('request:dispatch') || perms.includes('request:triage') || perms.includes('request:accept');
    if (isDuty) return;
    const { data } = await supabase.from('service_requests').select('client_id').eq('id', requestId).maybeSingle();
    if (!data) throw new Error('Request not found.');
    if (data.client_id !== user.id) throw new Error('Forbidden: you can only act on your own requests.');
}

export async function rateRequest(requestId: string, rating: number, feedback: string) {

    const { error } = await supabase.from('service_requests').update({ rated: true, client_rating: rating, client_feedback: feedback })
        .eq('id', requestId)
        ;
    handleSupabaseError({ error, message: 'Failed to rate request' });
}

export async function addRequestNote(requestId: string, note: string, userId: number) {

    const { data, error: selectError } = await supabase.from('service_requests').select('status')
        .eq('id', requestId)
        
        .maybeSingle();
    if (selectError || !data) {
        throw new Error('Request not found or access denied');
    }

    if (data) {
        const { error } = await supabase.from('status_history').insert({ request_id: requestId, status: data.status, updated_by: userId, note });
        handleSupabaseError({ error, message: 'Failed to add note' });
        await broadcastRequestUpdate(requestId);
    }
}

export async function dispatchMembers(requestId: string, memberIds: number[]) {

    // Verify Org ownership
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    // Snapshot the current responder set before mutation so we can emit a
    // precise assigned/unassigned diff afterwards instead of a blanket alert.
    const { data: existingRows } = await supabase.from('request_responders').select('user_id').eq('request_id', requestId);
    const existingIds = new Set<number>((existingRows || []).map((r: { user_id: number }) => r.user_id));
    const newIds = new Set<number>(memberIds);

    const { error: deleteError } = await supabase.from('request_responders').delete().eq('request_id', requestId);
    if (!deleteError && memberIds.length > 0) {
        const { error } = await supabase.from('request_responders').insert(memberIds.map(uid => ({ request_id: requestId, user_id: uid })));
        handleSupabaseError({ error, message: 'Failed to dispatch members' });

        // Auto-assign lead if none exists and we just dispatched members
        if (memberIds.length > 0) {
            const { data: req } = await supabase.from('service_requests').select('lead_responder_id, service_type').eq('id', requestId).maybeSingle();
            if (req && !req.lead_responder_id) {
                await supabase.from('service_requests').update({ lead_responder_id: memberIds[0] }).eq('id', requestId);
            }

            // Emit per-user responder_change broadcasts so each affected user
            // gets the right toast (assigned or unassigned), and existing
            // members retained across the dispatch don't get a re-assigned ding.
            for (const uid of memberIds) {
                if (!existingIds.has(uid)) broadcastResponderChange(requestId, uid, 'assigned');
            }
            for (const oldId of existingIds) {
                if (!newIds.has(oldId)) broadcastResponderChange(requestId, oldId, 'unassigned');
            }

            // Notify all dispatched members
            sendPushToUsers(memberIds, {
                title: 'Unit Dispatched',
                body: `You have been assigned to ${req?.service_type || 'a mission'} (${requestId}).`,
                tag: 'assignment',
                data: { url: '/requests', requestId: requestId }
            });
            await broadcastRequestUpdate(requestId);
        }
    } else if (!deleteError) {
        // memberIds is empty — pure clear. Emit unassigned for everyone who was on the list.
        for (const oldId of existingIds) {
            broadcastResponderChange(requestId, oldId, 'unassigned');
        }
        await broadcastRequestUpdate(requestId);
    }
}

export async function addResponderToRequest(requestId: string, memberId: number) {

    // Verify Org
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    // Idempotency: if the responder row already existed, the upsert is a no-op
    // and we should not re-broadcast an "assigned" event (would double-toast).
    const { data: existing } = await supabase.from('request_responders').select('user_id').eq('request_id', requestId).eq('user_id', memberId).maybeSingle();
    const wasAlreadyResponder = !!existing;

    const { error } = await supabase.from('request_responders').upsert(
        { request_id: requestId, user_id: memberId },
        { onConflict: 'request_id,user_id', ignoreDuplicates: true }
    );
    handleSupabaseError({ error, message: 'Failed to add responder' });

    const { data: req } = await supabase.from('service_requests').select('lead_responder_id, service_type').eq('id', requestId).maybeSingle();
    if (req && !req.lead_responder_id) {
        await supabase.from('service_requests').update({ lead_responder_id: memberId }).eq('id', requestId);
    }

    if (!wasAlreadyResponder) {
        broadcastResponderChange(requestId, memberId, 'assigned');
    }

    // Notify Responder
    sendPushToUsers([memberId], {
        title: 'Mission Assignment',
        body: `You have been added to ${req?.service_type || 'mission'} ${requestId}.`,
        tag: 'assignment',
        data: { url: '/requests', requestId: requestId }
    });
    await broadcastRequestUpdate(requestId);
}

export async function removeResponderFromRequest(requestId: string, memberId: number) {

    // Verify request belongs to caller's org before touching responders (cross-table gate)
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    const { error } = await supabase.from('request_responders').delete().eq('request_id', requestId).eq('user_id', memberId);
    handleSupabaseError({ error, message: 'Failed to remove responder' });
    await supabase.from('service_requests').update({ lead_responder_id: null }).eq('id', requestId).eq('lead_responder_id', memberId);
    broadcastResponderChange(requestId, memberId, 'unassigned');
    await broadcastRequestUpdate(requestId);
}

export async function setLeadResponder(requestId: string, memberId?: number) {

    const { error } = await supabase.from('service_requests').update({ lead_responder_id: memberId || null })
        .eq('id', requestId)
        ;
    handleSupabaseError({ error, message: 'Failed to set lead responder' });

    if (memberId) {
        sendPushToUsers([memberId], {
            title: 'Lead Assigned',
            body: `You are now the Lead Responder for ${requestId}.`,
            tag: 'assignment',
            data: { url: '/requests', requestId: requestId }
        });
    }
    await broadcastRequestUpdate(requestId);
}

export async function deleteServiceRequest(requestId: string) {

    const { error } = await supabase.from('service_requests').delete()
        .eq('id', requestId)
        ;
    handleSupabaseError({ error, message: 'Failed to delete request' });

    // Broadcast delete event so other users' views update immediately
    broadcastToOrg('request_delete', { requestId });
}
