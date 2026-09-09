
import * as db from '../../lib/db.js';
import * as ai from '../../lib/ai.js';
import * as discord from '../../lib/discord.js';
import { sendPushToStaff } from '../../lib/push.js';
import { assertAiRateLimit } from '../../lib/aiRateLimit.js';
import { IntelThreatLevel } from '../../types.js';
import type {
    IntelBulletin,
    IntelSubjectType,
    DossierData,
    DiscordConfig,
    BrandingConfig,
} from '../../types.js';
import { log as baseLog } from '../../lib/log.js';

const log = baseLog.child({ module: 'actions.intel' });

// The org settings rows we read for bulletin notifications. Both values are
// stored as JSON blobs keyed by settings.key.
interface IntelNotificationSettings {
    discordConfig?: DiscordConfig;
    brandingConfig?: BrandingConfig;
}

// Minimal shape of a Discord embed used for the bulletin notification.
interface DiscordEmbedField {
    name: string;
    value: string;
    inline?: boolean;
}
interface DiscordEmbed {
    title: string;
    description: string;
    color: number;
    fields: DiscordEmbedField[];
    timestamp: string;
    footer: {
        text: string;
        icon_url?: string;
    };
}

// --- Payload interfaces (dispatcher types handlers as (payload: any, ...)) ---

// The dispatcher injects the authenticated user onto every payload. Intel reads
// use it for server-side clearance/limiting-marker filtering.
// `role` is deliberately absent: it is the NAME-derived display tier and must not
// be passable into a clearance or duty decision. `isSystemAdmin` is the stamped
// role IDENTITY the clearance module reads (lib/db/adminIdentity.ts).
type ActorUser = { user?: { id?: number; clearanceLevel?: { level?: number } | null; limitingMarkers?: unknown[]; isSystemAdmin?: boolean; permissions?: string[] } };

// The request-BOLA predicate, replicated from lib/db.ts canSeeAllRequests
// (private there, not cleanly importable). Holders of a request-duty permission
// (the dispatch-board audience) may see service-request bodies; everyone else may
// not. NO ROLE-NAME BYPASS — see the lib/db.ts original. Keep in lock-step with it;
// if it gains/loses a duty permission, mirror it.
function canSeeAllRequests(user?: ActorUser['user'] | null): boolean {
    if (!user) return false;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('request:dispatch') || perms.includes('request:triage') || perms.includes('request:accept');
}

interface WarrantCreatePayload {
    userId?: number;
    [key: string]: unknown;
}
interface WarrantUpdatePayload {
    warrantId: string;
    [key: string]: unknown;
}
interface WarrantIdPayload {
    warrantId: string;
}
interface WarrantGenerateReportPayload {
    warrantId: string;
    userId: number;
}
interface WarrantAddNotePayload {
    warrantId: string;
    content: string;
    userId: number;
}

interface IntelCreateReportPayload {
    [key: string]: unknown;
}
interface IntelUpdateReportPayload {
    id: string;
    updates: Record<string, unknown>;
}
interface IntelTargetPayload {
    targetId: string;
}
interface IntelRecentPayload {
    subjectType?: IntelSubjectType;
}
interface IntelListPayload {
    limit?: number;
    cursor?: string | null;
    threatLevel?: IntelThreatLevel;
    subjectType?: IntelSubjectType;
    tag?: string;
    warrantsOnly?: boolean;
    q?: string;
}
interface IntelDeleteReportPayload {
    reportId: string;
}
interface IntelSearchPayload {
    query: string;
    subjectType?: IntelSubjectType;
}
interface IntelUpdateAffiliationPayload {
    targetId: string;
    affiliatedOrg: string;
}
interface IntelBulkUpdateAffiliationPayload {
    reportIds: string[];
    affiliatedOrg: string;
}
interface IntelBulkAddTagsPayload {
    reportIds: string[];
    tags: string[];
}
interface IntelBulkDeletePayload {
    reportIds: string[];
}
interface IntelSyncFeedsPayload {
    force?: boolean;
}
interface IntelGenerateSummaryPayload {
    dossier: DossierData;
    userId?: number;
}

interface IntelCreateBulletinPayload {
    sharedWithAllies?: boolean;
    [key: string]: unknown;
}
interface BulletinIdPayload {
    bulletinId: string;
}

