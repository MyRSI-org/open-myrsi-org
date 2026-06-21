

import { WarrantStatus, HydratedIntelligenceReport, IntelBulletin,
    IntelSubjectType, IntelThreatLevel, DossierData, WarrantNote
} from '../../types.js';
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg } from './common.js';
import { requireUuid, escapeLikePattern } from '../pgrest.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { toHydratedWarrant, toHydratedIntelReport, toIntelBulletin, toMiniUser } from './mappers.js';
import { verifyApiKey, getPublicFeedData } from './system.js';
import { log as baseLog } from '../log.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { decryptSecret } from '../crypto.js';
import { filterByClearance, canViewAllClassifications, passesClearance, assertCanClassify, type ClearanceUser } from '../clearance.js';
import { canUserSeeOpInList, type OpViewer } from './ops.js';
import { ssrfSafeFetch } from '../ssrf.js';
import { getCachedAllianceSyncConfig, recordPeerFailure, recordPeerSuccess, setSyncAlert } from './allianceSyncState.js';
import type { Tables } from './rows.js';
export { toHydratedWarrant, toHydratedIntelReport, toIntelBulletin };

type IntelReportRow = Parameters<typeof toHydratedIntelReport>[0];
type IntelBulletinRow = Parameters<typeof toIntelBulletin>[0];
type WarrantNoteRow = Tables<'warrant_notes'> & { author?: Parameters<typeof toMiniUser>[0] };

const log = baseLog.child({ module: 'db.intel' });

// Clearance / limiting-marker filter for intel report/bulletin bodies, enforced
// server-side via the shared clearance util. intel:manage holders (and Admins)
// see all classifications.
export function filterIntelByClearance<T extends { classificationLevel?: number | null; limitingMarkers?: unknown[] }>(
    items: T[],
    user?: ClearanceUser | null,
): T[] {
    return filterByClearance(items, user, ['intel:manage']);
}

/** Warrant emits carry the affected id(s) so clients refetch one row
 *  (warrant_slice) instead of the whole 200-row list. Id-only payloads —
 *  the db-changes channel is anon-readable. */
function broadcastWarrantUpdate(payload?: { warrantId?: string; warrantIds?: string[] }) {
    broadcastToOrg('warrant_update', payload ?? {});
}

/** Intel emits carry a kind discriminator:
 *  - 'report': intel_reports changed → clients refetch the aggregate
 *    index/stats (intel_summary) + bump the paginated-feed version;
 *  - 'dossier': only a cached dossier summary changed (RPC-fetched on
 *    demand) → clients skip the refetch entirely.
 *  Kind-less payloads fall back to the full 'intel' refetch. */
function broadcastIntelUpdate(payload?: { kind: 'report' | 'dossier'; targetId?: string }) {
    broadcastToOrg('intel_update', payload ?? {});
}

// --- WARRANTS ---

export async function createWarrant(payload: Record<string, unknown>, userId?: number) {
    const targetRsiHandle = payload.targetRsiHandle as string;
    const reason = payload.reason as string;
    const issuer = userId || (payload.issuedById as number | undefined);
    const { data: created, error } = await supabase.from('warrants').insert({
        target_rsi_handle: targetRsiHandle,
        reason: reason,
        action: payload.action as string | undefined,
        uec_reward: payload.uecReward as number | undefined,
        status: payload.status as string | undefined,
        issued_by: issuer,
        notes: payload.notes as string | undefined
    }).select('id').single();

    handleSupabaseError({ error, message: 'Failed to create warrant' });

    if (payload.autoFileReport) {
        try {
            await createIntelReport({
                targetId: targetRsiHandle,
                subjectType: 'Person',
                threatLevel: 'High',
                tags: ['Caution Note'],
                summary: `[AUTOMATED REPORT FROM CAUTION NOTE] ${reason}`,
                evidenceUrls: [],
                createdById: issuer,
                classificationLevel: 0
            });
        } catch (err) {
            log.error('auto-file intel report for warrant failed', { targetRsiHandle, err });
        }
    }
    await broadcastWarrantUpdate(created?.id ? { warrantId: created.id } : undefined);
}

export async function updateWarrant(id: string, updates: Record<string, unknown>) {
    const inner = (updates.updates ?? {}) as {
        targetRsiHandle?: string;
        reason?: string;
        action?: string;
        uecReward?: number;
        status?: string;
        notes?: string;
    };
    const dbUpdates: Record<string, unknown> = { target_rsi_handle: inner.targetRsiHandle, reason: inner.reason, action: inner.action, uec_reward: inner.uecReward, status: inner.status, notes: inner.notes, updated_at: new Date().toISOString() };
    if (inner.status === WarrantStatus.Claimed) { dbUpdates.claimed_by = updates.claimedById as number | undefined; dbUpdates.claimed_at = new Date().toISOString(); }
    else if (inner.status === WarrantStatus.Active) { dbUpdates.claimed_by = null; dbUpdates.claimed_at = null; }

    const { error } = await supabase.from('warrants').update(dbUpdates)
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to update warrant' });
    await broadcastWarrantUpdate({ warrantId: id });
}

export async function deleteWarrant(warrantId: string) {
    const { error = null } = await supabase.from('warrants').delete()
        .eq('id', warrantId)
        ;
    handleSupabaseError({ error, message: 'Failed to delete warrant' });
    await broadcastWarrantUpdate({ warrantId });
}

export async function bulkDeleteWarrants(warrantIds: string[]) {
    await supabase.from('warrants').delete()
        .in('id', warrantIds)
        ;
    await broadcastWarrantUpdate({ warrantIds });
}

/** List-row select for warrants — shared by getWarrantsState (lib/db.ts) and
 *  the warrant_slice single-row fetch so the two shapes can never drift. */
export const WARRANT_SELECT = '*, issuedBy:users!warrants_issued_by_fkey(id, name, avatar_url, role_id), claimedBy:users!warrants_claimed_by_fkey(id, name, avatar_url), feed:alliance_peers(id, label)';

/**
 * Single-warrant fetch in the LIST row shape. Backs the realtime
 * `warrant_slice` query subset: warrant_update broadcasts carry the
 * warrantId(s) and the client refetches ONLY those rows. Returns null when
 * absent (deleted → client removes the row). THROWS on query errors so a
 * transient DB blip can never masquerade as "warrant deleted".
 */
