import { Request, Response } from 'express';
import * as pub from '../lib/db/public.js';
import { log as baseLog } from '../lib/log.js';

const log = baseLog.child({ module: 'api.public' });

// --- Simple in-memory TTL cache for unauth public endpoints ---
// Keyed by resource+slug/orgId. No eviction beyond TTL + a soft max size cap.
type CacheEntry = { value: any; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

// Single-org: the deployment IS the org. The old multi-tenant slug→orgId
// resolver queried a non-existent `organizations` table (42P01 on every hit).
// Page visibility is gated solely by publicPageConfig.enabled inside
// getPublicPageData; cache keys use a fixed sentinel. (The stub that replaced
// the resolver returned this sentinel for every slug that reached it — the
// handler 404s an invalid slug before any resource lookup — so its null/404
// arms were unreachable.)
const ORG_CACHE_ID = 'org';

function getCached<T>(key: string): T | null {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
    }
    return hit.value as T;
}

// SECURITY (public-surface#2): the public endpoints cache responses in-process.
// When an admin DISABLES a public module (or edits the page), the cached payload
// would keep serving for up to its TTL — surfacing a just-disabled module. The
// admin public-page-config handler calls this to drop the cache immediately.
export function invalidatePublicCache(): void {
    cache.clear();
}

function setCached(key: string, value: any, ttlMs: number) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Soft cap: drop the oldest quarter when full. Cheap approximation of LRU.
        const toDelete = Math.floor(MAX_CACHE_ENTRIES / 4);
        const keys = cache.keys();
        for (let i = 0; i < toDelete; i++) {
            const next = keys.next();
            if (next.done) break;
            cache.delete(next.value);
        }
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Unified 404 response — identical body/status regardless of root cause to
// prevent slug or config-state enumeration.
function notFound(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'not_found' });
}

function sendJson(res: Response, body: any, maxAgeSeconds: number) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).json(body);
}

function normSlug(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(s)) return null;
    return s;
}

export default async function publicHandler(req: Request, res: Response) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const resource = typeof req.query.resource === 'string' ? req.query.resource : '';
    const slug = normSlug(req.query.slug);
    if (!slug) return notFound(res);

    try {
        switch (resource) {
            case 'page': {
                const cacheKey = `page:${slug}`;
                const cached = getCached<any>(cacheKey);
                if (cached) return sendJson(res, cached, 60);
                const data = await pub.getPublicPageData(slug);
                if (!data) return notFound(res);
                setCached(cacheKey, data, 60_000);
                return sendJson(res, data, 60);
            }
            case 'stats': {
                const pageKey = `page:${slug}`;
                let page = getCached<any>(pageKey);
                if (!page) {
                    page = await pub.getPublicPageData(slug);
                    if (page) setCached(pageKey, page, 60_000);
                }
                if (!page || !page.modules?.stats) return notFound(res);
                const cacheKey = `stats:${ORG_CACHE_ID}`;
                const cached = getCached<any>(cacheKey);
                if (cached) return sendJson(res, cached, 300);
                const stats = await pub.getPublicStatsForOrg();
                setCached(cacheKey, stats, 5 * 60_000);
                return sendJson(res, stats, 300);
            }
            case 'testimonials': {
                const pageKey = `page:${slug}`;
                let page = getCached<any>(pageKey);
                if (!page) {
                    page = await pub.getPublicPageData(slug);
                    if (page) setCached(pageKey, page, 60_000);
                }
                if (!page || !page.modules?.testimonials) return notFound(res);
                // Need featuredTestimonialIds — NOT in the redacted page payload.
                // Fetch the raw config directly here (server-side only).
                const { getPublicSettings } = await import('../lib/db/system.js');
                const settings = await getPublicSettings();
                const featured = Array.isArray(settings.publicPageConfig?.featuredTestimonialIds)
                    ? settings.publicPageConfig.featuredTestimonialIds
                    : [];
                // Empty featured set is not an error — return an empty list (200) so
                // the client hides the card cleanly instead of treating a 404 as a fault.
                if (featured.length === 0) return sendJson(res, { items: [] }, 120);
                const cacheKey = `testimonials:${ORG_CACHE_ID}:${featured.join(',')}`;
                const cached = getCached<any>(cacheKey);
                if (cached) return sendJson(res, cached, 120);
                const items = await pub.getPublicFeaturedTestimonials(featured);
                const body = { items };
                setCached(cacheKey, body, 2 * 60_000);
                return sendJson(res, body, 120);
            }
            case 'services': {
                const pageKey = `page:${slug}`;
                let page = getCached<any>(pageKey);
                if (!page) {
                    page = await pub.getPublicPageData(slug);
                    if (page) setCached(pageKey, page, 60_000);
                }
                if (!page || !page.modules?.services) return notFound(res);
                const cacheKey = `services:${ORG_CACHE_ID}`;
                const cached = getCached<any>(cacheKey);
                if (cached) return sendJson(res, cached, 600);
                const items = await pub.getPublicServicesForOrg();
                const body = { items };
                setCached(cacheKey, body, 10 * 60_000);
                return sendJson(res, body, 600);
            }
            default:
                return notFound(res);
        }
    } catch (e: any) {
        log.error('public handler error', { err: e });
        // Preserve 404-parity: even on unexpected errors, do not differentiate.
        return notFound(res);
    }
}
