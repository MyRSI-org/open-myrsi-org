import { supabase, handleSupabaseError } from './common.js';
import { escapeLikePattern } from '../pgrest.js';
import { getPublicSettings } from './system.js';
import { opaqueId } from '../publicId.js';
import { tryParseTiptapJson, tiptapJsonToSafeHtml, isEmptyTiptapDoc } from '../tiptapValidate.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import type { Tables } from './rows.js';

// Rows as selected from service_requests for the public/admin testimonial paths.
type TestimonialRow = Pick<
    Tables<'service_requests'>,
    'id' | 'client_rating' | 'client_feedback' | 'service_type' | 'updated_at'
>;
type ServiceTypeRow = Pick<
    Tables<'service_types'>,
    'name' | 'icon' | 'color' | 'description'
>;

interface PublicPageResponse {
    enabled: boolean;
    org: { name: string; iconUrl: string };
    motto: string;
    // Legacy plain-text blurb. Kept for backward compatibility — older clients
    // still display this verbatim with whitespace-pre-line. New clients prefer
    // blurbHtml when present.
    blurb: string;
    // Sanitized HTML rendering of the Tiptap-JSON blurb. Empty string when the
    // stored blurb is plain text or absent. Safe to mount via
    // dangerouslySetInnerHTML — emitted by the JSON-to-safe-HTML walker.
    blurbHtml: string;
    heroImageUrl: string;
    profileImageUrl: string;
    modules: { stats: boolean; testimonials: boolean; services: boolean; links: boolean };
    links: Array<{ id: string; label: string; url: string; icon?: string }>;
}

export async function getPublicPageData(slug: string): Promise<PublicPageResponse | null> {
    // Single-org: the deployment IS the org — no slug→organization lookup
    // (the multi-tenant `organizations` table does not exist in this build;
    // the old resolver 42P01'd on every hit and silently disabled the page).
    // The ONLY gate is the admin-controlled publicPageConfig.enabled flag.
    if (!slug || typeof slug !== 'string') return null;

    const settings = await getPublicSettings();
    const cfg = settings.publicPageConfig;
    if (!cfg || cfg.enabled !== true) return null;

    const branding = settings.brandingConfig || {};

    // Convert Tiptap-JSON blurb to safe HTML server-side. The walker emits only
    // allowlisted tags (p/h2/h3/ul/ol/li/strong/em/br/a) and HTML-escapes all
    // text — XSS-safe by construction. An empty doc (cleared editor saves
    // `{doc:[paragraph]}`) is suppressed so the "About" card is hidden by the
    // client's `(blurb || blurbHtml)` truthy check.
    const rawBlurb = typeof cfg.blurb === 'string' ? cfg.blurb : '';
    const parsedBlurb = tryParseTiptapJson(rawBlurb);
    const blurbIsEmpty = parsedBlurb
        ? isEmptyTiptapDoc(parsedBlurb)
        : rawBlurb.trim().length === 0;
    const blurbHtml = parsedBlurb && !blurbIsEmpty ? tiptapJsonToSafeHtml(parsedBlurb, 'minimal') : '';

    return {
        enabled: true,
        org: {
            name: typeof branding.name === 'string' ? branding.name : '',
            iconUrl: typeof branding.iconUrl === 'string' ? branding.iconUrl : '',
        },
        motto: typeof cfg.motto === 'string' ? cfg.motto : '',
        // Plain-text blurb stays for legacy clients + accessibility fallback.
        // Empty string when the blurb is JSON (clients use blurbHtml instead)
        // or when the doc is empty.
        blurb: parsedBlurb || blurbIsEmpty ? '' : rawBlurb,
        blurbHtml,
        // Re-validate URLs on the READ/SSR projection, not only at the write gate,
        // so a legacy row or a drifted gate can't surface a javascript:/data:/
        // private-host URL on the unauthenticated public page. sanitizeImageUrl →
        // '' on reject; sanitizePublicLinkUrl → drops the link.
        heroImageUrl: sanitizeImageUrl(cfg.heroImageUrl) || '',
        profileImageUrl: sanitizeImageUrl(cfg.profileImageUrl) || '',
        modules: {
            stats: !!cfg.modules?.stats,
            testimonials: !!cfg.modules?.testimonials,
            services: !!cfg.modules?.services,
            links: !!cfg.modules?.links,
        },
        links: Array.isArray(cfg.links)
            ? cfg.links
                // Only require label + url. Tolerate legacy links saved before the
                // `id` field existed — previously they were silently filtered out
                // here (and rejected by the save validator), so configured links
                // vanished from the public page. Synthesize a stable render key below.
                .filter((l) => l && typeof l.label === 'string' && typeof l.url === 'string')
                // Re-validate the scheme/host on read — drop any link whose URL
                // doesn't pass the same validator the write gate uses.
                .map((l) => ({ l, safeUrl: sanitizePublicLinkUrl(l.url) }))
                .filter((x): x is { l: typeof x.l; safeUrl: string } => !!x.safeUrl)
                .slice(0, 10)
                .map(({ l, safeUrl }, i) => ({
                    id: (typeof l.id === 'string' && l.id) ? (l.id as string) : `link-${i}`,
                    label: l.label as string,
                    url: safeUrl,
                    ...(typeof l.icon === 'string' && l.icon ? { icon: l.icon } : {}),
                }))
            : [],
    };
}