interface TrustedFeedFilterOptions {
    syncReports?: boolean;
    syncWarrants?: boolean;
    syncBulletins?: boolean;
    inboundMaxClearance?: number;
}
interface AdminAddTrustedFeedPayload {
    label: string;
    url: string;
    apiKey: string;
}
interface AdminTrustedFeedIdPayload {
    feedId: string;
}
interface AdminUpdateTrustedFeedPayload {
    feedId: string;
    updates: TrustedFeedFilterOptions;
}
interface AdminSyncWarrantsPayload {
    adminId: number;
}

/**
 * Sends a Discord embed notification for a new intel bulletin.
 */
async function notifyDiscordIntelBulletin(
    // The created bulletin is mapped to IntelBulletin; the legacy snake_case
    // `duration_minutes` read below is intentionally preserved (undefined at
    // runtime) so this types-only pass changes no behavior.
    bulletin: IntelBulletin & { duration_minutes?: number },
) {
    try {
        const { data: settingsData } = await db.supabase.from('settings').select('key, value').in('key', ['discordConfig', 'brandingConfig']);
        const settings: IntelNotificationSettings = settingsData?.reduce(
            (acc: IntelNotificationSettings, curr: { key: string; value: unknown }) =>
                ({ ...acc, [curr.key]: curr.value }),
            {} as IntelNotificationSettings,
        ) || {};

        const channelId = settings.discordConfig?.intelChannelId;
        const branding: BrandingConfig = settings.brandingConfig || { name: 'Organization', iconUrl: '' };

        if (!channelId) return;

        const threatColorMap: Record<string, number> = {
            [IntelThreatLevel.Critical]: 0xef4444, // red
            [IntelThreatLevel.High]: 0xf97316,     // orange
            [IntelThreatLevel.Medium]: 0xf59e0b,   // amber
            [IntelThreatLevel.Low]: 0x38bdf8,      // sky blue
        };

        const safeValue = (val: unknown, fallback = 'N/A', maxLength = 1024) => {
            if (val === null || val === undefined) return fallback;
            const str = String(val).trim();
            if (str.length === 0) return fallback;
            return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
        };

        // A Discord channel can be visible to members who lack the
        // clearance/markers required to read a CLASSIFIED bulletin in-app. Never
        // post the title/body/location of a classified bulletin to Discord — only
        // a generic "view it in the terminal" notice. Unclassified bulletins
        // (classificationLevel 0) post in full.
        const isClassified = (bulletin.classificationLevel ?? 0) > 0;
        const embed: DiscordEmbed = isClassified
            ? {
                title: '📡 CLASSIFIED INTEL BULLETIN',
                description: `A Level ${bulletin.classificationLevel} intel bulletin was posted. Access it in the operations terminal (clearance required).`,
                color: threatColorMap[bulletin.threatLevel] || 0x64748b,
                fields: [
                    { name: 'Classification', value: `Level ${bulletin.classificationLevel}`, inline: true },
                ],
                timestamp: new Date().toISOString(),
                footer: {
                    text: `${branding.name || 'Organization'} Intel Division`,
                    ...(branding.iconUrl && branding.iconUrl.startsWith('http') ? { icon_url: branding.iconUrl } : {}),
                },
            }
            : {
                title: `📡 INTEL BULLETIN: ${safeValue(bulletin.title, 'Untitled')}`,
                description: safeValue(bulletin.body, 'No details provided.'),
                color: threatColorMap[bulletin.threatLevel] || 0x64748b,
                fields: [
                    { name: 'Threat Level', value: safeValue(bulletin.threatLevel), inline: true },
                    ...(bulletin.location ? [{ name: 'Location', value: safeValue(bulletin.location), inline: true }] : []),
                    { name: 'Classification', value: 'Unclassified', inline: true },
                    { name: 'Duration', value: bulletin.duration_minutes === 0 ? 'Indefinite (Pinned)' : bulletin.expiresAt ? `Expires ${new Date(bulletin.expiresAt).toUTCString()}` : 'No expiry', inline: false },
                ],
                timestamp: new Date().toISOString(),
                footer: {
                    text: `${branding.name || 'Organization'} Intel Division`,
                    ...(branding.iconUrl && branding.iconUrl.startsWith('http') ? { icon_url: branding.iconUrl } : {}),
                },
            };

        await discord.sendDiscordChannelMessage(channelId, { embeds: [embed] });
    } catch (err) {
        log.error('intel bulletin discord notification failed', { err });
    }
}

