

import { ServiceRequest, ServiceRequestStatus, UrgencyLevel, HydratedServiceRequest } from '../../types.js';
import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { escapeLikePattern } from '../pgrest.js';
import { toServiceRequest } from './mappers.js';
import { adminAdjustUserReputation } from './users.js';
import { sendPushToStaff } from '../push.js';
import { createNotification } from './notifications.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { SecurityDenial } from '../errors.js';
import {
    isCancellableByClient, isTerminalRequestStatus, isAlreadyRated, mayRaiseRequest,
} from '../requestLifecycle.js';

type FeedbackViewer = { id?: number; permissions?: string[] } | null | undefined;

/**
 * The free-text `clientFeedback` is gated behind the dedicated `request:view:feedback`
 * permission (held only by Dispatcher/Admin tiers — a plain Member does NOT hold it).
 * The UI honours this (ServiceRequestDetailView only renders the feedback block for
 * holders), but the data must be stripped SERVER-side too — client-side filters are
 * cosmetic, never security (Security rule 2). The numeric `clientRating` is left
 * intact (the UI shows it to everyone); only the candid free-text is redacted.
 *
 * "May see" = holder of `request:view:feedback` OR the owning client who authored
 * it. NO ROLE-NAME BYPASS: this used to admit `viewer?.role === 'Admin'`, and `role`
 * is inferred from the role row's free-text NAME (lib/db/mappers.ts), so a
 * permissionless custom role called "Commander" read every client's candid feedback.
 * Admin and Dispatcher are both seeded with request:view:feedback, so the permission
 * alone takes nothing away. Replicated at api/actions/admin.ts
 * (assertMayReadClientFeedback) and twice in api/services.ts — keep all four in
 * lock-step or the redaction and listing routes drift.
 *
 * Pure / dependency-free so it unit-tests cleanly under both tsconfigs and so
 * list / detail / aggregate paths cannot drift.
 */
export function redactRequestFeedbackForViewer<T extends { clientFeedback?: string | null; clientId?: number | null }>(req: T, viewer: FeedbackViewer): T {
    if (!req.clientFeedback) return req;
    const perms = Array.isArray(viewer?.permissions) ? viewer!.permissions! : [];
    const maySee = perms.includes('request:view:feedback')
        || (viewer?.id != null && viewer.id === req.clientId);
    if (maySee) return req;
    return { ...req, clientFeedback: null } as T;
}

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
    // Check for existing active requests. BIND THE ERROR: without it a read fault yields
    // `count === undefined`, the guard below silently passes, and the one-active-request
    // rule stops applying at exactly the moment the database is struggling.
    const { count, error: countError } = await supabase.from('service_requests')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', userId)
        .in('status', [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged, ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress]);
    if (countError) throw new Error('Could not verify your active requests. Please try again.');

    if (count && count > 0) {
        throw new Error('Action Blocked: You already have an active service request in progress.');
    }

    // STANDING FLOOR — the server half of a rule that until now lived only in React.
    //
    // CreateRequestModal and DashboardView both refuse at `reputation <= 10`, and the admin
    // console promises operators that low-reputation clients "are restricted from initiating
    // new service requests". The server never read the column. Worse, the client copy is not
    // even live in an open tab: adminAdjustUserReputation emits no broadcast, so a sanctioned
    // session keeps rendering the form for the rest of its 24-hour token. The sanction was
    // the org's only anti-abuse lever short of deleting the account, and it did nothing —
    // while every successful create fans a push to EVERY staff member and posts a Discord
    // embed, so a sanctioned client held an unmetered staff-phone spam amplifier.
    //
    // Deliberately AFTER the active-request check so an ordinary client who is merely busy
    // still gets the specific "you already have an active request" copy rather than a
    // standing message that does not apply to them.
    const { data: actorRow, error: repError } = await supabase.from('users')
        .select('reputation').eq('id', userId).maybeSingle();
    if (repError || !actorRow) throw new Error('Could not verify your standing. Please try again.');
    if (!mayRaiseRequest(actorRow.reputation)) {
        throw new SecurityDenial(
            'Action Blocked: your standing is too low to raise a service request. Contact command to review it.',
            { auditEvent: 'authz.resource.denied', fields: { reputation: actorRow.reputation } },
        );
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
    }).select('id, client_id, unregistered_client_rsi_handle, service_type, location, description, status, urgency, threat_level, lead_responder_id, created_at, updated_at, uec_earned, medigel_consumed, client_rating, client_feedback, rated, party_info, secondary_client_handles').single();

    // Race backstop for the count check above: the partial unique index
    // (uq_one_active_self_request) rejects a second concurrent active self request.
    if (error && (error as { code?: string }).code === '23505') {
        throw new Error('Action Blocked: You already have an active service request in progress.');
    }

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
    if (!data) throw new Error('Failed to create request');
    return toServiceRequest(data);
}

