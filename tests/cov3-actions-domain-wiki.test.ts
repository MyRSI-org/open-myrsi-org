import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler-level suite for api/actions/wiki.ts (db layer mocked, the permission
// predicate and SecurityDenial REAL).
//
// Every wiki write must thread the dispatcher-injected actor into the db layer —
// that `user` is what the per-page clearance ceiling, the limiting-marker check and
// the import clamp/overwrite guard read. A handler that dropped it would hand the
// db layer `undefined`, which is the most permissive-looking input a future refactor
// could mistake for "system". wiki:export_pages additionally asks the wiki read
// path's own question (wiki:view through permissionSatisfied) before any read.
// tests/wikiExportViewGate.test.ts pins the export gate through the dispatcher too.

const spies = vi.hoisted(() => ({
    createWikiPage: vi.fn(),
    updateWikiPage: vi.fn(),
    deleteWikiPage: vi.fn(),
    reorderWikiPages: vi.fn(),
    exportWikiPages: vi.fn(),
    importWikiPages: vi.fn(),
}));

vi.mock('../lib/db', () => ({ ...spies }));

import { wikiActions } from '../api/actions/wiki';
import { SecurityDenial } from '../lib/errors';
import type { User, WikiExportBundle } from '../types';

const asUser = (permissions: unknown, over: Record<string, unknown> = {}) =>
    ({ id: 21, role: 'Member', permissions, clearanceLevel: { level: 2 }, limitingMarkers: [], ...over }) as unknown as User;

const EDITOR = asUser(['wiki:view', 'wiki:edit']);

beforeEach(() => {
    for (const s of Object.values(spies)) s.mockReset();
});

describe('writes thread the dispatcher actor into the db layer', () => {
    it('wiki:create_page → createWikiPage(data, actorId, user)', async () => {
        const data = { title: 'SOP: Medevac', parentPageId: null, content: { type: 'doc' }, classificationLevel: 1, markerIds: [3] };
        spies.createWikiPage.mockResolvedValue({ id: 'p1' });
        await expect(wikiActions['wiki:create_page']({ data, userId: 21, user: EDITOR })).resolves.toEqual({ id: 'p1' });
        expect(spies.createWikiPage).toHaveBeenCalledWith(data, 21, EDITOR);
    });

    it('wiki:update_page → updateWikiPage(id, data, actorId, user)', async () => {
        const data = { title: 'SOP: Medevac v2', menuStructureLocked: true };
        await wikiActions['wiki:update_page']({ id: 'p1', data, userId: 21, user: EDITOR });
        expect(spies.updateWikiPage).toHaveBeenCalledWith('p1', data, 21, EDITOR);
    });

    it('wiki:delete_page → deleteWikiPage(id, user)', async () => {
        spies.deleteWikiPage.mockResolvedValue(true);
        await expect(wikiActions['wiki:delete_page']({ id: 'p1', user: EDITOR })).resolves.toBe(true);
        expect(spies.deleteWikiPage).toHaveBeenCalledWith('p1', EDITOR);
    });

    it('wiki:reorder_pages → reorderWikiPages(pages, user)', async () => {
        const pages = [{ id: 'p1', sortOrder: 2 }, { id: 'p2', sortOrder: 1 }];
        await wikiActions['wiki:reorder_pages']({ pages, user: EDITOR });
        expect(spies.reorderWikiPages).toHaveBeenCalledWith(pages, EDITOR);
    });

    it('a db-layer clearance denial propagates unchanged', async () => {
        spies.updateWikiPage.mockRejectedValue(new SecurityDenial('You cannot edit this page.'));
        await expect(wikiActions['wiki:update_page']({ id: 'p1', data: {}, userId: 21, user: EDITOR })).rejects.toThrow('You cannot edit this page.');
    });
});

describe('wiki:import_pages', () => {
    const bundle = { version: 1, exportedAt: '2026-11-01T00:00:00Z', pages: [] } as unknown as WikiExportBundle;

    it('forwards the bundle, mode, actor id and user, with importHomeConfig coerced to a strict boolean', async () => {
        spies.importWikiPages.mockResolvedValue({ inserted: 0, updated: 0 });
        await expect(wikiActions['wiki:import_pages']({ bundle, mode: 'overwrite', importHomeConfig: true, userId: 21, user: EDITOR }))
            .resolves.toEqual({ inserted: 0, updated: 0 });
        expect(spies.importWikiPages).toHaveBeenCalledWith(bundle, 'overwrite', true, 21, EDITOR);
    });

    it('an omitted importHomeConfig is false, never undefined', async () => {
        await wikiActions['wiki:import_pages']({ bundle, mode: 'skip', userId: 21, user: EDITOR });
        expect(spies.importWikiPages).toHaveBeenCalledWith(bundle, 'skip', false, 21, EDITOR);
    });

    it('a truthy non-boolean importHomeConfig (client-supplied) is coerced to true', async () => {
        await wikiActions['wiki:import_pages']({ bundle, mode: 'new', importHomeConfig: 'yes' as unknown as boolean, userId: 21, user: EDITOR });
        expect(spies.importWikiPages.mock.calls[0][2]).toBe(true);
    });
});

describe('wiki:export_pages — the wiki:view gate', () => {
    const denial = (user: User | undefined) => {
        try {
            void wikiActions['wiki:export_pages']({ user });
        } catch (e) {
            return e;
        }
        return null;
    };

    it('a wiki:view holder exports, with the actor threaded for the clearance filter', async () => {
        spies.exportWikiPages.mockResolvedValue({ version: 1, pages: [{ id: 'p1' }] });
        await expect(wikiActions['wiki:export_pages']({ user: EDITOR })).resolves.toEqual({ version: 1, pages: [{ id: 'p1' }] });
        expect(spies.exportWikiPages).toHaveBeenCalledWith(EDITOR);
    });

    it('denies a caller without wiki:view with a SecurityDenial carrying the audit event and the user id, before any read', () => {
        const err = denial(asUser(['admin:access'])) as SecurityDenial;
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('You do not have permission to view the wiki.');
        expect(err.auditEvent).toBe('authz.wiki_export.denied');
        expect(err.fields).toEqual({ userId: 21 });
        expect(err.status).toBe(403);
        expect(spies.exportWikiPages).not.toHaveBeenCalled();
    });

    it('denies a missing actor, recording no user id', () => {
        const err = denial(undefined) as SecurityDenial;
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.fields).toEqual({ userId: undefined });
        expect(spies.exportWikiPages).not.toHaveBeenCalled();
    });

    it('denies a role NAMED Admin without wiki:view, and a non-array permissions string containing it', () => {
        expect(denial(asUser([], { role: 'Admin' }))).toBeInstanceOf(SecurityDenial);
        expect(denial(asUser('wiki:view'))).toBeInstanceOf(SecurityDenial);
        expect(spies.exportWikiPages).not.toHaveBeenCalled();
    });

    it('a stronger-sounding wiki permission does not imply wiki:view (no implication rule exists for it)', () => {
        expect(denial(asUser(['wiki:edit', 'wiki:delete_page']))).toBeInstanceOf(SecurityDenial);
        expect(spies.exportWikiPages).not.toHaveBeenCalled();
    });
});