export const intelActions = {
    // --- WARRANT ACTIONS ---
    'warrant:create': (payload: WarrantCreatePayload) => db.createWarrant(payload, payload.userId),
    'warrant:update': (payload: WarrantUpdatePayload) => db.updateWarrant(payload.warrantId, payload),
    'warrant:delete': ({ warrantId }: WarrantIdPayload) => db.deleteWarrant(warrantId),
    'warrant:generate_report': ({ warrantId, userId }: WarrantGenerateReportPayload) => {
        assertAiRateLimit(userId); // per-user Gemini throttle
        return db.generateReportFromWarrant(warrantId, userId);
    },
    // Append-only notes thread with author attribution.
    'warrant:add_note': ({ warrantId, content, userId }: WarrantAddNotePayload) => db.addWarrantNote(warrantId, content, userId),
    'warrant:get_notes': ({ warrantId }: WarrantIdPayload) => db.getWarrantNotes(warrantId),

    // --- INTEL ACTIONS ---
    'intel:create_report': (reportData: IntelCreateReportPayload) =>
        db.createIntelReport({ ...reportData }),
    'intel:update_report': ({ id, updates }: IntelUpdateReportPayload) => db.updateIntelReport(id, updates),
    'intel:get_reports': ({ targetId, user }: IntelTargetPayload & ActorUser) =>
        db.getIntelReportsForTarget(targetId).then((r) => db.filterIntelByClearance(r, user)),
    'intel:get_dossier': async ({ targetId, user }: IntelTargetPayload & ActorUser) => {
        // getDossier filters its derived surfaces (affiliates, operations,
        // cached AI summary) against the viewer server-side — never call it
        // without the authenticated user.
        const dossier = await db.getDossier(targetId, user);
        // Warrant/KOS records require warrant:view — they must NOT ride the
        // dossier under intel:view alone. Reports are filtered by clearance.
        // Permission only — no role-name bypass (see lib/db/intel.ts getIntelStats).
        const canViewWarrants = Array.isArray(user?.permissions) && user.permissions.includes('warrant:view');
        // dossier.requests are service_requests bodies (description/location/
        // threat/PII) matched by the subject's RSI handle. They MUST honour the
        // same request-BOLA gate the requests read-path enforces (lib/db.ts
        // canSeeAllRequests) — intel:view alone is NOT request-duty. Replicated
        // inline (canSeeAllRequests is private to lib/db.ts and not cleanly
        // importable); keep these predicates in sync.
        return {
            ...dossier,
            reports: db.filterIntelByClearance(dossier.reports, user),
            warrants: canViewWarrants ? dossier.warrants : [],
            requests: canSeeAllRequests(user) ? dossier.requests : [],
        };
    },
    'intel:get_recent': (payload: IntelRecentPayload & ActorUser) =>
        db.getRecentIntelReports(payload?.subjectType).then((r) => db.filterIntelByClearance(r, payload?.user)),
    'intel:list': async (payload: IntelListPayload & ActorUser) => {
        // warrantsOnly IS A WARRANT READ, filtered or not. The flag narrows the list to
        // subjects carrying an ACTIVE WARRANT, so the result set itself discloses which
        // targets are under warrant — the exact fact intel:get_dossier withholds two
        // handlers above unless the caller holds warrant:view. Reached through a filter
        // rather than a field, it bypassed that gate entirely: any intel:view holder
        // could set the flag and read the warrant list off the response.
        //
        // Dropped rather than refused, so the action keeps working for a caller who
        // simply is not entitled to that filter — they get the ordinary intel list.
        const canViewWarrants = Array.isArray(payload?.user?.permissions)
            && payload.user.permissions.includes('warrant:view');
        const result = await db.listIntelReports({
            limit: payload.limit,
            cursor: payload.cursor,
            threatLevel: payload.threatLevel,
            subjectType: payload.subjectType,
            tag: payload.tag,
            warrantsOnly: canViewWarrants ? payload.warrantsOnly : undefined,
            q: payload.q,
            viewer: payload?.user, // SQL clearance-level ceiling (markers still filtered below)
        });
        return { ...result, items: db.filterIntelByClearance(result.items, payload?.user) };
    },
    'intel:hub_stats': ({ user }: ActorUser) => db.getIntelHubStats(user),
    // 'intel:get_top_entities' removed — dead action calling a non-existent RPC
    // (get_intel_analytics), no client caller. See lib/db/intel.ts note.
    'intel:delete_report': ({ reportId }: IntelDeleteReportPayload) => db.deleteIntelReport(reportId),
    'intel:search': ({ query, subjectType, user }: IntelSearchPayload & ActorUser) =>
        db.searchIntelReports(query, subjectType).then((r) => db.filterIntelByClearance(r, user)),
    'intel:update_affiliation': ({ targetId, affiliatedOrg }: IntelUpdateAffiliationPayload) => db.updateIntelAffiliation(targetId, affiliatedOrg),
    'intel:bulk_update_affiliation': ({ reportIds, affiliatedOrg }: IntelBulkUpdateAffiliationPayload) => db.bulkUpdateIntelAffiliation(reportIds, affiliatedOrg),
    'intel:bulk_add_tags': ({ reportIds, tags }: IntelBulkAddTagsPayload) => db.bulkAddIntelTags(reportIds, tags),
    'intel:bulk_delete_reports': ({ reportIds }: IntelBulkDeletePayload) => db.bulkDeleteIntelReports(reportIds),
    // Pass the viewer so report counts / threat breakdown / warrant aggregation
    // are clearance-ceilinged server-side (mirrors intel:hub_stats →
    // getIntelHubStats). Dropping the user here leaks classified-activity volume
    // to any intel:view member.
    'intel:get_stats': ({ user }: ActorUser) => db.getIntelStats(user),
    'intel:sync_feeds': (payload: IntelSyncFeedsPayload) => db.syncTrustedFeeds(payload?.force),
    'intel:generate_summary': async ({ dossier, user }: IntelGenerateSummaryPayload & ActorUser) => {
        // Per-user throttle on the metered Gemini key.
        assertAiRateLimit(user?.id);
        // The client-supplied dossier is NOT trusted. generateDossierSummary
        // caches its result globally per target (dossier_summaries, keyed only by
        // target_id) and managers read it back — so an unprivileged caller could
        // forge the "official" AI synthesis. Refetch the clearance-filtered
        // dossier server-side from the target id, so the AI only ever sees data
        // the requester is cleared for and the cache cannot be poisoned. Gated at
        // intel:manage (the only population that can read the cached summary back).
        const targetId = typeof dossier?.targetId === 'string' ? dossier.targetId.trim() : '';
        if (!targetId) throw new Error('A target is required to generate a summary.');
        const fresh = await db.getDossier(targetId, user);
        return ai.generateDossierSummary(fresh);
    },

    // --- BULLETIN ACTIONS ---
    'intel:create_bulletin': async (payload: IntelCreateBulletinPayload) => {
        const bulletin = await db.createIntelBulletin(payload);
        try {
            // sendPushToStaff fans out to ALL staff with no clearance filter, and
            // push payloads surface on lock screens. Never put a classified
            // bulletin's title/body in the push — send a generic notice and let
            // the recipient open the clearance-gated terminal.
            const isClassified = (bulletin.classificationLevel ?? 0) > 0;
            await sendPushToStaff({
                title: isClassified ? 'New Classified Intel Bulletin' : `Intel Bulletin: ${bulletin.title}`,
                body: isClassified ? 'A classified bulletin was posted — view it in the terminal (clearance required).' : bulletin.body.substring(0, 120),
                tag: `bulletin-${bulletin.id}`,
                data: { type: 'bulletin', bulletinId: bulletin.id }
            });
        } catch (err) {
            log.error('bulletin push notification failed', { err });
        }
        // Discord notification (non-blocking)
        notifyDiscordIntelBulletin(bulletin).catch(err => {
            log.error('bulletin discord notification failed', { err });
        });
        return bulletin;
    },
    'intel:delete_bulletin': ({ bulletinId }: BulletinIdPayload) => db.deleteIntelBulletin(bulletinId),
    'intel:get_bulletins': ({ user }: ActorUser) =>
        db.getActiveBulletins().then((b) => db.filterIntelByClearance(b, user)),

    // --- ADMIN INTEL ---
    'admin:get_trusted_feeds': () => db.getTrustedFeeds(),
    'admin:add_trusted_feed': ({ label, url, apiKey }: AdminAddTrustedFeedPayload) => db.addTrustedFeed(label, url, apiKey),
    'admin:delete_trusted_feed': ({ feedId }: AdminTrustedFeedIdPayload) => db.deleteTrustedFeed(feedId),
    'admin:update_trusted_feed': ({ feedId, updates }: AdminUpdateTrustedFeedPayload) => db.updateTrustedFeed(feedId, updates),
    'admin:sync_warrants_to_reports': ({ adminId }: AdminSyncWarrantsPayload) => db.syncWarrantsToReports(adminId),
    'admin:deduplicate_warrants': () => db.deduplicateWarrants(),
    'admin:deduplicate_intel': () => db.deduplicateIntelReports(),
};
