
import { randomUUID } from 'node:crypto';
import { WikiPage, WikiExportBundle, WikiExportPage, WikiHomeConfig, WikiImportMode, WikiImportResult } from '../../types.js';
import type { Tables } from './rows.js';
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg } from './common.js';
import { toWikiPage } from './mappers.js';
import { stripHtmlSingleLine } from '../textSanitize.js';
import { sanitizeTiptapJson } from '../tiptapValidate.js';
import { updateWikiHomeConfig } from './system.js';
import { assertCanClassify, passesClearance, filterByClearance, type ClearanceUser } from '../clearance.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.wiki' });

// Camel-case page payload accepted by create/update. Mirrors the WikiPageData
// shape sent by api/actions/wiki.ts; `content` is opaque Tiptap JSON.
interface WikiPagePayload {
    title?: string;
    parentPageId?: string | null;
    content?: unknown;
    classificationLevel?: number;
    menuStructureLocked?: boolean;
    markerIds?: number[];
}

/** Page CRUD carries the pageId so clients refetch ONE clearance-checked page
 *  (wiki_page_slice) instead of the whole body-bearing page list. Multi-row
 *  mutations (reorder/import) emit no id — clients fall back to the full
 *  refetch. Id-only payloads, since the db-changes channel is anon-readable. */
function broadcastWikiUpdate(pageId?: string) {
    broadcastToOrg('wiki_update', pageId ? { pageId } : {});
}

function generateSlug(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .substring(0, 80);
}

export async function getWikiPages(): Promise<WikiPage[]> {
    const query = supabase.from('wiki_pages')
        .select(`
            *,
            createdBy:users!wiki_pages_created_by_id_fkey(id, name, avatar_url, role_id),
            updatedBy:users!wiki_pages_updated_by_id_fkey(id, name, avatar_url, role_id),
            wiki_page_limiting_markers(marker:security_limiting_markers(id, name, code))
        `)
        .order('sort_order', { ascending: true });

    const data = await safeFetch<Parameters<typeof toWikiPage>[0][]>(query, [], 'Failed to get wiki pages');
    return data.map(toWikiPage);
}

/**
 * Single-page fetch in the list row shape. Backs the realtime
 * `wiki_page_slice` query subset — the caller (api/query.ts) re-applies the
 * SAME filterByClearance gate as the bulk wiki path before the page leaves
 * the server. Returns null when absent (deleted → client removes the row).
 * THROWS on query errors (no safeFetch fallback) so a transient DB blip can
 * never masquerade as "page deleted".
 */