export async function getPublicStatsForOrg() {
    const { data, error } = await supabase.rpc('public_stats_for_org', {});
    if (error || !data || !data.length) {
        return { totalCompleted: 0, avgRatingTimes10: 0, avgResponseMinutes: 0, last30Completed: 0 };
    }
    const row: Record<string, unknown> = data[0];
    return {
        totalCompleted: Number(row.total_completed) || 0,
        avgRatingTimes10: Number(row.avg_rating_times10) || 0,
        avgResponseMinutes: Number(row.avg_response_minutes) || 0,
        last30Completed: Number(row.last30_completed) || 0,
    };
}

// Returns only the admin-selected ids, in admin order, fully anonymized.
// Silently omits any id that no longer resolves or is no longer rated.
export async function getPublicFeaturedTestimonials(featuredIds: string[]) {
    if (!Array.isArray(featuredIds) || featuredIds.length === 0) return [];
    // Clamp defensively even though save-time validator limits to 6.
    const ids = featuredIds.slice(0, 6).filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) return [];

    const { data } = await supabase
        .from('service_requests')
        .select('id, client_rating, client_feedback, service_type, updated_at')
        .in('id', ids)
        
        .eq('rated', true)
        .not('client_rating', 'is', null)
        .not('client_feedback', 'is', null);

    const rowsById = new Map<string, TestimonialRow>();
    for (const row of (data || []) as TestimonialRow[]) {
        if (row.client_feedback && String(row.client_feedback).trim().length > 0) {
            rowsById.set(row.id, row);
        }
    }

    const out: Array<{ id: string; rating: number; quote: string; serviceType: string; ratedAt: string }> = [];
    for (const id of ids) {
        const row = rowsById.get(id);
        if (!row) continue;
        const quote = String(row.client_feedback).trim().slice(0, 600);
        const ratedAt = row.updated_at ? new Date(row.updated_at).toISOString().slice(0, 10) : '';
        out.push({
            id: opaqueId(row.id),
            rating: Number(row.client_rating) || 0,
            quote,
            serviceType: typeof row.service_type === 'string' ? row.service_type : '',
            ratedAt,
        });
    }
    return out;
}

export async function getPublicServicesForOrg() {
    const { data } = await supabase
        .from('service_types')
        .select('name, icon, color, description, is_active')
        
        .eq('is_active', true)
        .order('name');
    return ((data || []) as ServiceTypeRow[]).map((r) => ({
        name: typeof r.name === 'string' ? r.name : '',
        icon: typeof r.icon === 'string' ? r.icon : '',
        color: typeof r.color === 'string' ? r.color : '',
        description: typeof r.description === 'string' ? r.description : '',
    }));
}

// --- Admin-side candidate listing (authenticated) ---
// Exposes the SAME anonymous preview admins will publish — never joins user tables.
export async function getTestimonialCandidates(
    params: { search?: string; limit?: number; offset?: number } = {},
) {
    const limit = Math.min(Math.max((params.limit ?? 50) | 0, 1), 100);
    const offset = Math.max((params.offset ?? 0) | 0, 0);

    let countQuery = supabase
        .from('service_requests')
        .select('id', { count: 'exact', head: true })
        
        .eq('rated', true)
        .not('client_rating', 'is', null)
        .not('client_feedback', 'is', null);

    let dataQuery = supabase
        .from('service_requests')
        .select('id, client_rating, client_feedback, service_type, updated_at')
        
        .eq('rated', true)
        .not('client_rating', 'is', null)
        .not('client_feedback', 'is', null);

    if (params.search && typeof params.search === 'string' && params.search.trim()) {
        const term = params.search.trim().slice(0, 100);
        // Shared helper: the local list escaped % _ , ( ) but NOT `\` (Postgres'
        // own escape character) or `*` (PostgREST rewrites it to %). Commas and
        // parens carry no grammar in a top-level ilike operand — only an .or()
        // filter string parses them, and this is not one.
        const escaped = escapeLikePattern(term);
        dataQuery = dataQuery.ilike('client_feedback', `%${escaped}%`);
        countQuery = countQuery.ilike('client_feedback', `%${escaped}%`);
    }

    const [{ count }, { data, error }] = await Promise.all([
        countQuery,
        dataQuery.order('updated_at', { ascending: false }).range(offset, offset + limit - 1),
    ]);
    handleSupabaseError({ error, message: 'Failed to list testimonial candidates' });

    const items = ((data || []) as TestimonialRow[]).map((r) => ({
        id: r.id as string, // INTERNAL id — needed by admin to add to featuredTestimonialIds
        rating: Number(r.client_rating) || 0,
        quote: String(r.client_feedback || '').trim().slice(0, 600),
        serviceType: typeof r.service_type === 'string' ? r.service_type : '',
        ratedAt: r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : '',
    }));
    return { items, total: count || 0 };
}

// --- Save-time validation: callable from updatePublicPageConfig ---
export async function verifyFeaturedTestimonialIdsBelongToOrg(
    ids: string[],
): Promise<{ ok: boolean; invalidIds: string[] }> {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: true, invalidIds: [] };
    const { data } = await supabase
        .from('service_requests')
        .select('id')
        .in('id', ids)
        
        .eq('rated', true)
        .not('client_rating', 'is', null)
        .not('client_feedback', 'is', null);
    const foundSet = new Set(((data || []) as Pick<Tables<'service_requests'>, 'id'>[]).map((r) => r.id));
    const invalidIds = ids.filter((id) => !foundSet.has(id));
    return { ok: invalidIds.length === 0, invalidIds };
}