export async function getWarrantByIdHydrated(warrantId: string) {
    const { data, error } = await supabase.from('warrants')
        .select(WARRANT_SELECT)
        .eq('id', warrantId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get warrant slice' });
    return data ? toHydratedWarrant(data) : null;
}

// --- WARRANT NOTES (append-only thread) ---
// Each call appends a new row to warrant_notes and mirrors the latest content
// onto warrants.notes so existing list-view callers (which only read the
// cached column) continue to work without changes. PG 42P01 (table missing)
// triggers a soft-fail with a warning so DBs that haven't run
// migrations/add-warrant-notes.sql still let warrants update.

export async function addWarrantNote(warrantId: string, content: string, authorId: number) {
    const trimmed = (content || '').trim();
    if (!trimmed) throw new Error('Warrant note content is required');

    // Verify the warrant exists before inserting.
    const { count } = await supabase
        .from('warrants')
        .select('id', { count: 'exact', head: true })
        .eq('id', warrantId)
        ;
    if (!count) throw new Error('Warrant not found');

    const { error } = await supabase.from('warrant_notes').insert({
        warrant_id: warrantId,
        author_id: authorId,
        content: trimmed,
    });
    if (error?.code === '42P01') {
        // Table doesn't exist yet — log and continue without the thread row.
        // The legacy notes column update below still happens.
        log.warn('warrant_notes table missing — note saved to legacy column only; run migrations/add-warrant-notes.sql', { warrantId });
    } else {
        handleSupabaseError({ error, message: 'Failed to add warrant note' });
    }

    await supabase.from('warrants').update({
        notes: trimmed,
        updated_at: new Date().toISOString(),
    }).eq('id', warrantId);

    await broadcastWarrantUpdate({ warrantId });
}

export async function getWarrantNotes(warrantId: string): Promise<WarrantNote[]> {
    // Confirm the warrant exists before disclosing notes.
    const { count } = await supabase
        .from('warrants')
        .select('id', { count: 'exact', head: true })
        .eq('id', warrantId)
        ;
    if (!count) return [];

    const { data, error } = await supabase
        .from('warrant_notes')
        .select('*, author:users!warrant_notes_author_id_fkey(id, name, avatar_url, role_id)')
        .eq('warrant_id', warrantId)
        .order('created_at', { ascending: false });
    if (error?.code === '42P01') {
        // Pre-migration tenant — return empty thread; UI shows the legacy
        // notes from the warrant row itself.
        return [];
    }
    handleSupabaseError({ error, message: 'Failed to load warrant notes' });
    return ((data || []) as unknown as WarrantNoteRow[]).map((row) => ({
        id: row.id,
        warrantId: row.warrant_id,
        authorId: row.author_id ?? null,
        content: row.content,
        createdAt: row.created_at,
        author: row.author ? toMiniUser(row.author) : undefined,
    }));
}

export async function generateReportFromWarrant(warrantId: string, userId: number) {
    const { data: warrant } = await supabase.from('warrants').select('*')
        .eq('id', warrantId)

        .single();
    if (warrant) {
        await createIntelReport({
            targetId: warrant.target_rsi_handle,
            subjectType: 'Person',
            threatLevel: 'High',
            tags: ['Caution Note'],
            summary: `[AUTOMATED REPORT FROM CAUTION NOTE] ${warrant.reason}`,
            evidenceUrls: [],
            createdById: userId,
            classificationLevel: 0
        });
    }
}

// --- INTEL & DOSSIERS ---

export async function createIntelReport(reportData: Record<string, unknown>) {
    const markerIds = reportData.markerIds as number[] | undefined;
    // intel:create (default Member) is NOT a clearance bypass. The author may not
    // label a report above their own clearance or apply a marker they don't hold;
    // intel:manage holders (read-side bypass) classify freely.
    assertCanClassify(reportData.user as ClearanceUser | undefined, (reportData.classificationLevel as number | undefined) ?? 0, markerIds, ['intel:manage']);
    const { data, error } = await supabase.from('intel_reports').insert({
        target_id: stripHtmlSingleLine(reportData.targetId as string, 200),
        subject_type: reportData.subjectType as string | undefined,
        threat_level: (reportData.threat_level as string | undefined) || (reportData.threatLevel as string | undefined),
        tags: reportData.tags as string[] | undefined,
        summary: stripHtml(reportData.summary as string | undefined, 8000),
        evidence_urls: reportData.evidenceUrls as string[] | undefined,
        created_by_id: reportData.createdById as number | null | undefined,
        affiliated_org: stripHtmlSingleLine(reportData.affiliatedOrg as string | undefined, 200) || null,
        classification_level: (reportData.classificationLevel as number | undefined) || 0
    }).select().single();

    handleSupabaseError({ error, message: 'Failed to create intel report' });

    if (data && markerIds && markerIds.length > 0) {
        // Verify the supplied marker IDs all belong to this org — without it,
        // a caller could attach another tenant's marker definitions to their
        // own report.
        const { data: validMarkers } = await supabase.from('security_limiting_markers')
            .select('id')
            .in('id', markerIds)
            ;
        if (!validMarkers || validMarkers.length !== markerIds.length) {
            throw new Error('One or more limiting markers are not valid for this organization.');
        }
        const markers = markerIds.map((mid) => ({ report_id: data.id, marker_id: mid }));
        await supabase.from('intel_report_limiting_markers').insert(markers);
    }
    await broadcastIntelUpdate({ kind: 'report' });
}

export async function updateIntelReport(id: string, updates: Record<string, unknown>) {
    // Verify existence before any mutation.
    const { data: existing } = await supabase.from('intel_reports').select('id')
        .eq('id', id)

        .maybeSingle();
    if (!existing) throw new Error('Intel report not found');

    const markerIds = updates.markerIds as number[] | undefined;
    const { error } = await supabase.from('intel_reports').update({
        threat_level: updates.threatLevel as string | undefined,
        tags: updates.tags as string[] | undefined,
        summary: stripHtml(updates.summary, 8000),
        evidence_urls: updates.evidenceUrls as string[] | undefined,
        subject_type: updates.subjectType as string | undefined,
        affiliated_org: stripHtmlSingleLine(updates.affiliatedOrg, 200) || null,
        classification_level: (updates.classificationLevel as number | undefined) || 0
    }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update intel report' });

    await supabase.from('intel_report_limiting_markers').delete().eq('report_id', id);
    if (markerIds && markerIds.length > 0) {
        const markers = markerIds.map((mid) => ({ report_id: id, marker_id: mid }));
        await supabase.from('intel_report_limiting_markers').insert(markers);
    }
    await broadcastIntelUpdate({ kind: 'report' });
}

// Optimized: Fetch basic user data for creator
export async function getIntelReportsForTarget(targetId: string): Promise<HydratedIntelligenceReport[]> {
    let query = supabase.from('intel_reports')
        .select('*, createdBy:users!intel_reports_created_by_id_fkey(id, name, avatar_url, role_id), intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .ilike('target_id', targetId);

    query = query.order('created_at', { ascending: false });
    const data = await safeFetch<IntelReportRow[]>(query, [], 'Failed to get reports');
    return data.map(toHydratedIntelReport);
}

// Project the PostgREST marker-junction embed ([{ marker: {id,name,code} }]) to
// the scalar marker list passesClearance expects — the same shape
// assertOpVisibleToUser uses.
function embeddedMarkers(rows?: { marker?: unknown }[] | null): unknown[] {
    return (rows || []).map((m) => m.marker).filter(Boolean);
}

// `viewer` is the authenticated caller; every derived surface in the dossier
// (affiliates, operations, cached AI summary) is clearance-filtered server-side
// against it. A missing viewer fails closed (treated as clearance 0, no markers,
// no bypass).
export async function getDossier(targetId: string, viewer?: OpViewer | null): Promise<DossierData> {
    const userQuery = supabase.from('users').select('id').ilike('rsi_handle', targetId);
    const { data: targetUser } = await userQuery.maybeSingle();
    const targetUserId = targetUser?.id;

    // 1. Determine Subject Type by looking at latest reports
    const latestQuery = supabase.from('intel_reports')
        .select('subject_type')
        .ilike('target_id', targetId)
        .order('created_at', { ascending: false })
        .limit(1);
    const { data: latestReport } = await latestQuery.maybeSingle();

    const isOrg = latestReport?.subject_type === IntelSubjectType.Organization;

    // 2. Identify and fetch report data based on type
    let reportsQuery = supabase.from('intel_reports')
        .select('*, createdBy:users!intel_reports_created_by_id_fkey(id, name, avatar_url, role_id), intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .order('created_at', { ascending: false });

    const affiliates: { targetId: string, threatLevel: IntelThreatLevel, lastReportedAt: string }[] = [];
    // Declared at outer scope so the post-branch org-report merge can see it.
    const orgSet = new Set<string>();

    if (isOrg) {
        // --- ORGANIZATION DOSSIER ---
        // Fetch reports for the Org
        reportsQuery = reportsQuery.ilike('target_id', targetId);

        // Populate affiliates with unique people in this org
        const membersQuery = supabase.from('intel_reports')
            .select('target_id, threat_level, created_at, classification_level, intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
            .ilike('affiliated_org', targetId)
            .order('created_at', { ascending: false });
        const { data: members } = await membersQuery;

        const memberMap = new Map<string, { targetId: string; threatLevel: IntelThreatLevel; lastReportedAt: string }>();
        members?.forEach(m => {
            // Affiliates are synthesized from intel_reports rows — apply the same
            // clearance/marker predicate as the report bodies so a level-0 viewer
            // doesn't learn compartmented affiliations + threat levels.
            if (!passesClearance(viewer, m.classification_level, embeddedMarkers(m.intel_report_limiting_markers), ['intel:manage'])) return;
            const handle = m.target_id.toLowerCase();
            if (!memberMap.has(handle)) {
                memberMap.set(handle, {
                    targetId: m.target_id,
                    threatLevel: m.threat_level as IntelThreatLevel,
                    lastReportedAt: m.created_at
                });
            }
        });
        affiliates.push(...memberMap.values());

    } else {
        // --- PERSON DOSSIER ---
        // Identify organization affiliation from their reports
        const primaryQuery = supabase.from('intel_reports')
            .select('affiliated_org, threat_level, created_at, classification_level, intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
            .ilike('target_id', targetId);
        const { data: primaryReports } = await primaryQuery;

        const orgMetaMap = new Map<string, { level: IntelThreatLevel, date: string }>();

        primaryReports?.forEach(r => {
            // Same clearance/marker predicate as the report bodies (see org branch).
            // Also scopes orgSet — and therefore the org-report merge below — to
            // orgs the viewer may legitimately learn about.
            if (!passesClearance(viewer, r.classification_level, embeddedMarkers(r.intel_report_limiting_markers), ['intel:manage'])) return;
            if (r.affiliated_org) {
                const org = r.affiliated_org.toUpperCase();
                orgSet.add(org);
                if (!orgMetaMap.has(org) || new Date(r.created_at) > new Date(orgMetaMap.get(org)!.date)) {
                    orgMetaMap.set(org, { level: r.threat_level as IntelThreatLevel, date: r.created_at });
                }
            }
        });

        // Combined Feed: Target reports + Org reports.
        // Use parameterized .ilike() (Supabase escapes the value) for the primary target.
        // Org-affiliated reports are fetched via a parallel query below and merged —
        // the previous .or() with sanitized string interpolation was fragile.
        reportsQuery = reportsQuery.ilike('target_id', targetId);

        // Affiliates are the Orgs they belong to
        orgMetaMap.forEach((meta, name) => {
            affiliates.push({
                targetId: name,
                threatLevel: meta.level,
                lastReportedAt: meta.date
            });
        });
    }

    // For PERSON dossiers, also fetch reports where target_id matches any of the
    // person's affiliated orgs. One parameterized .ilike per org — safe against
    // filter-syntax injection, and case-insensitive like the original behavior.
    const orgReportPromises: Promise<IntelReportRow[]>[] = [];
    if (!isOrg) {
        for (const orgName of orgSet) {
            const q = supabase.from('intel_reports')
                .select('*, createdBy:users!intel_reports_created_by_id_fkey(id, name, avatar_url, role_id), intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
                .ilike('target_id', orgName);
            orgReportPromises.push(safeFetch<IntelReportRow[]>(q, [], 'Failed to get org-affiliated reports'));
        }
    }

    // owner_id + clearance_level + limiting markers are selected solely to feed
    // canUserSeeOpInList below — they are NOT part of the mapped projection
    // returned to the browser.
    const opsQuery = targetUserId
        ? safeFetch((() => {
            const q = supabase.from('operations').select('id, name, status, type, description, created_at, owner_id, clearance_level, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code)), participants:operation_participants!inner(user_id)').eq('participants.user_id', targetUserId);
            return q;
        })(), [], 'Failed to get operations')
        : Promise.resolve([]);

    // Build org-scoped warrant query
    const warrantQuery = supabase.from('warrants').select('*, issuedBy:users!warrants_issued_by_fkey(id, name, avatar_url, role_id), claimedBy:users!warrants_claimed_by_fkey(id, name, avatar_url, role_id), feed:alliance_peers(id, label)').ilike('target_rsi_handle', targetId);

    // Build org-scoped requests query
    const requestsQuery = supabase.from('service_requests').select('id, client_id, unregistered_client_rsi_handle, service_type, location, description, status, urgency, threat_level, created_at, updated_at').ilike('unregistered_client_rsi_handle', targetId);

    // The cached AI summary is synthesized from the FULL dossier (including
    // above-clearance reports/ops/affiliates) and cached globally per target —
    // opaque prose no field-level filter can redact. Serve it only to the
    // population that could regenerate it at full fidelity; everyone else gets no
    // summary (fail closed, query skipped entirely).
    const canSeeCachedSummary = canViewAllClassifications(viewer, ['intel:manage']);
    const summaryPromise = canSeeCachedSummary
        ? safeFetch<{ summary: string, generated_at: string } | null>(
            supabase.from('dossier_summaries').select('summary, generated_at').eq('target_id', targetId).maybeSingle(),
            null, 'Failed to get summary')
        : Promise.resolve(null);

    const [reports, warrants, requests, opsData, summary, orgReportArrays] = await Promise.all([
        safeFetch(reportsQuery, [], 'Failed to get reports'),
        isOrg ? Promise.resolve([]) : safeFetch(warrantQuery, [], 'Failed to get warrants'),
        isOrg ? Promise.resolve([]) : safeFetch(requestsQuery, [], 'Failed to get requests'),
        isOrg ? Promise.resolve([]) : opsQuery,
        summaryPromise,
        Promise.all(orgReportPromises),
    ]);

    // Merge org-affiliated reports into primary reports (dedupe by id).
    const mergedReports: IntelReportRow[] = reports as unknown as IntelReportRow[];
    if (orgReportArrays.length > 0) {
        const seen = new Set<string>((mergedReports || []).map((r) => r.id));
        for (const batch of orgReportArrays) {
            for (const r of batch) {
                if (!seen.has(r.id)) {
                    seen.add(r.id);
                    mergedReports.push(r);
                }
            }
        }
        mergedReports.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    // Map raw service_request rows to camelCase for the frontend
    const mappedRequests = isOrg ? [] : ((requests || []) as unknown as Tables<'service_requests'>[]).map((r) => ({
        id: r.id,
        clientId: r.client_id,
        unregisteredClientRsiHandle: r.unregistered_client_rsi_handle,
        serviceType: r.service_type,
        location: r.location,
        description: r.description,
        status: r.status,
        urgency: r.urgency,
        threatLevel: r.threat_level,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        statusHistory: []
    }));

    // Mirror the ops list/detail gate (canUserSeeOpInList) before mapping so the
    // dossier doesn't leak compartmented op existence, status and tactical
    // description to any intel:view holder. The gate fields
    // (owner_id/clearance_level/markers) are consumed here and dropped from the
    // mapped projection.
    type DossierOpRow = Tables<'operations'> & { limiting_markers?: { marker?: unknown }[] };
    const mappedOperations = ((opsData || []) as unknown as DossierOpRow[])
        .filter((op) => !!viewer && canUserSeeOpInList(viewer, {
            ownerId: op.owner_id,
            clearanceLevel: op.clearance_level ?? 0,
            limitingMarkers: embeddedMarkers(op.limiting_markers),
        }))
        .map((op) => ({
            id: op.id,
            name: op.name,
            status: op.status,
            type: op.type,
            description: op.description,
            createdAt: op.created_at
        }));

    return {
        targetId,
        reports: (mergedReports || []).map(toHydratedIntelReport),
        warrants: (warrants || []).map(toHydratedWarrant),
        requests: mappedRequests,
        operations: mappedOperations,
        affiliates: affiliates,
        cachedSummary: summary?.summary,
        cachedSummaryDate: summary?.generated_at
    };
}

/**
 * Small fixed-page widget endpoint exposed via `intel:get_recent`.
 * The hub uses {@link listIntelReports} for cursor-paginated browsing —
 * do NOT use this function to back a "show all" UI; it caps at 50 rows.
 */
export async function getRecentIntelReports(subjectType?: string, limit = 50): Promise<HydratedIntelligenceReport[]> {
    let query = supabase.from('intel_reports')
        .select('*, createdBy:users!intel_reports_created_by_id_fkey(id, name), feed:alliance_peers(label), intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))');

    const cappedLimit = Math.min(Math.max(1, limit), 100);
    query = query.order('created_at', { ascending: false })
        .limit(cappedLimit);
    if (subjectType) query = query.eq('subject_type', subjectType);
    const data = await safeFetch<IntelReportRow[]>(query, [], 'Failed to get recent intel');
    return data.map(toHydratedIntelReport);
}

const INTEL_REPORT_SELECT = '*, createdBy:users!intel_reports_created_by_id_fkey(id, name, avatar_url, role_id), feed:alliance_peers(label), intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))';

const THREAT_RANK: Record<string, number> = {
    [IntelThreatLevel.Critical]: 4,
    [IntelThreatLevel.High]: 3,
    [IntelThreatLevel.Medium]: 2,
    [IntelThreatLevel.Low]: 1,
    [IntelThreatLevel.None]: 0,
};

export interface ListIntelReportsArgs {
    limit?: number;
    cursor?: string | null;
    threatLevel?: IntelThreatLevel;
    subjectType?: IntelSubjectType;
    tag?: string;
    warrantsOnly?: boolean;
    q?: string;
    // The viewer, so the SQL query can apply a clearance-LEVEL ceiling — keeps
    // page counts / cursors from reflecting above-level rows (volume inference).
    // Per-row MARKER filtering still happens in the caller (filterIntelByClearance).
    // intel:manage / Admin see all (no ceiling).
    viewer?: ClearanceUser | null;
}

export interface ListIntelReportsResult {
    items: HydratedIntelligenceReport[];
    nextCursor: string | null;
    hasMore: boolean;
}

function encodeIntelCursor(createdAt: string, id: string): string {
    return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeIntelCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
    if (!cursor || typeof cursor !== 'string') return null;
    try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const idx = decoded.indexOf('|');
        if (idx < 0) return null;
        const createdAt = decoded.slice(0, idx);
        const id = decoded.slice(idx + 1);
        if (!createdAt || !id) return null;
        // Light validation — must look like an ISO date.
        if (Number.isNaN(Date.parse(createdAt))) return null;
        return { createdAt, id };
    } catch {
        return null;
    }
}

/**
 * Cursor-paginated intel feed for the hub. Server-side filters and search;
 * keyset pagination on (created_at DESC, id DESC) — backed by
 * idx_intel_reports_org_created_id (migrations/add-intel-pagination-index.sql).
 *
 * A clearance-LEVEL ceiling is applied in SQL when `viewer` is supplied
 * (non-manager), so hasMore/nextCursor reflect only rows at/below the viewer's
 * level (no volume inference of higher-classified rows). The caller (intel:list)
 * STILL re-applies filterIntelByClearance for the per-row limiting MARKERS (a
 * junction the keyset query can't cheaply filter). Do NOT remove the caller's
 * filter — and never expose this function's rows directly without it.
 */
export async function listIntelReports(args: ListIntelReportsArgs): Promise<ListIntelReportsResult> {
    const limit = Math.min(Math.max(1, args.limit ?? 50), 100);
    const fetchSize = limit + 1;
    const cursor = decodeIntelCursor(args.cursor);
    const hasSearch = typeof args.q === 'string' && args.q.trim().length > 0;

    // warrantsOnly: pre-resolve active warrant target handles for this org
    // and short-circuit if there are none (avoids `IN ()` quirk in PostgREST).
    let warrantTargets: string[] | null = null;
    if (args.warrantsOnly === true) {
        const { data: warrantRows } = await supabase.from('warrants')
            .select('target_rsi_handle')
            
            .in('status', [WarrantStatus.Active, WarrantStatus.Standing]);
        const set = new Set<string>();
        for (const row of (warrantRows || [])) {
            if (row?.target_rsi_handle) set.add(String(row.target_rsi_handle).toLowerCase());
        }
        warrantTargets = Array.from(set);
        if (warrantTargets.length === 0) {
            return { items: [], nextCursor: null, hasMore: false };
        }
    }

    let query = supabase.from('intel_reports')
        .select(INTEL_REPORT_SELECT)
        
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });

    // --- Filters (always ANDed, safe to chain on top of .or()) ---
    if (args.threatLevel) query = query.eq('threat_level', args.threatLevel);
    if (args.subjectType) query = query.eq('subject_type', args.subjectType);
    if (args.tag) query = query.contains('tags', [args.tag]);
    if (warrantTargets) query = query.in('target_id', warrantTargets);
    // Clearance-LEVEL ceiling so pagination doesn't leak the existence/volume of
    // higher-classified reports. Managers/Admins see all.
    if (args.viewer && !canViewAllClassifications(args.viewer, ['intel:manage'])) {
        query = query.lte('classification_level', args.viewer.clearanceLevel?.level ?? 0);
    }

    // --- Search disjunction (re-uses safe regex from searchIntelReports) ---
    if (hasSearch) {
        const safeQuery = String(args.q)
            .replace(/[^a-zA-Z0-9 _-]/g, '')
            .trim()
            .slice(0, 100);
        if (!safeQuery) {
            // Search collapsed to empty after sanitize → return empty (caller asked for q).
            return { items: [], nextCursor: null, hasMore: false };
        }
        query = query.or(`target_id.ilike.%${safeQuery}%,summary.ilike.%${safeQuery}%,tags.cs.{${safeQuery}}`);
    }

    // --- Cursor ---
    // No-search: use proper keyset .or() predicate. Search: .or() is consumed,
    // fall back to inclusive .lte() + JS-side discard of the boundary id.
    let overscan = 0;
    if (cursor) {
        // Harden against PostgREST .or() filter injection: the cursor fields are
        // interpolated into the keyset predicate below, so validate them strictly.
        // intel_reports.id is a UUID; created_at is an ISO timestamp.
        requireUuid(cursor.id);
        if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/.test(String(cursor.createdAt))) {
            throw new Error('Invalid cursor timestamp');
        }
        if (hasSearch) {
            query = query.lte('created_at', cursor.createdAt);
            overscan = 5;
        } else {
            query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
        }
    }

    query = query.limit(fetchSize + overscan);

    const data = await safeFetch<IntelReportRow[]>(query, [], 'Failed to list intel reports');
    let rows = data || [];

    // Drop boundary rows when the search-cursor path was used.
    if (cursor && hasSearch) {
        rows = rows.filter((r) => {
            if (r.created_at < cursor.createdAt) return true;
            if (r.created_at === cursor.createdAt && String(r.id) < cursor.id) return true;
            return false;
        });
    }

    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);

    const items = rows.map(toHydratedIntelReport);
    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeIntelCursor(last.created_at, String(last.id)) : null;

    return { items, nextCursor, hasMore };
}

export interface IntelHubStats {
    totalReports: number;
    criticalCount: number;   // threat_level IN ('Critical','High')
    recentCount7d: number;
}

/**
 * Aggregate intel counters for the hub hero stats. Org-wide; not clearance-filtered
 * (today's pre-fix UI numbers weren't either, and a clearance-aware count would
 * require a per-user join over every report — too expensive on the hot read path).
 */
export async function getIntelHubStats(user?: ClearanceUser | null): Promise<IntelHubStats> {
    // Counts are clearance-ceilinged — a low-clearance viewer's stats must not
    // include reports they cannot read (the count itself reveals classified
    // activity volume). Admin / intel:manage see all.
    const maxLevel = canViewAllClassifications(user, ['intel:manage'])
        ? null
        : (user?.clearanceLevel?.level ?? 0);
    const base = () => {
        let q = supabase.from('intel_reports').select('id', { count: 'exact', head: true });
        if (maxLevel !== null) q = q.lte('classification_level', maxLevel);
        return q;
    };

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [totalRes, criticalRes, recentRes] = await Promise.all([
        base(),
        base().in('threat_level', [IntelThreatLevel.Critical, IntelThreatLevel.High]),
        base().gte('created_at', sevenDaysAgo),
    ]);
    return {
        totalReports: totalRes.count ?? 0,
        criticalCount: criticalRes.count ?? 0,
        recentCount7d: recentRes.count ?? 0,
    };
}

export interface IntelTargetIndexEntry {
    targetId: string;
    threatLevel: IntelThreatLevel;
}

/**
 * One entry per distinct target_id (case-insensitive), holding the highest
 * known threat level seen for that target. Powers cross-component lookups
 * (e.g. RequestCard's threat pill) without shipping the full report set.
 *
 * Scans the newest 20K rows — covers practically every active target without
 * an RPC. Result deduped + capped at 5000 entries (warns if truncated).
 */
export async function getIntelTargetIndex(user?: ClearanceUser | null): Promise<IntelTargetIndexEntry[]> {
    // The index reveals WHICH targets are under surveillance and at what threat
    // level — the exact metadata the clearance system compartmentalises. A viewer
    // must only see index entries derived from reports they could read:
    // classification ceiling in SQL, limiting-marker exclusion per row below.
    // Admin / intel:manage see the full index.
    const seeAll = canViewAllClassifications(user, ['intel:manage']);
    let query = supabase.from('intel_reports')
        .select('target_id, threat_level, classification_level, intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .order('created_at', { ascending: false })
        .limit(20000);
    if (!seeAll) {
        query = query.lte('classification_level', user?.clearanceLevel?.level ?? 0);
    }
    const { data } = await query;

    const best = new Map<string, IntelTargetIndexEntry>();
    for (const row of (data || []) as Array<{ target_id?: string; threat_level?: string; classification_level?: number | null; intel_report_limiting_markers?: Array<{ marker?: unknown }> | null }>) {
        const targetId = String(row?.target_id || '').trim();
        if (!targetId) continue;
        if (!seeAll) {
            const markers = (row.intel_report_limiting_markers || []).map((m) => m.marker).filter(Boolean);
            if (!passesClearance(user, row.classification_level ?? 0, markers, ['intel:manage'])) continue;
        }
        const threat = String(row?.threat_level || IntelThreatLevel.None) as IntelThreatLevel;
        if (threat === IntelThreatLevel.None) continue;
        const key = targetId.toLowerCase();
        const existing = best.get(key);
        if (!existing || (THREAT_RANK[threat] ?? 0) > (THREAT_RANK[existing.threatLevel] ?? 0)) {
            best.set(key, { targetId, threatLevel: threat });
        }
    }

    const entries = Array.from(best.values());
    if (entries.length > 5000) {
        log.warn('intel target index truncated to 5000', { distinctTargets: entries.length });
        return entries.slice(0, 5000);
    }
    return entries;
}

// getIntelAnalytics / the 'intel:get_top_entities' action were removed — they
// called a Postgres RPC (get_intel_analytics) that does not exist in schema.sql
// and had no client caller. Re-add the action AND the function together if an
// intel-analytics widget is built.

export async function updateIntelAffiliation(targetId: string, affiliatedOrg: string) {
    // Escape LIKE metacharacters so targetId='%' can't mass-overwrite affiliation
    // across every report; clamp affiliated_org like the create path (no raw store).
    const { error } = await supabase.from('intel_reports')
        .update({ affiliated_org: stripHtmlSingleLine(affiliatedOrg, 200) || null })
        .ilike('target_id', escapeLikePattern(targetId))
        ;
    handleSupabaseError({ error, message: 'Failed to update affiliation' });
    await broadcastIntelUpdate({ kind: 'report' });
}

// Intel bulk mutations accept a client-supplied reportIds array. Cap it so a
// single RPC can't fan out an unbounded write/realtime amplification (oversized
// `.in()` predicates, N parallel per-row writes in bulkAddIntelTags). Reject
// (fail closed) rather than silently truncate — a truncated bulk op would
// partially apply with no signal to the caller. The selection UI operates on
// screenfuls of rows, so this ceiling is well above any legitimate batch.
const MAX_BULK_REPORT_IDS = 1000;
function assertBulkReportIds(reportIds: unknown): asserts reportIds is string[] {
    if (!Array.isArray(reportIds)) throw new Error('reportIds must be an array');
    if (reportIds.length > MAX_BULK_REPORT_IDS) {
        throw new Error(`Too many reports in bulk operation (${reportIds.length}; max ${MAX_BULK_REPORT_IDS}).`);
    }
}

export async function bulkUpdateIntelAffiliation(reportIds: string[], affiliatedOrg: string) {
    assertBulkReportIds(reportIds);
    const { error = null } = await supabase.from('intel_reports').update({ affiliated_org: affiliatedOrg })
        .in('id', reportIds)
        ;
    handleSupabaseError({ error, message: 'Bulk update failed' });
    await broadcastIntelUpdate({ kind: 'report' });
}

export async function bulkAddIntelTags(reportIds: string[], tags: string[]) {
    assertBulkReportIds(reportIds);
    if (!reportIds.length) return;
    // Batched: one read of all rows' current tags, then concurrent per-row writes.
    // Tags differ per row (merge+dedupe against each row's existing set) so a single
    // bulk UPDATE can't be used — but this collapses 2N sequential round-trips to
    // 1 read + N parallel writes. Missing ids are simply absent from the read
    // (matches the old `if (!data) continue` skip).
    const { data: rows } = await supabase.from('intel_reports').select('id, tags').in('id', reportIds);
    await Promise.all((rows || []).map((row) => {
        const newTags = Array.from(new Set([...(row.tags || []), ...tags]));
        return supabase.from('intel_reports').update({ tags: newTags }).eq('id', row.id);
    }));
    await broadcastIntelUpdate({ kind: 'report' });
}

export async function bulkDeleteIntelReports(reportIds: string[]) {
    assertBulkReportIds(reportIds);
    await supabase.from('intel_reports').delete()
        .in('id', reportIds)
        ;
    await broadcastIntelUpdate({ kind: 'report' });
}

export async function deleteIntelReport(id: string) {
    await supabase.from('intel_reports').delete()
        .eq('id', id)
        ;
    await broadcastIntelUpdate({ kind: 'report' });
}

export async function searchIntelReports(query: string, subjectType?: string): Promise<HydratedIntelligenceReport[]> {
    // Strict allowlist: alphanumerics, space, underscore, hyphen. Anything else
    // could let a crafted query break out of the PostgREST filter string and
    // inject extra OR conditions (e.g. `}},target_id.eq.<victim>`).
    const safeQuery = (typeof query === 'string' ? query : '')
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim()
        .slice(0, 100);
    if (!safeQuery) return [];
    let q = supabase.from('intel_reports')
        .select('*, createdBy:users!intel_reports_created_by_id_fkey(id, name, avatar_url, role_id), feed:alliance_peers(label), intel_report_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .or(`target_id.ilike.%${safeQuery}%,summary.ilike.%${safeQuery}%,tags.cs.{${safeQuery}}`);
    if (subjectType) q = q.eq('subject_type', subjectType);
    const { data } = await q.limit(50);
    return (data || []).map(toHydratedIntelReport);
}

// Cap how many rows we read to build the threat-level breakdown, so a large
// intel_reports table can't make this stats query pull everything. The total
// count is fetched separately (see below) and stays exact.
const INTEL_STATS_BREAKDOWN_CAP = 5000;

export async function getIntelStats(user?: ClearanceUser | null) {
    // Mirror getIntelHubStats — a low-clearance viewer's report count + threat
    // breakdown must NOT include reports above their level (the
    // counts/distribution themselves reveal classified-activity volume). Apply
    // the same classification-level ceiling in SQL. Admin / intel:manage holders
    // (read-side bypass) see everything (maxLevel = null). The warrant
    // aggregation is ceilinged via warrant:view: warrants are a separate
    // compartment gated by warrant:view in the dossier/read paths, so a viewer
    // without it sees an activeWarrants count of 0 here too.
    const maxLevel = canViewAllClassifications(user, ['intel:manage'])
        ? null
        : (user?.clearanceLevel?.level ?? 0);

    // Ask the database for just the total count (it sends back a number, not the
    // rows). The breakdown does need each row's threat level, but we cap how many
    // rows we read for it. So the total is exact and the breakdown is a sample.
    let countQuery = supabase.from('intel_reports').select('id', { count: 'exact', head: true });
    let breakdownQuery = supabase.from('intel_reports').select('threat_level').limit(INTEL_STATS_BREAKDOWN_CAP);
    if (maxLevel !== null) {
        countQuery = countQuery.lte('classification_level', maxLevel);
        breakdownQuery = breakdownQuery.lte('classification_level', maxLevel);
    }

    const canSeeWarrants = user?.role === 'Admin'
        || (Array.isArray(user?.permissions) && user.permissions.includes('warrant:view'));
    const warrantsQuery = canSeeWarrants
        ? supabase.from('warrants').select('id', { count: 'exact', head: true }).eq('status', 'Active')
        : Promise.resolve({ count: 0 });
    const [{ count: totalReports }, { data: breakdownRows }, { count: activeWarrants }] =
        await Promise.all([countQuery, breakdownQuery, warrantsQuery]);

    return {
        totalReports: totalReports || 0,
        activeWarrants: activeWarrants || 0,
        threatBreakdown: (breakdownRows || []).reduce((acc: Record<string, number>, curr: { threat_level: string }) => {
            acc[curr.threat_level] = (acc[curr.threat_level] || 0) + 1;
            return acc;
        }, {} as Record<string, number>)
    };
}

const normalizeString = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// An approved-but-hostile ally feed's response is fully peer-controlled. Bound
// it: a byte ceiling on the parsed body (mirrors operations-federation
// MAX_INBOUND_SNAPSHOT_BYTES), a per-channel item cap, a tag cap, and per-field
// stripHtml/length clamps at insert (the same hygiene
// createIntelReport/createIntelBulletin apply to own-org content). Without these,
// one feed pull could insert 50k markup-laden rows → DB bloat, realtime
// hammering, admin-browser DoS, and latent stored markup.
const MAX_FEED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_FEED_ITEMS = 1000;
const MAX_FEED_TAGS = 20;
// Peer-supplied timestamps are untrusted: a far-future created_at would pin an
// ally's item to the top of the feed forever, and a year-9999 expires_at would
// make a bulletin never auto-expire. Clamp created_at to <= now; cap expiry +
// duration to a ceiling.
const MAX_BULLETIN_DURATION_MIN = 30 * 24 * 60; // 30 days
const clampPastIso = (value: unknown): string => {
    const now = Date.now();
    const t = typeof value === 'string' ? Date.parse(value) : NaN;
    return new Date(Number.isFinite(t) && t < now ? t : now).toISOString();
};
const clampBulletinExpiry = (value: unknown): string => {
    const now = Date.now();
    const ceiling = now + MAX_BULLETIN_DURATION_MIN * 60 * 1000;
    const t = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(t)) return new Date(now + 24 * 60 * 60 * 1000).toISOString();
    return new Date(Math.min(Math.max(t, now), ceiling)).toISOString();
};
const sanitizeFeedTags = (tags: unknown): string[] =>
    Array.isArray(tags) ? tags.slice(0, MAX_FEED_TAGS).map((t) => stripHtmlSingleLine(String(t), 40)).filter(Boolean) : [];

/**
 * Resolve a feed item's requested limiting-marker CODES to local marker IDs,
 * failing CLOSED on any unknown code.
 *
 * Independent instances use free-text marker codes, so vocabulary divergence
 * between a peer and us is the normal case — a code the peer compartmented under
 * may not exist locally. If ANY requested code fails to resolve, return `null` so
 * the caller SKIPS the item entirely (never inserts it markerless, which would be
 * a compartment fail-open readable by every member at/below that level). An
 * empty/absent marker list returns `[]` (nothing to attach — insert proceeds).
 */
function resolveFeedMarkerIds(
    rawMarkers: unknown,
    localMarkers: { id: number; code: string }[] | null | undefined,
): { ids: number[] } | null {
    if (!Array.isArray(rawMarkers) || rawMarkers.length === 0) return { ids: [] };
    const requestedCodes = new Set(
        rawMarkers.slice(0, MAX_FEED_TAGS).map((c: unknown) => String(c).slice(0, 60)),
    );
    const byCode = new Map((localMarkers || []).map((m) => [m.code, m.id] as const));
    const ids: number[] = [];
    for (const code of requestedCodes) {
        const id = byCode.get(code);
        if (id === undefined) return null; // unknown compartment → fail closed
        ids.push(id);
    }
    return { ids };
}

// Loose shape of a remote/local trusted-feed sync payload. Fields are best-effort
// — feeds come from external servers, so everything is optional and validated
// at the point of use before being persisted.
interface FeedSyncMeta {
    reportsExcludedByClearance?: number;
    reportsExcludedByMarker?: number;
    totalReportsBeforeFilter?: number;
    maxShareableLevel?: number;
    // Peer-clock timestamp captured BEFORE the peer ran its queries — the next
    // sync cursor. Same clock domain as the items' created_at, so cross-server
    // clock skew can never skip intel.
    fetchedAt?: string;
}
interface FeedReportItem {
    id?: string;
    target_id?: string;
    summary?: string;
    subject_type?: string;
    threat_level?: string;
    tags?: string[];
    affiliated_org?: string;
    created_at?: string;
    classification_level?: number;
    limiting_markers?: string[];
}
interface FeedWarrantItem {
    id?: string;
    target_rsi_handle?: string;
    reason?: string;
    action?: string;
    uec_reward?: number;
    status?: string;
    created_at?: string;
    issued_at?: string;
}
interface FeedBulletinItem {
    title?: string;
    body?: string;
    threat_level?: string;
    location?: string | null;
    expires_at?: string;
    duration_minutes?: number;
    classification_level?: number;
    created_at?: string;
    limiting_markers?: string[];
}
interface FeedSyncData {
    countReports?: number;
    countWarrants?: number;
    countBulletins?: number;
    fetchedAt?: string;
    reports?: FeedReportItem[];
    warrants?: FeedWarrantItem[];
    bulletins?: FeedBulletinItem[];
    _meta?: FeedSyncMeta;
}

/**
 * Pull intel/warrants/bulletins from trusted feeds + allied peers, ingesting
 * deltas (INSERT-only, deduped). Called by the admin "Feed Ingest" button
 * (intel:sync_feeds) AND per-peer by the live-sync cron (lib/db/allianceSync.ts
 * passes `onlyPeerIds` so cadence/health gating stays in the engine).
 *
 * The delta cursor is the dedicated alliance_peers.intel_synced_at, written from
 * the PEER's _meta.fetchedAt (peer-clock domain — immune to cross-server skew),
 * minus a configurable overlap on use (replays are free: dedup absorbs them;
 * under-fetching loses intel forever). NULL cursor (fresh pairing / upgraded row)
 * falls back to the legacy last_contact_at once, then this column owns the cursor.
 * last_contact_at itself reverts to pure contact/health semantics.
 *
 * Warrants ingest no longer needs an admin id: warrants.issued_by is nullable
 * and federated warrants carry "via <ally>" provenance (source_feed_id).
 */
export async function syncTrustedFeeds(force?: boolean, onlyPeerIds?: string[]) {
    // Intel feeds are alliance_peers rows discriminated by pairing_state. Map them
    // back to the legacy feed shape this routine expects (api_key decrypted).
    // Feed sources are alliance_peers rows: 'legacy'/'manual' = one-directional
    // intel subscriptions (pull via /api/intel/feed); 'active' = handshake-paired
    // allies whose enabled channels we pull via /api/alliance/data. Channels are an
    // explicit opt-in (=== true), so a freshly-paired ally shares nothing until the
    // admin enables a channel.
    let feedQuery = supabase.from('alliance_peers')
        .select('id, label, base_url, outbound_key_enc, last_contact_at, intel_synced_at, inbound_max_clearance, pairing_state, channels')
        .in('pairing_state', ['legacy', 'manual', 'active']);
    if (onlyPeerIds && onlyPeerIds.length > 0) feedQuery = feedQuery.in('id', onlyPeerIds);
    const { data: feedRows, error: feedError } = await feedQuery;
    interface FeedPeerRow {
        id: string; label: string; base_url: string; outbound_key_enc: string | null;
        last_contact_at: string | null; intel_synced_at: string | null;
        inbound_max_clearance: number | null;
        pairing_state: string;
        channels: { reports?: boolean; warrants?: boolean; bulletins?: boolean } | null;
    }
    const feeds = ((feedRows || []) as FeedPeerRow[]).map((r) => ({
        id: r.id,
        label: r.label,
        url: r.base_url,
        api_key: r.outbound_key_enc ? decryptSecret(r.outbound_key_enc) : '',
        // Dedicated peer-clock cursor; legacy fallback for upgraded rows only.
        cursor: r.intel_synced_at ?? r.last_contact_at,
        sync_reports: r.channels?.reports === true,
        sync_warrants: r.channels?.warrants === true,
        sync_bulletins: r.channels?.bulletins === true,
        inbound_max_clearance: r.inbound_max_clearance ?? 5,
        isAlliance: r.pairing_state === 'active',
    }));

    if (feedError) {
        return { totalReports: 0, totalWarrants: 0, totalBulletins: 0, skippedItems: 0, feedResults: [{
            label: 'System', status: 'error' as const,
            message: `Failed to query feed list: ${feedError.message}`
        }]};
    }

    if (!feeds || feeds.length === 0) {
        return { totalReports: 0, totalWarrants: 0, totalBulletins: 0, skippedItems: 0, feedResults: [{
            label: 'System', status: 'warning' as const,
            message: onlyPeerIds ? 'Peer is not an intel feed source.' : 'No trusted feeds configured. Add feeds in the External Intelligence Sources section.'
        }]};
    }

    let totalReports = 0;
    let totalWarrants = 0;
    let totalBulletins = 0;
    let skippedItems = 0;
    const feedResults: { label: string; status: 'success' | 'error' | 'warning' | 'info'; message: string }[] = [];

    for (const feed of feeds) {
        const feedLog: string[] = [];
        try {
            // 1. Build feed URL — alliance peers serve /api/alliance/data, legacy
            //    feeds serve /api/intel/feed (or a direct /api/query?target=feed).
            let url = feed.url.replace(/\/$/, '');
            const isQueryFeed = url.includes('/api/query?target=feed');
            if (feed.isAlliance) {
                if (!url.endsWith('/api/alliance/data')) url += '/api/alliance/data';
            } else if (!isQueryFeed && !url.endsWith('/api/intel/feed')) {
                url += '/api/intel/feed';
            }

            // Delta cursor with overlap: re-fetch a safety margin of history so
            // commit-visibility windows / clock steps can never silently skip an
            // item (replays are free — INSERT-only + dedup). Asymmetric cost:
            // over-fetch = wasted bytes, under-fetch = intel lost forever.
            let deltaSince: string | undefined;
            if (!force && feed.cursor) {
                const cursorMs = new Date(feed.cursor).getTime();
                if (Number.isFinite(cursorMs)) {
                    const overlapMs = getCachedAllianceSyncConfig().cursorOverlapMinutes * 60_000;
                    deltaSince = new Date(cursorMs - overlapMs).toISOString();
                }
            }
            if (deltaSince) {
                url += `${isQueryFeed ? '&' : '?'}since=${encodeURIComponent(deltaSince)}`;
            }

            // 2. Determine if this is a local (same-platform) feed or external
            //    Local feeds on *.myrsi.org can be resolved directly via DB query,
            //    bypassing HTTP which can fail in containerized deployments (DNS/TLS loopback issues).
            //    Alliance peers are ALWAYS independent instances (separate DBs), so
            //    they must use the HTTP path — never the same-DB shortcut, which
            //    would return our own data instead of the peer's.
            let data: FeedSyncData;
            const feedUrlLower = url.toLowerCase();
            const isLocalPlatformFeed = !feed.isAlliance && (feedUrlLower.includes('.myrsi.org') || feedUrlLower.includes('localhost'));

            if (isLocalPlatformFeed) {
                feedLog.push(`Local platform feed detected — resolving via direct DB query`);
                try {
                    // Verify the API key and get the source org
                    const keyData = await verifyApiKey(feed.api_key);
                    if (!keyData) {
                        feedResults.push({
                            label: feed.label, status: 'error',
                            message: 'API key verification failed. The key may have been revoked or is invalid.'
                        });
                        continue;
                    }

                    const feedData = await getPublicFeedData(deltaSince);
                    data = {
                        countReports: feedData.reports.length,
                        countWarrants: feedData.warrants.length,
                        countBulletins: feedData.bulletins.length,
                        reports: feedData.reports,
                        warrants: feedData.warrants,
                        bulletins: feedData.bulletins,
                        _meta: feedData._meta
                    };
                    feedLog.push(`Direct query returned: ${data.countReports} reports, ${data.countWarrants} warrants, ${data.countBulletins} bulletins`);
                    // Per-reason "excluded by clearance/marker" counts were removed
                    // from the feed _meta — they disclosed how much classified intel
                    // exists above the requester's ceiling.
                } catch (localErr) {
                    feedResults.push({
                        label: feed.label, status: 'error',
                        message: `Direct DB query failed: ${localErr instanceof Error ? localErr.message : 'Unknown error'}`
                    });
                    continue;
                }
            } else {
                // External feed — use HTTP fetch
                feedLog.push(`Fetching external feed: ${url}`);

                // SSRF guard: external feeds must be public https:// endpoints.
                // Local *.myrsi.org / localhost feeds never reach this branch (they
                // resolve via direct DB query above), so this only blocks an admin
                // pointing a feed at loopback / private / cloud-metadata addresses.
                // Dev-only escape hatch for two-instance alliance E2E on loopback.
                const devLoopbackOk = feed.isAlliance && process.env.NODE_ENV !== 'production' && process.env.ALLIANCE_DEV_ALLOW_LOOPBACK === '1';
                if (!sanitizePublicLinkUrl(url) && !devLoopbackOk) {
                    feedResults.push({
                        label: feed.label, status: 'error',
                        message: 'Feed URL rejected: external feeds must be a public https:// endpoint (loopback/private/metadata addresses are blocked).'
                    });
                    continue;
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                let response: Response;
                try {
                    // The literal-IP check above does not resolve DNS, and this
                    // fetch carries our decrypted feed/alliance x-api-key.
                    // ssrfSafeFetch resolves + rejects private targets, PINS the
                    // vetted IP into the connection (DNS-rebind), and refuses
                    // redirects (a hostile feed could otherwise 302 the credentialed
                    // request to an internal or metadata endpoint).
                    response = await ssrfSafeFetch(url, {
                        method: 'GET',
                        headers: { 'x-api-key': feed.api_key },
                        signal: controller.signal
                    });
                } catch (fetchErr) {
                    clearTimeout(timeout);
                    const msg = fetchErr instanceof Error && fetchErr.name === 'AbortError'
                        ? 'Connection timed out after 15s'
                        : `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
                    feedResults.push({ label: feed.label, status: 'error', message: msg });
                    // Transport-level failure → feed the health state machine
                    // (live-sync backoff). HTTP-level errors below do NOT count:
                    // a responding peer is up, even when it rejects us.
                    await recordPeerFailure(feed.id).catch(() => undefined);
                    continue;
                }
                clearTimeout(timeout);

                if (!response.ok) {
                    let errBody = '';
                    try { errBody = await response.text(); } catch { /* response body may be unavailable; the HTTP status alone is sufficient */ }
                    const detail = errBody ? ` — ${errBody.substring(0, 200)}` : '';
                    feedResults.push({
                        label: feed.label, status: 'error',
                        message: `HTTP ${response.status} ${response.statusText}${detail}`
                    });
                    // 5xx = the peer's server is broken → back off like a transport
                    // failure. 4xx (403 revoked key etc.) = peer is up; no backoff.
                    if (response.status >= 500) await recordPeerFailure(feed.id).catch(() => undefined);
                    continue;
                }

                // Parse response
                const contentType = response.headers.get('content-type') || '';
                // Reject EARLY on a declared Content-Length over the cap — before
                // buffering the body at all. A hostile feed that honestly
                // advertises a multi-GB body is refused without ever being read
                // (the post-buffer length check below still guards
                // chunked/unset-length bodies). Applies to BOTH the JSON and the
                // non-JSON branch.
                const tooLargeMsg = `Feed response too large (> ${Math.round(MAX_FEED_RESPONSE_BYTES / 1048576)} MB) — refused.`;
                const declaredLen = Number(response.headers.get('content-length') || '');
                if (Number.isFinite(declaredLen) && declaredLen > MAX_FEED_RESPONSE_BYTES) {
                    feedResults.push({ label: feed.label, status: 'error', message: tooLargeMsg });
                    continue;
                }
                try {
                    if (!contentType.includes('application/json')) {
                        // The non-JSON branch also buffers the body (for the error
                        // preview) — apply the SAME byte cap so a hostile feed can't
                        // OOM us by serving a giant text/plain body with no
                        // Content-Length.
                        const bodyPreview = await response.text();
                        if (bodyPreview.length > MAX_FEED_RESPONSE_BYTES) {
                            feedResults.push({ label: feed.label, status: 'error', message: tooLargeMsg });
                            continue;
                        }
                        const isHtml = bodyPreview.trimStart().startsWith('<') || contentType.includes('text/html');
                        feedResults.push({
                            label: feed.label, status: 'error',
                            message: isHtml
                                ? `Received HTML instead of JSON. The feed URL may be returning a web page. Verify the URL is correct: ${url}`
                                : `Unexpected response type (${contentType}). Preview: ${bodyPreview.substring(0, 150)}`
                        });
                        continue;
                    }
                    // Cap the parsed body before JSON.parse so a hostile feed can't
                    // OOM us with a giant payload.
                    const bodyText = await response.text();
                    if (bodyText.length > MAX_FEED_RESPONSE_BYTES) {
                        feedResults.push({
                            label: feed.label, status: 'error',
                            message: tooLargeMsg,
                        });
                        continue;
                    }
                    data = JSON.parse(bodyText);
                } catch {
                    feedResults.push({
                        label: feed.label, status: 'error',
                        message: `Failed to parse JSON response (Content-Type: ${contentType}). The remote server may be misconfigured.`
                    });
                    continue;
                }
            }

            const remoteReportCount = data.countReports ?? (data.reports?.length || 0);
            const remoteWarrantCount = data.countWarrants ?? (data.warrants?.length || 0);
            const remoteBulletinCount = data.countBulletins ?? (data.bulletins?.length || 0);
            feedLog.push(`Remote returned: ${remoteReportCount} reports, ${remoteWarrantCount} warrants, ${remoteBulletinCount} bulletins`);

            let feedNewReports = 0;
            let feedDuplicateReports = 0;
            let feedLinkedReports = 0;
            let feedNewWarrants = 0;
            let feedDuplicateWarrants = 0;
            let feedNewBulletins = 0;
            let feedReportErrors = 0;
            let feedWarrantErrors = 0;
            let feedBulletinErrors = 0;
            const newWarrantIds: string[] = [];
            const newBulletinIds: string[] = [];

            // 4. Process reports (cap the per-channel item count)
            if (data.reports && Array.isArray(data.reports) && feed.sync_reports !== false) {
                if (data.reports.length > MAX_FEED_ITEMS) feedLog.push(`Truncated reports ${data.reports.length}→${MAX_FEED_ITEMS} (feed cap)`);
                for (const r of data.reports.slice(0, MAX_FEED_ITEMS)) {
                    try {
                        if (!r.target_id || !r.summary) continue;
                        const maxClearance = feed.inbound_max_clearance ?? 5;
                        if ((r.classification_level || 0) > maxClearance) continue;
                        // Sanitize ONCE and use the cleaned values for both dedup
                        // and insert — otherwise dedup (raw) and stored (clean)
                        // diverge and id-less items re-insert each sync.
                        const cleanTarget = stripHtmlSingleLine(r.target_id, 200);
                        const cleanSummary = stripHtml(r.summary, 8000);
                        if (!cleanTarget || !cleanSummary) continue;
                        const cleanAffiliated = stripHtmlSingleLine(r.affiliated_org, 200) || null;
                        const cleanTags = sanitizeFeedTags(r.tags);
                        const normalizedSummary = normalizeString(cleanSummary);

                        // Check if already imported from this feed (by external_id + source_feed_id)
                        const { data: existingExternal } = await supabase.from('intel_reports')
                            .select('id')
                            .eq('external_id', r.id)
                            .eq('source_feed_id', feed.id)

                            .maybeSingle();

                        if (existingExternal) {
                            feedDuplicateReports++;
                            continue;
                        }

                        // Check for content match within THIS org only. Escape LIKE
                        // metacharacters in the peer-supplied target so a value of
                        // '%' can't match every row (full-table scan + mis-linking).
                        const { data: internalMatches } = await supabase.from('intel_reports')
                            .select('id, summary, external_id')
                            .ilike('target_id', escapeLikePattern(cleanTarget))
                            ;

                        const existingInternal = (internalMatches || []).find(
                            (m) => normalizeString(m.summary) === normalizedSummary
                        );

                        if (existingInternal) {
                            // Link existing report to feed if not already linked
                            if (!existingInternal.external_id) {
                                await supabase.from('intel_reports').update({
                                    external_id: r.id,
                                    source_feed_id: feed.id,
                                    external_author: feed.label
                                }).eq('id', existingInternal.id);
                                feedLinkedReports++;
                            } else {
                                feedDuplicateReports++;
                            }
                        } else {
                            // Resolve the report's limiting markers BEFORE
                            // inserting and FAIL CLOSED on any unknown code — never
                            // insert a compartmented report markerless at full
                            // classification_level.
                            let markerIdsToAttach: number[] = [];
                            if (Array.isArray(r.limiting_markers) && r.limiting_markers.length > 0) {
                                const markerCodes = r.limiting_markers.slice(0, MAX_FEED_TAGS).map((c: unknown) => String(c).slice(0, 60));
                                const { data: localMarkers } = await supabase.from('security_limiting_markers')
                                    .select('id, code')
                                    .in('code', markerCodes);
                                const resolved = resolveFeedMarkerIds(r.limiting_markers, localMarkers);
                                if (!resolved) {
                                    // Unknown compartment locally → skip the item
                                    // (do NOT insert it without its markers).
                                    feedReportErrors++;
                                    log.warn('feed report skipped — unknown limiting marker code(s); refusing to insert markerless (compartment fail-closed)', { feedLabel: feed.label, externalId: r.id });
                                    continue;
                                }
                                markerIdsToAttach = resolved.ids;
                            }

                            // Insert new report (sanitized fields computed above).
                            const { data: inserted, error: insertErr } = await supabase.from('intel_reports').insert({
                                target_id: cleanTarget,
                                subject_type: r.subject_type,
                                threat_level: r.threat_level,
                                tags: cleanTags,
                                summary: cleanSummary,
                                affiliated_org: cleanAffiliated,
                                created_at: clampPastIso(r.created_at),
                                source_feed_id: feed.id,
                                external_id: r.id,
                                external_author: feed.label,
                                created_by_id: null,
                                classification_level: r.classification_level || 0
                            }).select('id').single();

                            if (insertErr) {
                                feedReportErrors++;
                                log.error('report insert failed', { targetId: r.target_id, feedLabel: feed.label, message: insertErr.message });
                                continue;
                            }

                            // Attach the resolved markers (all codes were known —
                            // verified above).
                            if (inserted && markerIdsToAttach.length > 0) {
                                await supabase.from('intel_report_limiting_markers').insert(
                                    markerIdsToAttach.map((mid) => ({ report_id: inserted.id, marker_id: mid }))
                                );
                            }

                            feedNewReports++;
                            totalReports++;
                        }
                    } catch (reportErr) {
                        feedReportErrors++;
                        log.error('error processing report from feed', { feedLabel: feed.label, err: reportErr });
                    }
                }
            }

            // 5. Process warrants. issued_by is NULL for federated warrants —
            //    provenance is source_feed_id ("via <ally>"), not fake admin
            //    attribution — so the cron can ingest these with no admin actor.
            if (data.warrants && Array.isArray(data.warrants) && feed.sync_warrants !== false) {
                if (data.warrants.length > MAX_FEED_ITEMS) feedLog.push(`Truncated warrants ${data.warrants.length}→${MAX_FEED_ITEMS} (feed cap)`);
                for (const w of data.warrants.slice(0, MAX_FEED_ITEMS)) {
                    try {
                        if (!w.target_rsi_handle || !w.reason) continue;
                        // Sanitize once; use for content-match dedup + insert.
                        const cleanHandle = stripHtmlSingleLine(w.target_rsi_handle, 200);
                        const cleanReason = stripHtml(w.reason, 8000);
                        if (!cleanHandle || !cleanReason) continue;

                        // Dedup by (source_feed_id, external_id) when the feed
                        // supplies an id (backed by uq_warrants_feed_external);
                        // content match below stays as the legacy-feed fallback.
                        if (w.id != null) {
                            const { data: existingExternal } = await supabase.from('warrants')
                                .select('id')
                                .eq('external_id', String(w.id))
                                .eq('source_feed_id', feed.id)
                                .maybeSingle();
                            if (existingExternal) {
                                feedDuplicateWarrants++;
                                continue;
                            }
                        }

                        const { data: existing } = await supabase.from('warrants')
                            .select('id')
                            .ilike('target_rsi_handle', escapeLikePattern(cleanHandle))
                            .eq('reason', cleanReason)

                            .maybeSingle();

                        if (!existing) {
                            const { data: insertedWarrant, error: warrantInsertErr } = await supabase.from('warrants').insert({
                                target_rsi_handle: cleanHandle,
                                reason: cleanReason,
                                action: w.action,
                                uec_reward: w.uec_reward,
                                status: w.status,
                                created_at: w.created_at || w.issued_at || new Date().toISOString(),
                                source_feed_id: feed.id,
                                external_id: w.id != null ? String(w.id) : null,
                                issued_by: null
                            }).select('id').single();
                            if (warrantInsertErr) {
                                feedWarrantErrors++;
                                log.error('warrant insert failed', { feedLabel: feed.label, message: warrantInsertErr.message });
                                continue;
                            }
                            if (insertedWarrant?.id) newWarrantIds.push(insertedWarrant.id);
                            feedNewWarrants++;
                            totalWarrants++;
                        } else {
                            feedDuplicateWarrants++;
                        }
                    } catch (warrantErr) {
                        feedWarrantErrors++;
                        log.error('error processing warrant from feed', { feedLabel: feed.label, err: warrantErr });
                    }
                }
            }

            // 6. Process bulletins
            if (data.bulletins && Array.isArray(data.bulletins) && feed.sync_bulletins !== false) {
                if (data.bulletins.length > MAX_FEED_ITEMS) feedLog.push(`Truncated bulletins ${data.bulletins.length}→${MAX_FEED_ITEMS} (feed cap)`);
                for (const b of data.bulletins.slice(0, MAX_FEED_ITEMS)) {
                    try {
                        if (!b.title || !b.body) continue;
                        // Enforce the per-feed clearance ceiling on bulletins
                        // exactly as reports do above, so a hostile/misconfigured
                        // peer can't push bulletins above the ceiling the admin set
                        // for this feed.
                        const maxClearance = feed.inbound_max_clearance ?? 5;
                        if ((b.classification_level || 0) > maxClearance) continue;
                        // Sanitize once; use for title dedup + insert.
                        const cleanTitle = stripHtmlSingleLine(b.title, 200);
                        const cleanBody = stripHtml(b.body, 8000);
                        const cleanLocation = stripHtmlSingleLine(b.location, 200) || null;
                        if (!cleanTitle || !cleanBody) continue;

                        // Check for existing bulletin by title match within org
                        const { data: existingBulletin } = await supabase.from('intel_bulletins')
                            .select('id')
                            .eq('title', cleanTitle)

                            .maybeSingle();

                        if (!existingBulletin) {
                            // Resolve the bulletin's limiting markers BEFORE
                            // inserting and FAIL CLOSED on any unknown code —
                            // mirrors the report path above. Never insert a
                            // compartmented bulletin markerless at full
                            // classification_level.
                            let bulletinMarkerIds: number[] = [];
                            if (Array.isArray(b.limiting_markers) && b.limiting_markers.length > 0) {
                                const markerCodes = b.limiting_markers.slice(0, MAX_FEED_TAGS).map((c: unknown) => String(c).slice(0, 60));
                                const { data: localMarkers } = await supabase.from('security_limiting_markers')
                                    .select('id, code')
                                    .in('code', markerCodes);
                                const resolved = resolveFeedMarkerIds(b.limiting_markers, localMarkers);
                                if (!resolved) {
                                    feedBulletinErrors++;
                                    log.warn('feed bulletin skipped — unknown limiting marker code(s); refusing to insert markerless (compartment fail-closed)', { feedLabel: feed.label, title: cleanTitle });
                                    continue;
                                }
                                bulletinMarkerIds = resolved.ids;
                            }

                            // Calculate expiry: clamp the remote expires_at to [now, now+30d]
                            // (default 24h), and bound duration so a peer can't pin a bulletin.
                            const expiresAt = clampBulletinExpiry(b.expires_at);
                            const durationMinutes = Math.min(Math.max(1, b.duration_minutes || 1440), MAX_BULLETIN_DURATION_MIN);
                            const { data: insertedBulletin, error: bulletinInsertErr } = await supabase.from('intel_bulletins').insert({
                                title: cleanTitle,
                                body: cleanBody,
                                threat_level: b.threat_level || 'Medium',
                                location: cleanLocation,
                                duration_minutes: durationMinutes,
                                expires_at: expiresAt,
                                classification_level: b.classification_level || 0,
                                created_at: clampPastIso(b.created_at),
                                // Mark provenance so the UI shows the "ALLY" badge and
                                // we never re-share this ingested bulletin (loop guard).
                                source_organization_id: feed.id,
                                source_organization_name: feed.label,
                                shared_with_allies: false,
                            }).select('id').single();
                            if (bulletinInsertErr) {
                                feedBulletinErrors++;
                                log.error('bulletin insert failed', { feedLabel: feed.label, message: bulletinInsertErr.message });
                                continue;
                            }
                            // Attach the bulletin's limiting markers (all codes
                            // resolved above — compartment preserved). Without this
                            // an ingested compartmented bulletin lands with NO
                            // markers, readable by everyone at/below its level.
                            if (insertedBulletin?.id && bulletinMarkerIds.length > 0) {
                                await supabase.from('intel_bulletin_limiting_markers').insert(
                                    bulletinMarkerIds.map((mid) => ({ bulletin_id: insertedBulletin.id, marker_id: mid })),
                                );
                            }
                            if (insertedBulletin?.id) newBulletinIds.push(insertedBulletin.id);
                            feedNewBulletins++;
                            totalBulletins++;
                        }
                    } catch (bulletinErr) {
                        feedBulletinErrors++;
                        log.error('error processing bulletin from feed', { feedLabel: feed.label, err: bulletinErr });
                    }
                }
            }

            // 7. Advance the cursor — ONLY after the ingest loops completed.
            //    Prefer the peer-clock _meta.fetchedAt (captured before the peer
            //    ran its queries); legacy peers without it fall back to their
            //    top-level fetchedAt, then to local time (the overlap on use
            //    covers the residual skew either way). Poison items can't stall
            //    the cursor (each item is individually try/caught + counted) —
            //    they're surfaced via sync_alert below instead.
            const nextCursor = data._meta?.fetchedAt || data.fetchedAt || new Date().toISOString();
            await supabase.from('alliance_peers').update({
                intel_synced_at: nextCursor,
                last_contact_at: new Date().toISOString(),
            }).eq('id', feed.id);
            await recordPeerSuccess(feed.id).catch(() => undefined);

            // 7b. Realtime nudges so members see cron-ingested intel without a
            //     reload (ids/discriminators only — receivers fetch content
            //     through the permission-gated read paths).
            if (feedNewReports > 0 || feedLinkedReports > 0) broadcastIntelUpdate({ kind: 'report' });
            if (newWarrantIds.length > 0) {
                broadcastWarrantUpdate(newWarrantIds.length <= 20 ? { warrantIds: newWarrantIds } : undefined);
            }
            if (newBulletinIds.length > 0) {
                if (newBulletinIds.length <= 20) {
                    for (const bulletinId of newBulletinIds) broadcastToOrg('bulletin_update', { bulletinId });
                } else {
                    broadcastToOrg('bulletin_update', {});
                }
            }

            // 7c. Operator-visible skip note (poison items): set, never silently
            //     swallowed. The live-sync engine clears sync_alert on the next
            //     fully-clean pass.
            const feedSkipped = feedReportErrors + feedWarrantErrors + feedBulletinErrors;
            skippedItems += feedSkipped;
            if (feedSkipped > 0) {
                await setSyncAlert(feed.id, `Intel sync skipped ${feedSkipped} item(s) — see server logs.`).catch(() => undefined);
            }

            // 8. Build result summary for this feed
            // First, push diagnostic log entries
            for (const logEntry of feedLog) {
                feedResults.push({ label: feed.label, status: 'info', message: logEntry });
            }

            // Include clearance filtering info from _meta if present
            if (data._meta) {
                const m = data._meta;
                if ((m.totalReportsBeforeFilter ?? 0) > 0 && ((m.reportsExcludedByClearance ?? 0) > 0 || (m.reportsExcludedByMarker ?? 0) > 0)) {
                    feedResults.push({
                        label: feed.label, status: 'warning',
                        message: `Source org sharing filter: ${m.totalReportsBeforeFilter} total reports, ${m.reportsExcludedByClearance} excluded by clearance (max level: ${m.maxShareableLevel}), ${m.reportsExcludedByMarker} excluded by marker restriction`
                    });
                }
            }

            const parts: string[] = [];
            if (remoteReportCount === 0 && remoteWarrantCount === 0 && remoteBulletinCount === 0) {
                parts.push('Remote feed returned 0 records (check their Outbound Sharing Policy)');
            } else {
                if (feedNewReports > 0) parts.push(`${feedNewReports} new report(s)`);
                if (feedNewWarrants > 0) parts.push(`${feedNewWarrants} new warrant(s)`);
                if (feedNewBulletins > 0) parts.push(`${feedNewBulletins} new bulletin(s)`);
                if (feedDuplicateReports > 0) parts.push(`${feedDuplicateReports} duplicate report(s) skipped`);
                if (feedLinkedReports > 0) parts.push(`${feedLinkedReports} existing report(s) linked`);
                if (feedDuplicateWarrants > 0) parts.push(`${feedDuplicateWarrants} duplicate warrant(s) skipped`);
                if (feedReportErrors > 0) parts.push(`${feedReportErrors} report(s) failed to import`);
                if (feedWarrantErrors > 0) parts.push(`${feedWarrantErrors} warrant(s) failed to import`);
                if (feedBulletinErrors > 0) parts.push(`${feedBulletinErrors} bulletin(s) failed to import`);
                if (parts.length === 0) parts.push('All records already exist locally');
            }

            const hasNew = feedNewReports > 0 || feedNewWarrants > 0 || feedNewBulletins > 0;
            feedResults.push({
                label: feed.label,
                status: feedSkipped > 0 ? 'warning' : hasNew ? 'success' : 'info',
                message: parts.join(', ')
            });

        } catch (err) {
            log.error('error syncing feed', { feedLabel: feed.label, err });
            feedResults.push({
                label: feed.label, status: 'error',
                message: `Unexpected error: ${err instanceof Error ? err.message : 'Unknown failure'}`
            });
        }
    }

    return { totalReports, totalWarrants, totalBulletins, skippedItems, feedResults };
}

export async function syncWarrantsToReports(adminId: number) {
    const query = supabase.from('warrants').select('id, target_rsi_handle, reason').in('status', ['Active', 'Standing']);
    const { data: warrants } = await query;
    let createdCount = 0;

    if (warrants && warrants.length > 0) {
        // Batch-check existing reports instead of N+1.
        const handles = [...new Set(warrants.map(w => w.target_rsi_handle.toLowerCase()))];
        const existingReportsQuery = supabase.from('intel_reports')
            .select('target_id')
            .in('target_id', handles);
        const { data: existingReports } = await existingReportsQuery;
        const existingSet = new Set((existingReports || []).map(r => r.target_id.toLowerCase()));

        for (const w of warrants) {
            if (!existingSet.has(w.target_rsi_handle.toLowerCase())) {
                await createIntelReport({
                    targetId: w.target_rsi_handle,
                    subjectType: 'Person',
                    threatLevel: 'High',
                    tags: ['Caution Note', 'Auto-Sync'],
                    summary: `[AUTOMATED REPORT FROM CAUTION NOTE] Target has an active caution note: ${w.reason}`,
                    evidenceUrls: [],
                    createdById: adminId,
                    classificationLevel: 0
                });
                createdCount++;
            }
        }
    }
    return createdCount;
}

export async function deduplicateWarrants() {
    const query = supabase.from('warrants')
        .select('id, target_rsi_handle, created_at')
        .in('status', ['Active', 'Standing'])
        .order('created_at', { ascending: false });
    const { data: warrants } = await query;

    if (!warrants) return 0;
    const seen = new Set<string>();
    const toDelete: string[] = [];

    for (const w of warrants) {
        const key = w.target_rsi_handle.toLowerCase();
        if (seen.has(key)) {
            toDelete.push(w.id);
        } else {
            seen.add(key);
        }
    }

    if (toDelete.length > 0) {
        const deleteQ = supabase.from('warrants').delete().in('id', toDelete);
        await deleteQ;
    }
    return toDelete.length;
}

export async function deduplicateIntelReports() {
    const query = supabase.from('intel_reports')
        .select('id, target_id, summary, external_id, created_by_id, created_at')
        .order('created_at', { ascending: true });
    const { data: reports } = await query;

    if (!reports) return 0;
    const seen = new Map<string, (typeof reports)[number]>();
    const toDelete: string[] = [];

    for (const r of reports) {
        const sig = `${r.target_id.toLowerCase()}|${normalizeString(r.summary)}`;
        if (seen.has(sig)) {
            const existing = seen.get(sig)!;
            if (existing.created_by_id && !r.created_by_id) {
                toDelete.push(r.id);
            } else if (!existing.created_by_id && r.created_by_id) {
                toDelete.push(existing.id);
                seen.set(sig, r);
            } else {
                toDelete.push(r.id);
            }
        } else {
            seen.set(sig, r);
        }
    }

    if (toDelete.length > 0) {
        const chunkSize = 500;
        for (let i = 0; i < toDelete.length; i += chunkSize) {
            const chunk = toDelete.slice(i, i + chunkSize);
            const deleteQ = supabase.from('intel_reports').delete().in('id', chunk);
            await deleteQ;
        }
    }
    return toDelete.length;
}

export async function saveDossierSummary(targetId: string, summary: string) {
    const payload: Record<string, unknown> = {
        target_id: targetId,
        summary: summary,
        generated_at: new Date().toISOString()
    };

    const { error } = await supabase.from('dossier_summaries').upsert(payload, { onConflict: 'target_id' });
    handleSupabaseError({ error, message: 'Failed to save dossier summary' });
    // Dossier summaries are RPC-fetched on demand (intel:get_dossier) — they
    // ride neither the intel subset nor the paginated feed, so clients skip the
    // refetch entirely for this kind.
    // The org-wide db-changes channel authorizes ANY authenticated non-deleted
    // user (no intel:view/clearance check), so the payload must carry NO
    // restricted content. targetId is the dossier SUBJECT (who intel is
    // investigating) — emit only the discriminator. The sole consumer
    // (DataCoreContext) returns early for kind:'dossier' and never reads targetId.
    await broadcastIntelUpdate({ kind: 'dossier' });
}

// --- INTEL BULLETINS ---

function broadcastBulletinUpdate(eventData?: Record<string, unknown>) {
    broadcastToOrg('bulletin_update', eventData || {});
}

export async function createIntelBulletin(data: Record<string, unknown>): Promise<IntelBulletin> {
    const durationMinutes = (data.durationMinutes as number | undefined) ?? 60;
    const isIndefinite = durationMinutes === 0;
    const expiresAt = isIndefinite
        ? new Date('9999-12-31T23:59:59Z').toISOString()
        : new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

    const markerIds = data.markerIds as number[] | undefined;
    // intel:create_bulletin is gated intel:create (default Member, NOT a clearance
    // bypass), so the author must not label a bulletin above their own clearance
    // or apply a marker they don't hold. intel:manage holders classify freely.
    assertCanClassify(data.user as ClearanceUser | undefined, (data.classificationLevel as number | undefined) ?? 0, markerIds, ['intel:manage']);
    const { data: row, error } = await supabase.from('intel_bulletins').insert({
        title: stripHtmlSingleLine(data.title, 200),
        body: stripHtml(data.body, 8000),
        threat_level: (data.threatLevel as string | undefined) || 'Medium',
        location: stripHtmlSingleLine(data.location, 200) || null,
        duration_minutes: durationMinutes,
        expires_at: expiresAt,
        classification_level: (data.classificationLevel as number | undefined) || 0,
        created_by_id: data.createdById as number | undefined,
        shared_with_allies: (data.sharedWithAllies as boolean | undefined) || false
    }).select().single();

    handleSupabaseError({ error, message: 'Failed to create intel bulletin' });

    if (row && markerIds && markerIds.length > 0) {
        // Mirror createIntelReport: verify the marker ids belong to this org
        // before attaching (don't trust arbitrary client-supplied ids).
        const { data: validMarkers } = await supabase.from('security_limiting_markers')
            .select('id')
            .in('id', markerIds);
        if (!validMarkers || validMarkers.length !== markerIds.length) {
            throw new Error('One or more limiting markers are not valid for this organization.');
        }
        const markers = markerIds.map((mid) => ({ bulletin_id: row.id, marker_id: mid }));
        await supabase.from('intel_bulletin_limiting_markers').insert(markers);
    }

    // The realtime 'db-changes' channel is readable by any holder of the public
    // anon key. A bulletin row carries a classified body + classification_level +
    // limiting markers — never broadcast it. Emit only non-sensitive routing
    // metadata; clients re-fetch via the clearance-filtered intel read path
    // (getIntelState / intel:get_bulletins). threatLevel is CONTENT (the
    // classification of a clearance-gated bulletin) and must not ride the
    // broadcast — receivers derive styling after the clearance-gated
    // bulletin_slice fetch. createdById stays for the author's self-skip in the
    // toast listener.
    await broadcastBulletinUpdate({ type: 'new_bulletin', bulletinId: row.id, createdById: row.created_by_id });
    // No companion intel_update: bulletins feed neither the intel aggregates
    // (index/stats scan intel_reports only) nor the paginated report feed —
    // bulletin_update alone drives the bulletin slice refetch.

    return toIntelBulletin(row);
}

export async function getActiveBulletins(): Promise<IntelBulletin[]> {
    const query = supabase.from('intel_bulletins')
        .select('*, createdBy:users!intel_bulletins_created_by_id_fkey(id, name, avatar_url, role_id), intel_bulletin_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

    const data = await safeFetch<IntelBulletinRow[]>(query, [], 'Failed to get active bulletins');
    return data.map(toIntelBulletin);
}

/**
 * Single-bulletin fetch in the active-list row shape, clearance-filtered for
 * the viewer. Backs the realtime `bulletin_slice` query subset: bulletin
 * broadcasts carry the bulletinId and the client refetches ONLY that row.
 * Returns null when absent, expired, or filtered by the viewer's clearance/
 * markers (the exact same filterIntelByClearance gate the bulk activeBulletins
 * path applies; null → the client removes the row, exactly what a full refetch
 * would have done). THROWS on query errors so a transient DB blip can never
 * masquerade as "bulletin deleted".
 */
export async function getBulletinByIdForViewer(bulletinId: string, user?: ClearanceUser | null): Promise<IntelBulletin | null> {
    const { data, error } = await supabase.from('intel_bulletins')
        .select('*, createdBy:users!intel_bulletins_created_by_id_fkey(id, name, avatar_url, role_id), intel_bulletin_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .eq('id', bulletinId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get bulletin slice' });
    if (!data) return null;
    const bulletin = toIntelBulletin(data as IntelBulletinRow);
    return filterIntelByClearance([bulletin], user)[0] ?? null;
}

export async function deleteIntelBulletin(bulletinId: string) {
    // Verify existence before deletion.
    const { data: bulletin } = await supabase.from('intel_bulletins')
        .select('id')
        .eq('id', bulletinId)

        .maybeSingle();
    if (!bulletin) throw new Error('Bulletin not found');

    const { error } = await supabase.from('intel_bulletins').delete()
        .eq('id', bulletinId)
        ;
    handleSupabaseError({ error, message: 'Failed to delete intel bulletin' });
    // bulletinId lets clients remove the one row (bulletin_slice → null).
    await broadcastBulletinUpdate({ type: 'bulletin_deleted', bulletinId });
    // No companion intel_update — see createIntelBulletin.
}

export async function cleanupExpiredBulletins() {
    const { error } = await supabase.from('intel_bulletins')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .neq('duration_minutes', 0);
    if (error) log.error('bulletin cleanup failed', { message: error.message });
}