export async function getWikiPageById(pageId: string): Promise<WikiPage | null> {
    const { data, error } = await supabase.from('wiki_pages')
        .select(`
            *,
            createdBy:users!wiki_pages_created_by_id_fkey(id, name, avatar_url, role_id),
            updatedBy:users!wiki_pages_updated_by_id_fkey(id, name, avatar_url, role_id),
            wiki_page_limiting_markers(marker:security_limiting_markers(id, name, code))
        `)
        .eq('id', pageId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get wiki page slice' });
    return data ? toWikiPage(data as Parameters<typeof toWikiPage>[0]) : null;
}

export async function createWikiPage(payload: WikiPagePayload, userId: number, actor?: ClearanceUser | null): Promise<WikiPage> {
    // The author may not label a page above their own clearance or apply a marker
    // they don't hold. Wiki has no clearance-bypass permission (read side filters
    // with Admin-only bypass), so only Admins classify freely.
    assertCanClassify(actor, payload.classificationLevel ?? 0, payload.markerIds);
    // Title is rendered in breadcrumbs/page tree as plain text. Sanitize as
    // defence-in-depth and to cap length before slug generation.
    const safeTitle = stripHtmlSingleLine(payload.title, 200);
    if (!safeTitle) throw new Error('Wiki page title is required');
    payload = { ...payload, title: safeTitle };
    // Auto-generate slug from title
    let slug = generateSlug(payload.title!);

    // Ensure slug uniqueness within org by appending a suffix if needed
    const { count } = await supabase.from('wiki_pages')
        .select('id', { count: 'exact', head: true })
        
        .eq('slug', slug);

    if (count && count > 0) {
        slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Auto sort_order: place at end of siblings
    const { data: siblings } = await supabase.from('wiki_pages')
        .select('sort_order')
        
        .is('parent_page_id', payload.parentPageId || null)
        .order('sort_order', { ascending: false })
        .limit(1);

    const nextOrder = (siblings && siblings.length > 0) ? (siblings[0].sort_order + 1) : 0;

    // Validate Tiptap JSON before insert. Drops disallowed nodes/marks and
    // rejects javascript:/data: URLs in links/images. Defense in depth — the wiki
    // render path doesn't use dangerouslySetInnerHTML today.
    const safeContent = payload.content
        ? sanitizeTiptapJson(payload.content, 'wiki')
        : { type: 'doc', content: [] };

    const { data: page, error } = await supabase.from('wiki_pages').insert({
        parent_page_id: payload.parentPageId || null,
        title: payload.title,
        slug,
        content: safeContent,
        classification_level: payload.classificationLevel || 0,
        sort_order: nextOrder,
        created_by_id: userId,
        updated_by_id: userId
    }).select().single();

    handleSupabaseError({ error, message: 'Failed to create wiki page' });

    // Insert limiting markers
    if (page && payload.markerIds && payload.markerIds.length > 0) {
        const markers = payload.markerIds.map((mid: number) => ({ page_id: page.id, marker_id: mid }));
        await supabase.from('wiki_page_limiting_markers').insert(markers);
    }

    broadcastWikiUpdate(page?.id);
    return toWikiPage(page);
}

export async function updateWikiPage(id: string, payload: WikiPagePayload, userId: number, actor?: ClearanceUser | null) {
    // The editor must be cleared to SEE a page before mutating ANY of its fields.
    // Otherwise a clearance-0 holder of wiki:edit_page who learns a classified
    // page's id could overwrite/vandalize its body + title or relabel it — the
    // dispatcher gate is only the edit permission, with no per-page clearance.
    // Fetch the LIVE classification + markers once and require visibility; Admins
    // bypass (canViewAllClassifications).
    const { data: live } = await supabase.from('wiki_pages')
        .select('classification_level, wiki_page_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .eq('id', id)
        .maybeSingle();
    if (live) {
        const liveMarkers = ((live as { wiki_page_limiting_markers?: { marker?: unknown }[] }).wiki_page_limiting_markers || [])
            .map((m) => m.marker).filter(Boolean);
        if (!passesClearance(actor, live.classification_level ?? 0, liveMarkers)) {
            throw new Error('You are not cleared to edit this page.');
        }
    }
    // Changing the classification additionally requires the NEW label to be at
    // or below the author's clearance and to use only markers they hold
    // (mislabel-UP guard). Falls back to the live level for marker-only edits.
    if (payload.classificationLevel !== undefined || payload.markerIds !== undefined) {
        assertCanClassify(actor, payload.classificationLevel ?? live?.classification_level ?? 0, payload.markerIds);
    }

    const updates: Partial<Tables<'wiki_pages'>> = {
        updated_by_id: userId,
        updated_at: new Date().toISOString()
    };

    if (payload.title !== undefined) {
        const safeTitle = stripHtmlSingleLine(payload.title, 200);
        if (!safeTitle) throw new Error('Wiki page title is required');
        payload = { ...payload, title: safeTitle };
        updates.title = safeTitle;
    }
    if (payload.content !== undefined) updates.content = sanitizeTiptapJson(payload.content, 'wiki');
    if (payload.classificationLevel !== undefined) updates.classification_level = payload.classificationLevel;
    if (payload.menuStructureLocked !== undefined) updates.menu_structure_locked = !!payload.menuStructureLocked;

    // Block parent re-assignment when the page's menu position is locked. Sibling
    // reordering (sort_order changes) goes through reorderWikiPages and is
    // intentionally unaffected — the lock guards menu STRUCTURE only. Soft-fail on
    // PG 42703 (column missing) so DBs that haven't run the lock migration still
    // allow parent moves.
    if (payload.parentPageId !== undefined) {
        const newParent = payload.parentPageId || null;
        const { data: existing, error: lookupErr } = await supabase
            .from('wiki_pages')
            .select('parent_page_id, menu_structure_locked')
            .eq('id', id)
            .maybeSingle();
        if (lookupErr && (lookupErr as { code?: string }).code === '42703') {
            log.warn('wiki_pages.menu_structure_locked column missing — skipping lock check; run migrations/add-wiki-page-menu-lock.sql', { migration: 'add-wiki-page-menu-lock.sql' });
            updates.parent_page_id = newParent;
        } else if (lookupErr) {
            // A real lookup error must NOT silently skip the lock check (fail
            // closed). maybeSingle() already turns a non-existent id into a clean
            // null with no error, so anything surfaced here is a genuine failure.
            handleSupabaseError({ error: lookupErr, message: 'Failed to verify wiki page menu lock' });
        } else {
            const oldParent = existing?.parent_page_id || null;
            if (existing?.menu_structure_locked && newParent !== oldParent) {
                const err = new Error('This page\'s menu position is locked. Unlock it from page settings before changing its parent.') as Error & { code?: string };
                err.code = 'WIKI_PAGE_MENU_LOCKED';
                throw err;
            }
            updates.parent_page_id = newParent;
        }
    }

    // Regenerate slug if title changed
    if (payload.title !== undefined) {
        let slug = generateSlug(payload.title);
        const { count } = await supabase.from('wiki_pages')
            .select('id', { count: 'exact', head: true })
            
            .eq('slug', slug)
            .neq('id', id);

        if (count && count > 0) {
            slug = `${slug}-${Date.now().toString(36)}`;
        }
        updates.slug = slug;
    }

    const runUpdate = async (patch: Partial<Tables<'wiki_pages'>>) => {
        const q = supabase.from('wiki_pages').update(patch).eq('id', id);
        return q;
    };
    let { error } = await runUpdate(updates);
    // PG 42703 = undefined column. Strip menu_structure_locked and retry so
    // tenants that haven't run the lock migration can still save other fields.
    if (error && (error as { code?: string }).code === '42703' && 'menu_structure_locked' in updates) {
        log.warn('wiki_pages.menu_structure_locked column missing on update — retrying without; run migrations/add-wiki-page-menu-lock.sql', { migration: 'add-wiki-page-menu-lock.sql' });
        const { menu_structure_locked, ...slim } = updates;
        ({ error } = await runUpdate(slim));
    }
    handleSupabaseError({ error, message: 'Failed to update wiki page' });

    // Update limiting markers (clear & re-insert)
    if (payload.markerIds !== undefined) {
        await supabase.from('wiki_page_limiting_markers').delete().eq('page_id', id);
        if (payload.markerIds.length > 0) {
            const markers = payload.markerIds.map((mid: number) => ({ page_id: id, marker_id: mid }));
            await supabase.from('wiki_page_limiting_markers').insert(markers);
        }
    }

    broadcastWikiUpdate(id);
}

export async function deleteWikiPage(id: string) {
    // wiki_pages.parent_page_id is ON DELETE SET NULL — deleting a parent
    // re-roots every child ROW. A single-row slice refetch would remove the
    // parent but leave remote clients' children pointing at it (orphaned out
    // of the page tree), so check for children first.
    const { count: childCount } = await supabase.from('wiki_pages')
        .select('id', { count: 'exact', head: true })
        .eq('parent_page_id', id);

    const query = supabase.from('wiki_pages').delete().eq('id', id);

    const { error } = await query;
    handleSupabaseError({ error, message: 'Failed to delete wiki page' });
    // Children re-rooted → id-less emit (clients full-refetch, picking up the
    // children's nulled parent ids); leaf page → single-row slice removal.
    broadcastWikiUpdate(childCount && childCount > 0 ? undefined : id);
}

export async function reorderWikiPages(pages: { id: string; sortOrder: number }[]) {
    for (const p of pages) {
        const query = supabase.from('wiki_pages').update({ sort_order: p.sortOrder }).eq('id', p.id);
        await query;
    }
    broadcastWikiUpdate();
}

export async function exportWikiPages(actor?: ClearanceUser | null): Promise<WikiExportBundle> {
    // Apply the SAME clearance filter as the read path (api/query.ts wiki subset)
    // so an export can never exfiltrate page bodies/marker names the actor cannot
    // read in the UI. Fail-closed: an absent actor is treated as clearance 0.
    const pages = filterByClearance(await getWikiPages(), actor);

    const { data: brandingRow } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'brandingConfig')
        .maybeSingle();
    const orgName = (brandingRow?.value as { name?: string } | null)?.name || 'Organization';

    const { data: homeRow } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'wikiHomeConfig')
        .maybeSingle();

    const exportPages: WikiExportPage[] = pages.map((p) => ({
        id: p.id,
        parentPageId: p.parentPageId,
        title: p.title,
        slug: p.slug,
        content: p.content,
        classificationLevel: p.classificationLevel,
        sortOrder: p.sortOrder,
        markerNames: (p.limitingMarkers || []).map((m) => m.name),
    }));

    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        sourceOrg: { id: '', name: orgName },
        wikiHomeConfig: (homeRow?.value as unknown as WikiHomeConfig) ?? null,
        pages: exportPages,
    };
}