export async function createAdHocServiceRequest(
    req: Partial<ServiceRequest>,
    userId: number,
    actor?: { permissions?: string[] },
): Promise<HydratedServiceRequest> {
    // THE SIBLING'S GUARDS APPLY HERE TOO. createServiceRequest carries a standing
    // floor and a one-active-request cap, and both exist because every successful
    // create fans a push to EVERY staff member and posts a Discord embed. This path
    // reaches the same amplifier under a permission that is a MEMBER DEFAULT
    // (lib/roleDefaultPermissions.ts), so leaving it unguarded made the sanction a
    // suggestion: a client refused at request:create simply used request:create_adhoc.
    const { data: actorRow, error: repError } = await supabase.from('users')
        .select('reputation').eq('id', userId).maybeSingle();
    if (repError || !actorRow) throw new Error('Could not verify your standing. Please try again.');
    if (!mayRaiseRequest(actorRow.reputation)) {
        throw new SecurityDenial(
            'Action Blocked: your standing is too low to raise a service request. Contact command to review it.',
            { auditEvent: 'authz.resource.denied', fields: { reputation: actorRow.reputation } },
        );
    }

    const id = generateRequestId();

    const userQuery = supabase.from('users')
        .select('id')
        .ilike('rsi_handle', escapeLikePattern(req.unregisteredClientRsiHandle || ''));

    const { data: existingUser } = await userQuery.maybeSingle();

    // BINDING ANOTHER MEMBER TO A REQUEST IS A DUTY ACTION, not a side effect of
    // typing their handle. The handle is caller-supplied and unverified, so linking
    // whoever it matched attributed the request to that member, consumed their single
    // active-request slot (locking them out of raising their own), and put their name
    // on a Discord post they did not make. Linked only when the actor IS that member,
    // or holds a real dispatch duty — otherwise the request still logs, exactly as it
    // does for a genuinely unregistered client, with the handle recorded as text.
    const resolvedClientId = existingUser?.id;
    const mayBindClient = resolvedClientId != null
        && (Number(resolvedClientId) === Number(userId) || hasRequestDuty(actor));
    const clientId = mayBindClient ? resolvedClientId : undefined;

    // And when it IS bound, that member's one-active-request rule applies — the whole
    // point of the cap is defeated if a second path can open one on their behalf.
    if (clientId != null) {
        const { count, error: countError } = await supabase.from('service_requests')
            .select('id', { count: 'exact', head: true })
            .eq('client_id', clientId)
            .in('status', [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged, ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress]);
        if (countError) throw new Error('Could not verify active requests. Please try again.');
        if (count && count > 0) {
            throw new Error('Action Blocked: that client already has an active service request in progress.');
        }
    }

    const { data, error } = await supabase.from('service_requests').insert({
        id,
        client_id: clientId,
        unregistered_client_rsi_handle: stripHtmlSingleLine(req.unregisteredClientRsiHandle, 100),
        service_type: req.serviceType,
        location: stripHtmlSingleLine(req.location, 200),
        description: stripHtml(req.description, 4000),
        urgency: req.urgency,
        threat_level: req.threatLevel,
        party_info: req.partyInfo,
        secondary_client_handles: req.secondaryClientHandles,
        status: ServiceRequestStatus.Submitted
    }).select('id, client_id, unregistered_client_rsi_handle, service_type, location, description, status, urgency, threat_level, lead_responder_id, created_at, updated_at, uec_earned, medigel_consumed, client_rating, client_feedback, rated, party_info, secondary_client_handles').single();

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
    if (!data) throw new Error('Failed to create ad-hoc request');
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
    // `urgency` (request:triage) is the ONLY field this bag carries — and the comment
    // saying so was previously wrong, which is what hid a real bug: acceptRequest and
    // adminAcceptAndAssignRequest both passed `lead_responder_id` through here, where
    // it was silently dropped, so the lead was never written on either accept path and
    // the dispatcher's isRequestLead ownership bypass was dead for those requests.
    // They now use the dedicated path — see claimLeadResponderIfUnset below.
    //
    // Do NOT widen this allowlist to lead_responder_id: it is privilege-bearing, and
    // this bag is a `Record<string, unknown>` that a future handler could wire
    // straight to a client payload (today every call site passes `undefined` or a
    // server-constructed `{ urgency }`).
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
                // Persist a durable inbox notification for the requester; this also
                // emits the id-only realtime signal AND fires the OS push, so it
                // replaces the former raw sendPushToUsers (no double-push).
                await createNotification(req.client_id, {
                    type: 'request',
                    title: clientTitle,
                    body: clientBody,
                    link: 'requests',
                    metadata: { requestId },
                }).catch(() => { /* best-effort */ });
            }
        }
        await broadcastRequestUpdate(requestId);
    }
    handleSupabaseError({ error, message: 'Failed to update request status' });
}

