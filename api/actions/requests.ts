
import * as db from '../../lib/db.js';
import * as discord from '../../lib/discord.js';
import { broadcastToOrg } from '../../lib/db/common.js';
import { ServiceRequestStatus } from '../../types.js';
import type { ServiceRequest, UrgencyLevel } from '../../types.js';
import { log as baseLog } from '../../lib/log.js';

const log = baseLog.child({ module: 'actions.requests' });

/**
 * Mission completion report produced by CompleteRequestModal and consumed by
 * db.completeRequest / db.updateRequestStatus. Fields are read off-shape, so
 * everything is optional.
 */
interface RequestReport {
    notes?: string;
    uecEarned?: number;
    medigelConsumed?: number;
    clientReputationChange?: number;
    outcome?: string;
}

/**
 * Shape passed to notifyDiscordNewRequest: a mapped ServiceRequest (camelCase)
 * spread together with the raw insert row (snake_case) plus a minimal client
 * object. Reads tolerate either casing, so both variants are declared optional.
 */
interface DiscordRequestPayload {
    id?: string;
    client?: { name?: string };
    unregisteredClientRsiHandle?: string;
    unregistered_client_rsi_handle?: string;
    service_type?: string;
    serviceType?: string;
    location?: string;
    threat_level?: string;
    threatLevel?: string;
    description?: string;
    urgency?: string;
}

interface CreateRequestPayload {
    newRequest: Partial<ServiceRequest>;
    userId: number;
}

interface TriageRequestPayload {
    requestId: string;
    notes?: string;
    urgency?: UrgencyLevel;
    userId: number;
}

interface AdminAcceptRequestPayload {
    requestId: string;
    leadResponderId: number;
    notes: string;
    urgency?: UrgencyLevel;
    userId: number;
}

interface AcceptRequestPayload {
    requestId: string;
    memberId: number;
    userId: number;
}

interface StartRequestPayload {
    requestId: string;
    userId: number;
    user?: { id: number; role?: string; permissions?: string[] };
}

interface CompleteRequestPayload {
    requestId: string;
    report: RequestReport;
    userId: number;
    user?: { id: number; role?: string; permissions?: string[] };
}

interface CancelRequestPayload {
    requestId: string;
    userId: number;
}

interface RateRequestPayload {
    requestId: string;
    rating: number;
    feedback: string;
}

interface AddNotePayload {
    requestId: string;
    note: string;
    userId: number;
}

interface UpdateStatusPayload {
    requestId: string;
    status: string;
    notes?: string;
    report?: RequestReport;
    userId: number;
}

interface DispatchMembersPayload {
    requestId: string;
    memberIds: number[];
}

interface ResponderPayload {
    requestId: string;
    memberId: number;
}

interface SetLeadPayload {
    requestId: string;
    memberId?: number;
}

interface PartyMemberPayload {
    requestId: string;
    handle: string;
}

interface RefuseRequestPayload {
    requestId: string;
    notes?: string;
    userId: number;
}

interface DeleteRequestPayload {
    requestId: string;
}

/**
 * Sends a notification embed to the configured Discord channel for new requests.
 */
async function notifyDiscordNewRequest(request: DiscordRequestPayload) {
    try {
        const { data: settingsData } = await db.supabase.from('settings').select('key, value').in('key', ['discordConfig', 'brandingConfig']);
        const settings = (settingsData ?? []).reduce<Record<string, unknown>>((acc, curr: { key: string; value: unknown }) => ({ ...acc, [curr.key]: curr.value }), {});

        const discordConfig = settings.discordConfig as { newRequestChannelId?: string } | undefined;
        const globalChannelId = discordConfig?.newRequestChannelId;
        const branding = (settings.brandingConfig as { name?: string; iconUrl?: string } | undefined) || { name: 'Organization', iconUrl: '' };

        // Per-service-type override: route this notification to the channel
        // configured for the matching service_types row. Unset → fall back to
        // the global default. Lookup is best-effort; on failure (column
        // missing pre-migration, or row not found) we silently continue.
        let perTypeChannelId: string | null = null;
        try {
            const serviceTypeName = request.service_type || request.serviceType;
            if (serviceTypeName) {
                const { data: typeRow, error: typeErr } = await db.supabase
                    .from('service_types')
                    .select('discord_channel_id')
                    
                    .eq('name', serviceTypeName)
                    .maybeSingle();
                if (!typeErr && typeRow?.discord_channel_id) {
                    perTypeChannelId = typeRow.discord_channel_id;
                }
            }
        } catch (lookupErr) {
            log.warn('discord per-type channel lookup failed; falling back to global', { err: lookupErr });
        }

        const channelId = perTypeChannelId || globalChannelId;
        if (!channelId) {
            log.info('discord new-request notification skipped: no channel configured');
            return;
        }
        const routedVia = perTypeChannelId ? 'per-type' : 'global';
        log.info('discord sending new request notification', { channelId, routedVia });

        // Ensure no field value is empty/null and respect Discord's 1024-char field value limit
        const safeValue = (val: unknown, fallback: string = 'N/A', maxLength: number = 1024) => {
            if (val === null || val === undefined) return fallback;
            const str = String(val).trim();
            if (str.length === 0) return fallback;
            return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
        };

        const clientName = safeValue(request.client?.name || request.unregisteredClientRsiHandle || request.unregistered_client_rsi_handle, 'Unknown Client');
        const serviceType = safeValue(request.service_type || request.serviceType, 'Service');
        const location = safeValue(request.location, 'Unknown Location');
        const threatLevel = safeValue(request.threat_level || request.threatLevel, 'Unknown');
        const description = safeValue(request.description, 'No description provided.');
        const urgency = safeValue(request.urgency, 'Normal');

        const embed = {
            title: `🚨 NEW SERVICE REQUEST: ${request.id}`,
            color: 0x38bdf8, // Sky Blue
            fields: [
                { name: "Client", value: clientName, inline: true },
                { name: "Service Type", value: serviceType, inline: true },
                { name: "Urgency", value: urgency, inline: true },
                { name: "Location", value: location, inline: true },
                { name: "Threat Level", value: threatLevel, inline: true },
                { name: "Description", value: description }
            ],
            timestamp: new Date().toISOString(),
            footer: {
                text: `${branding.name || 'Organization'} Ops Terminal`,
                ...(branding.iconUrl && branding.iconUrl.startsWith('http') ? { icon_url: branding.iconUrl } : {})
            }
        };

        await discord.sendDiscordChannelMessage(channelId, { embeds: [embed] });
    } catch (err) {
        log.error('discord notification failed', { err });
    }
}

