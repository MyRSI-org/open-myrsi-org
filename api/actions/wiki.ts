
import * as db from '../../lib/db.js';
import { WikiExportBundle, WikiImportMode, User } from '../../types.js';

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
    'wiki:export_pages': ({ user }: { user?: User }) => db.exportWikiPages(user),
    'wiki:import_pages': ({ bundle, mode, importHomeConfig, userId, user }: ImportWikiPagesPayload) =>
        db.importWikiPages(bundle, mode, !!importHomeConfig, userId, user),
};