function uniqueSlug(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    let candidate = `${base}-${Date.now().toString(36)}`;
    let attempt = 0;
    while (taken.has(candidate)) {
        attempt += 1;
        candidate = `${base}-${Date.now().toString(36)}-${attempt}`;
    }
    return candidate;
}

export async function importWikiPages(
    bundle: WikiExportBundle,
    mode: WikiImportMode,
    importHomeConfig: boolean,
    userId: number,
    actor?: ClearanceUser | null,
): Promise<WikiImportResult> {
    if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.pages)) {
        throw new Error('Invalid wiki export bundle');
    }
    if (mode !== 'skip' && mode !== 'overwrite' && mode !== 'new') {
        throw new Error(`Invalid import mode: ${mode}`);
    }

    // The wiki:import_pages gate is admin:access, which the non-Admin Dispatcher
    // role ALSO holds — so import must apply the SAME clearance integrity controls
    // as createWikiPage/updateWikiPage, or it becomes a clamp-bypassing
    // alternative. Load existing pages WITH their live classification + markers
    // (for the overwrite visibility guard) and the org's markers (to reproduce
    // compartmentation by name — the bundle ships markerNames, not ids).
    const { data: existingRows } = await supabase
        .from('wiki_pages')
        .select('id, slug, classification_level, wiki_page_limiting_markers(marker:security_limiting_markers(id, name, code))');
    interface ExistingPage { id: string; classificationLevel: number; markers: unknown[] }
    const slugToExisting = new Map<string, ExistingPage>();
    const takenSlugs = new Set<string>();
    for (const row of (existingRows || []) as Array<{ id: string; slug: string; classification_level: number | null; wiki_page_limiting_markers?: { marker?: unknown }[] }>) {
        slugToExisting.set(row.slug, {
            id: row.id,
            classificationLevel: row.classification_level ?? 0,
            markers: (row.wiki_page_limiting_markers || []).map((m) => m.marker).filter(Boolean),
        });
        takenSlugs.add(row.slug);
    }

    const { data: markerRows } = await supabase.from('security_limiting_markers').select('id, name');
    const markerNameToId = new Map<string, number>();
    for (const m of (markerRows || []) as { id: number; name: string }[]) markerNameToId.set(String(m.name), m.id);

    // Resolve a page's markerNames → local marker ids. Unmatched names mean the
    // compartmentation can't be faithfully reproduced — fail closed (throw), so
    // import never silently WIDENS access by dropping a marker.
    const resolveMarkerIds = (page: WikiExportPage): number[] => {
        const names = Array.isArray(page.markerNames) ? page.markerNames : [];
        const ids: number[] = [];
        for (const name of names) {
            const id = markerNameToId.get(String(name));
            if (id == null) {
                throw new Error(`Wiki import: page "${page.title}" references limiting marker "${name}" which does not exist in this organization. Create it (or remove it from the export) and retry.`);
            }
            ids.push(id);
        }
        return ids;
    };

    type Plan =
        | { kind: 'insert'; targetId: string; slug: string; source: WikiExportPage; markerIds: number[] }
        | { kind: 'update'; targetId: string; source: WikiExportPage; markerIds: number[] }
        | { kind: 'skip'; targetId: string };

    const plans = new Map<string, Plan>();
    for (const page of bundle.pages) {
        const existing = slugToExisting.get(page.slug);
        if (mode === 'skip' && existing) {
            plans.set(page.id, { kind: 'skip', targetId: existing.id });
            continue;
        }
        // PRE-FLIGHT — validate BEFORE any write so the import is rejected
        // atomically (no partial write) if any page violates the importer's
        // clearance:
        //  (a) resolve markers (throws on an unknown marker — fail closed),
        //  (b) assertCanClassify: the actor may not label a page above their own
        //      clearance or apply a marker they don't hold (Admin bypasses) —
        //      mirrors createWikiPage, so import isn't a clamp bypass,
        //  (c) for OVERWRITE: the actor must be cleared to SEE the live page
        //      before replacing its body (mirrors updateWikiPage's guard) — else
        //      a Dispatcher could destroy a classified page they can't read.
        const markerIds = resolveMarkerIds(page);
        assertCanClassify(actor, page.classificationLevel ?? 0, markerIds);
        if (mode === 'overwrite' && existing) {
            if (!passesClearance(actor, existing.classificationLevel, existing.markers)) {
                throw new Error(`Wiki import: not cleared to overwrite the existing page "${page.slug}".`);
            }
            plans.set(page.id, { kind: 'update', targetId: existing.id, source: page, markerIds });
        } else if (mode === 'new') {
            const slug = uniqueSlug(page.slug, takenSlugs);
            takenSlugs.add(slug);
            plans.set(page.id, { kind: 'insert', targetId: randomUUID(), slug, source: page, markerIds });
        } else {
            takenSlugs.add(page.slug);
            plans.set(page.id, { kind: 'insert', targetId: randomUUID(), slug: page.slug, source: page, markerIds });
        }
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    // Replace a page's limiting markers (clear-and-reinsert), reproducing the
    // bundle's compartmentation from the resolved ids.
    const writeMarkers = async (pageId: string, markerIds: number[], clearFirst: boolean) => {
        if (clearFirst) await supabase.from('wiki_page_limiting_markers').delete().eq('page_id', pageId);
        if (markerIds.length > 0) {
            await supabase.from('wiki_page_limiting_markers').insert(markerIds.map((mid) => ({ page_id: pageId, marker_id: mid })));
        }
    };

    for (const plan of plans.values()) {
        if (plan.kind !== 'insert') continue;
        const safeTitle = stripHtmlSingleLine(plan.source.title, 200) || 'Untitled';
        const { error } = await supabase.from('wiki_pages').insert({
            id: plan.targetId,
            parent_page_id: null,
            title: safeTitle,
            slug: plan.slug,
            content: sanitizeTiptapJson(plan.source.content, 'wiki') || {},
            classification_level: plan.source.classificationLevel ?? 0,
            sort_order: plan.source.sortOrder ?? 0,
            created_by_id: userId,
            updated_by_id: userId,
        });
        handleSupabaseError({ error, message: 'Failed to import wiki pages' });
        await writeMarkers(plan.targetId, plan.markerIds, false);
        inserted += 1;
    }

    for (const plan of plans.values()) {
        if (plan.kind !== 'update') continue;
        const safeTitle = stripHtmlSingleLine(plan.source.title, 200) || 'Untitled';
        const { error } = await supabase
            .from('wiki_pages')
            .update({
                title: safeTitle,
                content: sanitizeTiptapJson(plan.source.content, 'wiki') || {},
                classification_level: plan.source.classificationLevel ?? 0,
                sort_order: plan.source.sortOrder ?? 0,
                updated_by_id: userId,
                updated_at: new Date().toISOString(),
            })
            .eq('id', plan.targetId)
            ;
        handleSupabaseError({ error, message: 'Failed to overwrite wiki page during import' });
        await writeMarkers(plan.targetId, plan.markerIds, true);
        updated += 1;
    }

    for (const plan of plans.values()) {
        if (plan.kind === 'skip') skipped += 1;
    }

    for (const page of bundle.pages) {
        if (!page.parentPageId) continue;
        const self = plans.get(page.id);
        const parent = plans.get(page.parentPageId);
        if (!self || !parent) continue;
        if (self.kind === 'skip') continue;
        const { error } = await supabase
            .from('wiki_pages')
            .update({ parent_page_id: parent.targetId })
            .eq('id', self.targetId)
            ;
        if (error) {
            log.error('wiki import: failed to set parent ref', { id: self.targetId, err: error });
        }
    }

    if (importHomeConfig && bundle.wikiHomeConfig) {
        await updateWikiHomeConfig(bundle.wikiHomeConfig);
    }

    broadcastWikiUpdate();
    return { inserted, updated, skipped };
}
