
import * as db from '../../lib/db.js';
import { SecurityDenial } from '../../lib/errors.js';
import { permissionSatisfied } from '../../lib/permissionImplications.js';
import { WikiExportBundle, WikiImportMode, User } from '../../types.js';

// wiki:export_pages is mapped to admin:access, an admin-panel bucket the seeded
// Dispatcher also holds — and a custom role can be handed admin:access without
// wiki:view. The export returns the same page bodies the 'wiki' read subset serves,
// so it must ask the same question that subset does (SUBSET_REQUIRED_PERMISSION in
// api/query.ts: wiki:view through permissionSatisfied, no role-name bypass), or it
// is a second route to the wiki for someone the read path refuses.
function assertMayViewWiki(user: User | undefined): void {
    if (permissionSatisfied(user?.permissions, 'wiki:view')) return;
    throw new SecurityDenial('You do not have permission to view the wiki.', {
        auditEvent: 'authz.wiki_export.denied',
        fields: { userId: user?.id },
    });
}

// Shape of the page payload sent to create/update. Mirrors the fields read by
// lib/db/wiki.ts (createWikiPage / updateWikiPage). `content` is Tiptap JSON,
// passed through sanitizeTiptapJson without being read here.
interface WikiPageData {
    title?: string;
    parentPageId?: string | null;
    content?: unknown;
    classificationLevel?: number;
    menuStructureLocked?: boolean;
    markerIds?: number[];
}

interface CreateWikiPagePayload {
    data: WikiPageData;
    userId: number;
    // Injected server-side by the dispatcher — used for the write-side
    // clearance ceiling (the author can't classify above their own clearance).
    user?: User;
}

interface UpdateWikiPagePayload {
    id: string;
    data: WikiPageData;
    userId: number;
    user?: User;
}

interface DeleteWikiPagePayload {
    id: string;
    // Dispatcher-injected actor — used for the per-page clearance check so a
    // low-clearance wiki:delete_page holder cannot destroy classified pages.
    user?: User;
}

interface ReorderWikiPagesPayload {
    pages: { id: string; sortOrder: number }[];
    // Dispatcher-injected actor — used for the per-page clearance check so a
    // low-clearance editor cannot relocate classified pages in the menu tree.
    user?: User;
}

interface ImportWikiPagesPayload {
    bundle: WikiExportBundle;
    mode: WikiImportMode;
    importHomeConfig?: boolean;
    userId: number;
    // Dispatcher-injected actor — used for the clearance clamp +
    // overwrite-visibility guard (import must not bypass createWikiPage's gates).
    user?: User;
}

export const wikiActions = {
    'wiki:create_page': ({ data, userId, user }: CreateWikiPagePayload) => db.createWikiPage(data, userId, user),
    'wiki:update_page': ({ id, data, userId, user }: UpdateWikiPagePayload) => db.updateWikiPage(id, data, userId, user),
    'wiki:delete_page': ({ id, user }: DeleteWikiPagePayload) => db.deleteWikiPage(id, user),
    'wiki:reorder_pages': ({ pages, user }: ReorderWikiPagesPayload) => db.reorderWikiPages(pages, user),
    'wiki:export_pages': ({ user }: { user?: User }) => { assertMayViewWiki(user); return db.exportWikiPages(user); },
    'wiki:import_pages': ({ bundle, mode, importHomeConfig, userId, user }: ImportWikiPagesPayload) =>
        db.importWikiPages(bundle, mode, !!importHomeConfig, userId, user),
};