/**
 * Set lead_responder_id ONLY if the request currently has none.
 *
 * lead_responder_id is PRIVILEGE-BEARING: api/services.ts grants
 * request:add_responder / request:remove_responder to whoever holds it, WITHOUT the
 * request:manage_responders permission. So it is written on this dedicated path and
 * never through updateRequestStatus's `updates` bag, which exists to carry a
 * caller-supplied field (`urgency`) and must stay unable to confer that bypass.
 *
 * The `.is('lead_responder_id', null)` on the UPDATE is a compare-and-swap: two
 * members accepting at once both read null, and without it the second would
 * overwrite the first's lead.
 */
async function claimLeadResponderIfUnset(requestId: string, memberId: number): Promise<void> {
    const { data: req } = await supabase.from('service_requests')
        .select('lead_responder_id').eq('id', requestId).maybeSingle();
    if (req && !req.lead_responder_id) {
        const { error } = await supabase.from('service_requests')
            .update({ lead_responder_id: memberId })
            .eq('id', requestId)
            .is('lead_responder_id', null);
        handleSupabaseError({ error, message: 'Failed to set lead responder' });
    }
}

/**
 * Drop the lead when the lead is no longer on the responder list — the mirror of
 * claimLeadResponderIfUnset, and load-bearing for the same reason: the isRequestLead
 * bypass must not outlive the assignment that justified it.
 * removeResponderFromRequest has always cleared it on the single-remove path;
 * dispatchMembers, which REPLACES the whole responder set, did not, leaving a member
 * dropped by a re-dispatch holding the bypass on a request they are off.
 *
 * `.eq('lead_responder_id', currentLead)` makes the clear a compare-and-swap: a
 * dispatcher who named a NEW lead between our read and our write keeps theirs.
 *
 * `responderIds` must be built from the ids actually inserted — PostgREST casts a
 * numeric string into the int4 column, so a `'8'` in the caller's array inserts
 * responder 8 while `has(8)` is false. That direction fails closed (the retained
 * lead is cleared, then re-claimed), but do not invert the comparison.
 */
async function clearLeadIfNotResponder(requestId: string, responderIds: Set<number>): Promise<void> {
    const { data: req } = await supabase.from('service_requests')
        .select('lead_responder_id').eq('id', requestId).maybeSingle();
    const currentLead = req?.lead_responder_id;
    if (!currentLead || responderIds.has(currentLead)) return;
    const { error } = await supabase.from('service_requests')
        .update({ lead_responder_id: null })
        .eq('id', requestId)
        .eq('lead_responder_id', currentLead);
    handleSupabaseError({ error, message: 'Failed to clear lead responder' });
}