export const requestActions = {
    'request:create': async ({ newRequest, userId }: CreateRequestPayload) => {
        const request = await db.createServiceRequest(newRequest, userId);
        const { data: userData } = await db.supabase.from('users').select('name').eq('id', userId).single();
        // Full payload is used ONLY for the admin-configured Discord channel embed.
        const payload = { ...request, client: { name: userData?.name } };

        // Broadcast payloads are id-only — receivers re-fetch through the
        // permission-scoped /api/query requests path, which enforces per-caller
        // request visibility.
        broadcastToOrg('new_request', { id: request.id, clientId: request.clientId });

        await notifyDiscordNewRequest(payload);
        return request;
    },
    'request:create_adhoc': async ({ newRequest, userId }: CreateRequestPayload) => {
        const request = await db.createAdHocServiceRequest(newRequest, userId);
        const payload = { ...request };

        // id-only realtime broadcast (see request:create above).
        broadcastToOrg('new_request', { id: request.id, clientId: request.clientId });

        await notifyDiscordNewRequest(payload);
        return request;
    },
    'request:triage': ({ requestId, notes, urgency, userId }: TriageRequestPayload) => db.updateRequestStatus(requestId, ServiceRequestStatus.Triaged, userId, notes, undefined, urgency ? { urgency } : undefined),
    'request:admin_accept': ({ requestId, leadResponderId, notes, urgency, userId }: AdminAcceptRequestPayload) => db.adminAcceptAndAssignRequest(requestId, leadResponderId, userId, notes, urgency),
    // memberId is caller-supplied (not an actor field), so acceptRequest scopes it:
    // a plain member can only accept for themselves; assigning others needs dispatch duty.
    'request:accept': ({ requestId, memberId, userId, user }: AcceptRequestPayload & { user?: { id: number; role?: string; permissions?: string[] } }) => db.acceptRequest(requestId, memberId, userId, user),
    // start/complete are Member-default but act on a caller-supplied id — verify
    // the caller is a responder on (or has duty over) the request first.
    'request:start': async ({ requestId, userId, user }: StartRequestPayload) => {
        if (user) await db.assertRequestResponderOrDuty(requestId, user);
        return db.updateRequestStatus(requestId, ServiceRequestStatus.InProgress, userId, 'Mission started.', undefined, undefined);
    },
    'request:complete': async ({ requestId, report, userId, user }: CompleteRequestPayload) => {
        if (user) await db.assertRequestResponderOrDuty(requestId, user);
        return db.completeRequest(requestId, report, userId, user);
    },
    // cancel/rate act on a caller-supplied request id and are held by every
    // Client — verify ownership (or a duty permission) first so a Client cannot
    // cancel/rate another user's request.
    'request:cancel': async ({ requestId, userId, user }: CancelRequestPayload & { user?: { id: number; role?: string; permissions?: string[] } }) => {
        if (user) await db.assertRequestOwnerOrDuty(requestId, user);
        return db.updateRequestStatus(requestId, ServiceRequestStatus.Cancelled, userId, 'Request cancelled by client.', undefined, undefined);
    },
    'request:rate': async ({ requestId, rating, feedback, user }: RateRequestPayload & { user?: { id: number; role?: string; permissions?: string[] } }) => {
        if (user) await db.assertRequestOwnerOrDuty(requestId, user);
        return db.rateRequest(requestId, rating, feedback);
    },
    'request:add_note': ({ requestId, note, userId }: AddNotePayload) => db.addRequestNote(requestId, note, userId),
    'request:update_status': ({ requestId, status, notes, report, userId }: UpdateStatusPayload) => db.updateRequestStatus(requestId, status, userId, notes, report, undefined),
    'request:dispatch_members': ({ requestId, memberIds }: DispatchMembersPayload) => db.dispatchMembers(requestId, memberIds),
    'request:add_responder': ({ requestId, memberId }: ResponderPayload) => db.addResponderToRequest(requestId, memberId),
    'request:remove_responder': ({ requestId, memberId }: ResponderPayload) => db.removeResponderFromRequest(requestId, memberId),
    'request:set_lead': ({ requestId, memberId }: SetLeadPayload) => db.setLeadResponder(requestId, memberId),
    'request:add_party_member': ({ requestId, handle }: PartyMemberPayload) => db.addRequestPartyMember(requestId, handle),
    'request:remove_party_member': ({ requestId, handle }: PartyMemberPayload) => db.removeRequestPartyMember(requestId, handle),
    'request:refuse': ({ requestId, notes, userId }: RefuseRequestPayload) => db.updateRequestStatus(requestId, ServiceRequestStatus.Refused, userId, notes, undefined, undefined),
    'request:delete': ({ requestId }: DeleteRequestPayload) => db.deleteServiceRequest(requestId),
    'admin:delete_request': ({ requestId }: DeleteRequestPayload) => db.deleteServiceRequest(requestId),
};