// A request can only be ACCEPTED out of one of these states. Mirrors the client
// UI, which offers "Accept" only on Submitted/Triaged.
const ACCEPTABLE_FOR_ACCEPT: string[] = [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged];

export async function acceptRequest(requestId: string, memberId: number, userId: number, actor?: RequestActor) {

    // A member may accept a request only for THEMSELVES. Assigning a different
    // member as responder is a dispatch action and needs real dispatch duty —
    // otherwise any member could commandeer open requests and force-assign (and
    // notification-spam) arbitrary users. The proper "assign someone else" path is
    // adminAcceptAndAssignRequest (gated by request:set_lead / dispatch).
    if (memberId !== userId && !hasRequestDuty(actor)) {
        throw new Error('Forbidden: you can only accept a request for yourself.');
    }

    // Check the request exists and is still acceptable. Any member can hold
    // request:accept, so without a status check one could push a finished or
    // in-progress request back to 'Accepted' and fire a stray "Mission Assignment"
    // notification. Read the status and bail if it's past the acceptable point.
    // (This read also serves as the existence check the responder insert can't do.)
    const { data: req } = await supabase.from('service_requests').select('status, client_id').eq('id', requestId).maybeSingle();
    if (!req) throw new Error("Request not found or access denied.");
    if (!ACCEPTABLE_FOR_ACCEPT.includes(req.status)) throw new Error('Request can no longer be accepted.');

    // Self-service block (public-stats integrity): a member must not become the
    // responder on their OWN request. The full member chain (create→accept→start→
    // complete→rate) otherwise lets one account manufacture rated 'Success' rows,
    // which feed the UNAUTHENTICATED public org stats (public_stats_for_org) with
    // no curation — inflating/defacing the average and response-time metrics. A
    // member-client's request must be serviced by a DIFFERENT responder; only a
    // real dispatch-duty holder may self-assign (e.g. logging a solo run).
    if (req.client_id != null && req.client_id === memberId && !hasRequestDuty(actor)) {
        throw new Error('Forbidden: you cannot respond to your own request.');
    }

    const { error } = await supabase.from('request_responders').insert({ request_id: requestId, user_id: memberId });
    if (!error) {
        await updateRequestStatus(requestId, ServiceRequestStatus.Accepted, userId, 'Request accepted', undefined, undefined);
        // SELF-accept only, and only if the request has no lead yet. `memberId` is a
        // TARGET-identity field the dispatcher deliberately does not force to the
        // actor, so claiming the lead for an arbitrary memberId would let a duty
        // holder who has request:triage but NOT request:set_lead hand the
        // privilege-bearing isRequestLead bypass to any user. Nothing legitimate is
        // lost: naming someone else's lead is adminAcceptAndAssignRequest, which is
        // request:dispatch-gated and sets the lead unconditionally.
        if (memberId === userId) {
            await claimLeadResponderIfUnset(requestId, memberId);
        }
        broadcastResponderChange(requestId, memberId, 'assigned');

        if (memberId !== userId) {
            // The body drops the request id: link + metadata carry it, and this string rides
            // an OS push tray that is not permission-gated at read time.
            await createNotification(memberId, {
                type: 'responder',
                title: 'Mission Assignment',
                body: 'You have been assigned to a service request.',
                link: 'requests',
                metadata: { requestId },
            }).catch(() => { /* best-effort: never fail the assignment on a notify fault */ });
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
        await updateRequestStatus(requestId, ServiceRequestStatus.Accepted, userId, notes, undefined, urgency ? { urgency } : undefined);
        // Unconditional, unlike acceptRequest: a dispatcher has explicitly NAMED this
        // member as lead, so it overrides any existing lead. Same dedicated path —
        // never the `updates` bag (see claimLeadResponderIfUnset).
        const { error: leadErr } = await supabase.from('service_requests')
            .update({ lead_responder_id: leadResponderId }).eq('id', requestId);
        handleSupabaseError({ error: leadErr, message: 'Failed to set lead responder' });
        broadcastResponderChange(requestId, leadResponderId, 'assigned');

        // Notify the lead. The `!== userId` guard is NEW: open pushed unconditionally, so a
        // dispatcher naming themselves lead pinged themselves. Every sibling path guards this.
        if (leadResponderId !== userId) {
            await createNotification(leadResponderId, {
                type: 'responder',
                title: 'Lead Responder Assigned',
                body: 'You have been designated Lead Responder for a service request.',
                link: 'requests',
                metadata: { requestId },
            }).catch(() => { /* best-effort */ });
        }
    }
    handleSupabaseError({ error, message: 'Failed to assign request' });
}

type RequestActor = { id: number; permissions?: string[] };

// Duty over a request = staff who run the dispatch board (NOT the member-default
// request:start/complete/accept perms). Used to gate the reputation write inside
// completeRequest and to authorize start/complete on requests one isn't assigned to.
// NO ROLE-NAME BYPASS: the `role === 'Admin'` disjunct is gone — `role` is inferred
// from the role row's free-text NAME, so a permissionless custom role called
// "Commander" held duty over every request. Admin and Dispatcher are seeded with the
// dispatch/triage perms, so the permission set alone takes nothing away.
/**
 * Which client-driven action a caller is attempting. REQUIRED, never optional: an optional
 * kind would silently default a future call site to "no precondition at all", which is the
 * exact fail-open shape these guards exist to remove. TypeScript now forces every call site
 * to declare its intent.
 */
export type RequestActionKind = 'cancel' | 'rate';

/** Which lifecycle transition a responder is driving. Same reasoning — required. */
export type RequestWorkKind = 'start' | 'complete';

function hasRequestDuty(user: { permissions?: string[] } | undefined): boolean {
    const perms = Array.isArray(user?.permissions) ? user!.permissions! : [];
    return perms.includes('request:dispatch') || perms.includes('request:triage')
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
export async function assertRequestResponderOrDuty(requestId: string, user: RequestActor, kind: RequestWorkKind): Promise<void> {
    // The row is read BEFORE the duty bypass, deliberately. The terminal check below has to
    // apply to duty holders too — they are the only callers whose completion report reaches
    // the reputation RPC, so they are precisely who could replay it.
    const { data: req } = await supabase.from('service_requests').select('lead_responder_id, status').eq('id', requestId).maybeSingle();
    if (!req) throw new Error('Request not found.');

    // A FINISHED REQUEST IS FINISHED. updateRequestStatus writes { status } unconditionally
    // and never reads the current value, so without this an assigned responder could drive a
    // Cancelled or Success row back to In-Progress, and re-complete it repeatedly — each
    // re-completion re-firing the notification and, for a duty actor, re-applying
    // report.clientReputationChange, which is idempotency-free. Composed with the standing
    // floor in createServiceRequest that is a route to locking a member out entirely.
    if (isTerminalRequestStatus(req.status)) {
        throw new SecurityDenial(
            `Action Blocked: this request is already ${req.status} and can no longer be ${kind === 'start' ? 'started' : 'completed'}.`,
            { auditEvent: 'authz.resource.denied', fields: { requestId, status: req.status } },
        );
    }

    if (hasRequestDuty(user)) return;
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
export async function assertRequestOwnerOrDuty(
    requestId: string,
    user: { id: number; permissions?: string[] },
    kind: RequestActionKind,
): Promise<void> {
    // Use the shared dispatch-duty set. Notably this does NOT include request:accept
    // (every member holds it) — otherwise any member could cancel or rate any
    // request. Only the dispatch board (or the request's own client) may act here.
    if (hasRequestDuty(user)) return;
    const { data } = await supabase.from('service_requests').select('client_id, status').eq('id', requestId).maybeSingle();
    if (!data) throw new Error('Request not found.');
    if (data.client_id !== user.id) throw new Error('Forbidden: you can only act on your own requests.');

    // STATUS PRECONDITION — the other half of the client's own predicate.
    //
    // Both client copies gate Cancel on `status === Submitted`; the server checked ownership
    // and nothing else, and updateRequestStatus never reads the current status. So a Client —
    // holding only ['request:create','request:cancel','request:rate'] — could POST
    // request:cancel against their OWN completed job and flip a Success row to Cancelled.
    // public_stats_for_org counts `FILTER (WHERE status = 'Success')`, so that retroactively
    // deletes a finished job from the org's UNAUTHENTICATED public scoreboard. A cancel out
    // of In-Progress also frees the uq_one_active_self_request slot, making create→cancel→
    // create a loop bounded only by the identity rate limiter.
    //
    // A stale tab reaches this honestly: a client whose request moved Submitted→Accepted
    // between render and click still has the button on screen. That is why the message is
    // specific and why the two client catch blocks now surface it.
    if (kind === 'cancel' && !isCancellableByClient(data.status)) {
        throw new SecurityDenial(
            'Action Blocked: this request has already been picked up and can no longer be cancelled. Contact dispatch.',
            { auditEvent: 'authz.resource.denied', fields: { requestId, status: data.status } },
        );
    }
}

export async function rateRequest(requestId: string, rating: number, feedback: string, actor?: RequestActor) {
    // Validate like the marketplace rating path: a finite 1..5 integer. An out-of-range
    // or non-finite value would otherwise be written straight into the public org
    // rating average (public_stats_for_org), letting any account deface the score.
    const stars = Math.round(Number(rating));
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) throw new Error('Rating must be 1–5 stars.');

    // Only a completed (Success) request is rateable. That matches what the public
    // stats count and stops a fresh account from rating a request it created itself
    // just to move the public average.
    const { data: req } = await supabase.from('service_requests').select('status, rated, client_rating').eq('id', requestId).maybeSingle();
    if (!req) throw new Error('Request not found.');
    if (req.status !== ServiceRequestStatus.Success) throw new Error('Only a completed request can be rated.');

    // ONE RATING PER REQUEST. Both client copies gate on `!request.rated`; the server read
    // `status` and not `rated`, wrote `rated: true`, and then never read it back. So the
    // owning client could re-POST indefinitely: leave 5 stars to get the job done, flip it to
    // 1 a week later, repeatedly. client_rating is a single column, so public_stats_for_org's
    // AVG always reflects the LATEST value and there is no per-request rating history to
    // reconstruct what happened. It also rewrites client_feedback, the permission-gated free
    // text Dispatchers read through redactRequestFeedbackForViewer.
    //
    // Duty holders ARE exempt, deliberately: request:rate is a Dispatcher default precisely
    // so staff can enter a rating for a phoned-in job, and with no rating-history table an
    // absolute lock would make a mis-keyed value permanently unfixable through the product.
    // This mirrors how the cancel precondition above exempts duty.
    if (isAlreadyRated(req) && !hasRequestDuty(actor)) {
        throw new SecurityDenial(
            'Action Blocked: this request has already been rated. Ratings cannot be changed.',
            { auditEvent: 'authz.resource.denied', fields: { requestId } },
        );
    }

    const { error } = await supabase.from('service_requests')
        .update({ rated: true, client_rating: stars, client_feedback: stripHtml(feedback, 1000) || null })
        .eq('id', requestId);
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

export async function dispatchMembers(requestId: string, memberIds: number[], userId: number) {

    // Verify Org ownership
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    // Snapshot the current responder set before mutation so we can emit a
    // precise assigned/unassigned diff afterwards instead of a blanket alert.
    // BIND THE ERROR. This set is now load-bearing for a DURABLE write: on a read fault it
    // comes back empty, which reads as "nobody was assigned before" and would notify the
    // ENTIRE dispatched set — including members already on it. A duplicate toast was the old
    // cost of that; a durable row plus an OS push is not. When the prior set is unknown we
    // still broadcast (unchanged) but send nothing.
    const { data: existingRows, error: existingErr } = await supabase.from('request_responders').select('user_id').eq('request_id', requestId);
    const priorSetKnown = !existingErr;
    const existingIds = new Set<number>((existingRows || []).map((r: { user_id: number }) => r.user_id));
    const newIds = new Set<number>(memberIds);

    const { error: deleteError } = await supabase.from('request_responders').delete().eq('request_id', requestId);

    // The responder set was just REPLACED wholesale, so a lead who is not in the new
    // set has to lose the lead too — otherwise they keep the privilege-bearing
    // isRequestLead bypass on a request they are no longer assigned to. Runs on BOTH
    // branches below (a re-dispatch and a pure clear), and BEFORE the claim so the
    // first newly-dispatched member is promoted into the vacancy this creates.
    if (!deleteError) await clearLeadIfNotResponder(requestId, newIds);

    if (!deleteError && memberIds.length > 0) {
        const { error } = await supabase.from('request_responders').insert(memberIds.map(uid => ({ request_id: requestId, user_id: uid })));
        handleSupabaseError({ error, message: 'Failed to dispatch members' });

        // Auto-assign lead if none exists and we just dispatched members
        if (memberIds.length > 0) {
            await claimLeadResponderIfUnset(requestId, memberIds[0]);

            // Emit per-user responder_change broadcasts so each affected user
            // gets the right toast (assigned or unassigned), and existing
            // members retained across the dispatch don't get a re-assigned ding.
            for (const uid of memberIds) {
                if (existingIds.has(uid)) continue;
                broadcastResponderChange(requestId, uid, 'assigned');
                // Only genuinely NEW responders, and never the dispatcher themselves. Open
                // pushed the WHOLE memberIds array, re-pinging everyone retained across a
                // re-dispatch — even though the broadcast on the line above was already
                // deduped against exactly this set.
                if (priorSetKnown && uid !== userId) {
                    await createNotification(uid, {
                        type: 'responder',
                        title: 'Unit Dispatched',
                        body: 'You have been assigned to a service request.',
                        link: 'requests',
                        metadata: { requestId },
                    }).catch(() => { /* best-effort */ });
                }
            }
            for (const oldId of existingIds) {
                if (!newIds.has(oldId)) broadcastResponderChange(requestId, oldId, 'unassigned');
            }

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

export async function addResponderToRequest(requestId: string, memberId: number, userId: number) {

    // Verify Org
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('id', requestId);
    if (!count) throw new Error("Request not found or access denied.");

    // Idempotency: if the responder row already existed, the upsert is a no-op
    // and we should not re-broadcast an "assigned" event (would double-toast).
    // BIND THE ERROR — same reasoning as dispatchMembers: a faulted read resolves to
    // "not already a responder", which is the notify-permitting answer.
    const { data: existing, error: existingErr } = await supabase.from('request_responders').select('user_id').eq('request_id', requestId).eq('user_id', memberId).maybeSingle();
    const wasAlreadyResponder = !!existing;
    const priorStateKnown = !existingErr;

    const { error } = await supabase.from('request_responders').upsert(
        { request_id: requestId, user_id: memberId },
        { onConflict: 'request_id,user_id', ignoreDuplicates: true }
    );
    handleSupabaseError({ error, message: 'Failed to add responder' });

    await claimLeadResponderIfUnset(requestId, memberId);

    // Signal AND notify a genuinely NEW responder only. The upsert is a no-op on a
    // re-add, but this push is unthrottled and aimed at a caller-supplied member id —
    // and now that lead_responder_id is actually written, the api/services.ts
    // isRequestLead bypass hands request:add_responder to any Member who accepted the
    // request, so a repeated no-op re-add would be a push amplifier for them. (A
    // remove-then-re-add still notifies; throttling that is a separate concern.)
    if (!wasAlreadyResponder) {
        broadcastResponderChange(requestId, memberId, 'assigned');
        if (priorStateKnown && memberId !== userId) {
            await createNotification(memberId, {
                type: 'responder',
                title: 'Mission Assignment',
                body: 'You have been added to a service request.',
                link: 'requests',
                metadata: { requestId },
            }).catch(() => { /* best-effort */ });
        }
    }
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

export async function setLeadResponder(requestId: string, memberId: number | undefined, userId: number) {

    const { error } = await supabase.from('service_requests').update({ lead_responder_id: memberId || null })
        .eq('id', requestId)
        ;
    handleSupabaseError({ error, message: 'Failed to set lead responder' });

    // Never on a CLEAR (memberId undefined), and never a self-ping.
    if (memberId && memberId !== userId) {
        await createNotification(memberId, {
            type: 'responder',
            title: 'Lead Responder Assigned',
            body: 'You are now the Lead Responder for a service request.',
            link: 'requests',
            metadata: { requestId },
        }).catch(() => { /* best-effort */ });
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
