import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, filters, hasCall, columnsOf, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/wiki.ts — behaviour coverage: clearance/marker gates on every write
// path (create/update/delete/reorder/import), fail-closed lookups, the
// compensating marker writes (page removed / previous markers restored), slug
// uniqueness, menu-lock, sanitisation + private-media normalisation on save,
// the clearance-filtered export, and id-only realtime emits.
// =============================================================================

const m = vi.hoisted(() => ({ updateWikiHomeConfig: vi.fn() }));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});
vi.mock('../lib/db/system.js', () => ({ updateWikiHomeConfig: m.updateWikiHomeConfig }));

import {
    getWikiPages, getWikiPageById, createWikiPage, updateWikiPage, deleteWikiPage, reorderWikiPages,
    exportWikiPages, importWikiPages,
} from '../lib/db/wiki';
import type { WikiExportBundle, WikiExportPage } from '../types';

const ADMIN = { isSystemAdmin: true };
const LOW = { clearanceLevel: { level: 0 }, limitingMarkers: [] };
const NF = { id: 7, name: 'NOFORN', code: 'NF' };
const CLEARED = { clearanceLevel: { level: 2 }, limitingMarkers: [NF] };
const LIVE_COLS = 'classification_level, wiki_page_limiting_markers(marker:security_limiting_markers(id, name, code))';
const PRIVATE_SIGNED = 'http://localhost:54321/storage/v1/object/sign/org-media/media/wiki/abc.webp?token=t';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const img = (src: string) => ({ type: 'image', attrs: { src } });
const para = (text: string, href?: string) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }] });

const pageRow = (over: Record<string, unknown> = {}) => ({
    id: 'p1', parent_page_id: null, title: 'T', slug: 't', content: doc(), classification_level: 0, sort_order: 0,
    created_by_id: 1, updated_by_id: 1, created_at: 'c', updated_at: 'u', menu_structure_locked: false,
    wiki_page_limiting_markers: [], ...over,
});

const isCount = (q: FakeQuery) => q.op === 'select' && q.columns === 'id' && (q.selectOptions as { head?: boolean } | undefined)?.head === true;

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
});
afterEach(() => {
    assertNoWildcardSelects(fake);
    vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
describe('reads', () => {
    it('getWikiPages selects explicit columns + embeds in sort order and maps rows', async () => {
        fake.queue('wiki_pages', { data: [pageRow({ wiki_page_limiting_markers: [{ marker: NF }, { marker: null }] })] });
        const [p] = await getWikiPages();
        const q = fake.find('wiki_pages')[0];
        const cols = columnsOf(q);
        expect(cols).toContain('content');
        expect(cols.some((c) => c.startsWith('createdBy:users!wiki_pages_created_by_id_fkey(id, name, avatar_url, role_id)'))).toBe(true);
        expect(hasCall(q, 'order', 'sort_order', { ascending: true })).toBe(true);
        expect(p).toMatchObject({ id: 'p1', slug: 't', classificationLevel: 0, limitingMarkers: [NF] });
    });

    it('getWikiPages fails closed to [] on error', async () => {
        fake.queue('wiki_pages', { data: null, error: { message: 'x' } });
        expect(await getWikiPages()).toEqual([]);
    });

    it('getWikiPageById returns the mapped row, null when absent, and THROWS on error (never "deleted")', async () => {
        fake.queue('wiki_pages', { data: pageRow({ id: 'p9' }) }, { data: null }, { data: null, error: { message: 'blip' } });
        expect((await getWikiPageById('p9'))!.id).toBe('p9');
        expect(hasCall(fake.find('wiki_pages')[0], 'eq', 'id', 'p9')).toBe(true);
        expect(await getWikiPageById('gone')).toBeNull();
        await expect(getWikiPageById('x')).rejects.toThrow('Failed to get wiki page slice');
    });
});

// -----------------------------------------------------------------------------
describe('createWikiPage', () => {
    function arm(opts: { slugCount?: number; siblings?: unknown[]; insert?: unknown; markerInsert?: unknown; cleanup?: unknown } = {}) {
        fake.on('wiki_pages', (q) => {
            if (isCount(q)) return { count: opts.slugCount ?? 0 };
            if (q.op === 'select' && q.columns === 'sort_order') return { data: opts.siblings ?? [] };
            if (q.op === 'insert') return (opts.insert as never) ?? { data: pageRow({ id: 'new' }) };
            if (q.op === 'delete') return (opts.cleanup as never) ?? { error: null };
            return { data: null };
        });
        fake.on('wiki_page_limiting_markers', (q) => (q.op === 'insert' ? (opts.markerInsert as never) ?? { error: null } : { data: null }));
    }

    it('refuses to classify above the author clearance or with an unheld marker, before any query', async () => {
        await expect(createWikiPage({ title: 'x', classificationLevel: 3 }, 1, CLEARED)).rejects.toThrow('above your own clearance');
        await expect(createWikiPage({ title: 'x', markerIds: [99] }, 1, CLEARED)).rejects.toThrow('limiting marker you do not hold');
        await expect(createWikiPage({ title: 'x', classificationLevel: 1 }, 1, null)).rejects.toThrow('above your own clearance');
        expect(fake.queries).toHaveLength(0);
    });

    it('requires a title that survives HTML stripping', async () => {
        await expect(createWikiPage({ title: '<b></b>  ' }, 1, ADMIN)).rejects.toThrow('Wiki page title is required');
        expect(fake.queries).toHaveLength(0);
    });

    it('slugifies, appends to siblings, sanitises content, normalises private media, inserts markers, emits the id', async () => {
        arm({ siblings: [{ sort_order: 4 }] });
        const out = await createWikiPage({
            title: '<i>Hello,</i>   World!! -- Ops', parentPageId: 'parent-1', classificationLevel: 2, markerIds: [7],
            content: doc(para('click', 'javascript:alert(1)'), img(PRIVATE_SIGNED), img('https://cdn.myrsi-alpha.net/x.png')),
        }, 5, CLEARED);
        expect(out.id).toBe('new');

        const slugQ = fake.find('wiki_pages').find(isCount)!;
        expect(hasCall(slugQ, 'eq', 'slug', 'hello-world-ops')).toBe(true);
        const sib = fake.find('wiki_pages').find((q) => q.columns === 'sort_order')!;
        expect(hasCall(sib, 'is', 'parent_page_id', 'parent-1')).toBe(true);
        expect(hasCall(sib, 'order', 'sort_order', { ascending: false })).toBe(true);
        expect(hasCall(sib, 'limit', 1)).toBe(true);

        const ins = fake.find('wiki_pages', 'insert')[0];
        const p = ins.payload as Record<string, unknown>;
        expect(p).toMatchObject({ parent_page_id: 'parent-1', title: 'Hello, World!! -- Ops', slug: 'hello-world-ops', classification_level: 2, sort_order: 5, created_by_id: 5, updated_by_id: 5 });
        const body = JSON.stringify(p.content);
        expect(body).not.toContain('javascript:');
        expect(body).toContain('"media/wiki/abc.webp"');
        expect(body).not.toContain('token=t');
        expect(body).toContain('https://cdn.myrsi-alpha.net/x.png');
        expect(ins.columns).not.toContain('*');
        expect(columnsOf(ins)).toContain('menu_structure_locked');

        const mk = fake.find('wiki_page_limiting_markers', 'insert')[0];
        expect(mk.payload).toEqual([{ page_id: 'new', marker_id: 7 }]);
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', { pageId: 'new' });
    });

    it('de-duplicates a taken slug, roots a parentless page at order 0 with an empty doc', async () => {
        arm({ slugCount: 2, siblings: [] });
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        await createWikiPage({ title: 'Ops' }, 1, ADMIN);
        const sib = fake.find('wiki_pages').find((q) => q.columns === 'sort_order')!;
        expect(hasCall(sib, 'is', 'parent_page_id', null)).toBe(true);
        expect(fake.find('wiki_pages', 'insert')[0].payload).toMatchObject({
            slug: `ops-${(1_700_000_000_000).toString(36)}`, sort_order: 0, parent_page_id: null, classification_level: 0, content: doc(),
        });
        expect(fake.find('wiki_page_limiting_markers')).toHaveLength(0);
    });

    it('enforces the per-doc image cap before inserting', async () => {
        arm();
        const many = Array.from({ length: 51 }, (_, i) => img(`https://cdn.myrsi-alpha.net/${i}.png`));
        await expect(createWikiPage({ title: 'Imgs', content: doc(...many) }, 1, ADMIN)).rejects.toThrow('Too many images');
        expect(fake.find('wiki_pages', 'insert')).toHaveLength(0);
    });

    it('removes the just-inserted page and throws when its markers cannot be applied (never published wider)', async () => {
        arm({ markerInsert: { error: { message: 'fk' } } });
        await expect(createWikiPage({ title: 'Secret', markerIds: [7], classificationLevel: 2 }, 1, CLEARED)).rejects.toThrow('Failed to apply wiki page limiting markers');
        const del = fake.find('wiki_pages', 'delete')[0];
        expect(hasCall(del, 'eq', 'id', 'new')).toBe(true);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('still throws when the compensating delete also fails', async () => {
        arm({ markerInsert: { error: { message: 'fk' } }, cleanup: { error: { message: 'locked' } } });
        await expect(createWikiPage({ title: 'S', markerIds: [7] }, 1, ADMIN)).rejects.toThrow('Failed to apply wiki page limiting markers');
    });

    it('surfaces an insert error, and refuses a null insert result', async () => {
        arm({ insert: { data: null, error: { message: 'dup' } } });
        await expect(createWikiPage({ title: 'A' }, 1, ADMIN)).rejects.toThrow('Failed to create wiki page');
        expect(broadcastSpy).not.toHaveBeenCalled();
        fake.reset();
        arm({ insert: { data: null, error: null } });
        await expect(createWikiPage({ title: 'A', markerIds: [7] }, 1, ADMIN)).rejects.toThrow('Failed to create wiki page');
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', {});
        expect(fake.find('wiki_page_limiting_markers')).toHaveLength(0);
    });
});

// -----------------------------------------------------------------------------
describe('updateWikiPage', () => {
    interface ArmOpts {
        live?: unknown; lock?: unknown; slugCount?: number;
        updates?: unknown[]; mDelete?: unknown; mInserts?: unknown[];
    }
    function arm(o: ArmOpts = {}) {
        const updates = [...(o.updates ?? [])];
        const mInserts = [...(o.mInserts ?? [])];
        fake.on('wiki_pages', (q) => {
            if (q.op === 'select' && q.columns === LIVE_COLS) return (o.live as never) ?? { data: { classification_level: 0, wiki_page_limiting_markers: [] } };
            if (q.op === 'select' && q.columns === 'parent_page_id, menu_structure_locked') return (o.lock as never) ?? { data: { parent_page_id: null, menu_structure_locked: false } };
            if (isCount(q)) return { count: o.slugCount ?? 0 };
            if (q.op === 'update') return (updates.shift() as never) ?? { error: null };
            return { data: null };
        });
        fake.on('wiki_page_limiting_markers', (q) => {
            if (q.op === 'delete') return (o.mDelete as never) ?? { error: null };
            if (q.op === 'insert') return (mInserts.shift() as never) ?? { error: null };
            return { data: null };
        });
    }
    const updatesOf = () => fake.find('wiki_pages', 'update');

    it('fails CLOSED when the live clearance lookup errors — no write happens', async () => {
        arm({ live: { data: null, error: { code: 'PGRST200', message: 'embed' } } });
        await expect(updateWikiPage('p1', { title: 'x' }, 1, ADMIN)).rejects.toThrow('Failed to verify wiki page clearance — refusing the edit');
        expect(updatesOf()).toHaveLength(0);
        const live = fake.find('wiki_pages')[0];
        expect(hasCall(live, 'eq', 'id', 'p1')).toBe(true);
    });

    it('rejects an unknown page', async () => {
        arm({ live: { data: null } });
        await expect(updateWikiPage('p1', { title: 'x' }, 1, ADMIN)).rejects.toThrow('Wiki page not found or access denied.');
    });

    it('rejects an editor not cleared to SEE the live page (level or marker)', async () => {
        arm({ live: { data: { classification_level: 3, wiki_page_limiting_markers: [] } } });
        await expect(updateWikiPage('p1', { title: 'x' }, 1, CLEARED)).rejects.toThrow('You are not cleared to edit this page.');
        fake.reset();
        arm({ live: { data: { classification_level: null, wiki_page_limiting_markers: [{ marker: { id: 8, name: 'X' } }] } } });
        await expect(updateWikiPage('p1', { title: 'x' }, 1, CLEARED)).rejects.toThrow('You are not cleared to edit this page.');
        expect(updatesOf()).toHaveLength(0);
    });

    it('applies the mislabel-up guard to a new level, and to marker-only edits against the live level', async () => {
        arm({ live: { data: { classification_level: 2, wiki_page_limiting_markers: [] } } });
        await expect(updateWikiPage('p1', { classificationLevel: 3 }, 1, CLEARED)).rejects.toThrow('above your own clearance');
        await expect(updateWikiPage('p1', { markerIds: [99] }, 1, CLEARED)).rejects.toThrow('limiting marker you do not hold');
        expect(updatesOf()).toHaveLength(0);
    });

    it('rejects a title that strips to empty', async () => {
        arm();
        await expect(updateWikiPage('p1', { title: '<p></p>' }, 1, ADMIN)).rejects.toThrow('Wiki page title is required');
    });

    it('writes title+slug, sanitised content, level and lock; replaces markers; emits the page id', async () => {
        arm({ live: { data: { classification_level: 1, wiki_page_limiting_markers: [{ marker: NF }] } }, slugCount: 1 });
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        await updateWikiPage('p1', {
            title: 'New <b>Name</b>', content: doc(para('x', 'javascript:void(0)'), img(PRIVATE_SIGNED)), classificationLevel: 2,
            menuStructureLocked: 1 as unknown as boolean, markerIds: [7],
        }, 9, CLEARED);
        const slugQ = fake.find('wiki_pages').find(isCount)!;
        expect(hasCall(slugQ, 'eq', 'slug', 'new-name')).toBe(true);
        expect(hasCall(slugQ, 'neq', 'id', 'p1')).toBe(true);
        const u = updatesOf()[0];
        const p = u.payload as Record<string, unknown>;
        expect(p).toMatchObject({ updated_by_id: 9, title: 'New Name', classification_level: 2, menu_structure_locked: true, slug: `new-name-${(1_700_000_000_000).toString(36)}` });
        expect(JSON.stringify(p.content)).not.toContain('javascript:');
        expect(JSON.stringify(p.content)).toContain('"media/wiki/abc.webp"');
        expect('parent_page_id' in p).toBe(false);
        expect(hasCall(u, 'eq', 'id', 'p1')).toBe(true);
        const del = fake.find('wiki_page_limiting_markers', 'delete')[0];
        expect(hasCall(del, 'eq', 'page_id', 'p1')).toBe(true);
        expect(fake.find('wiki_page_limiting_markers', 'insert')[0].payload).toEqual([{ page_id: 'p1', marker_id: 7 }]);
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', { pageId: 'p1' });
    });

    it('a bare save writes only the audit fields and leaves markers alone', async () => {
        arm();
        await updateWikiPage('p1', {}, 3, LOW);
        expect(Object.keys(updatesOf()[0].payload as object).sort()).toEqual(['updated_at', 'updated_by_id']);
        expect(fake.find('wiki_page_limiting_markers')).toHaveLength(0);
        expect(fake.find('wiki_pages').some(isCount)).toBe(false);
    });

    it('enforces the image cap on content edits', async () => {
        arm();
        const many = Array.from({ length: 51 }, (_, i) => img(`https://cdn.myrsi-alpha.net/${i}.png`));
        await expect(updateWikiPage('p1', { content: doc(...many) }, 1, ADMIN)).rejects.toThrow('Too many images');
        expect(updatesOf()).toHaveLength(0);
    });

    describe('menu lock on parent moves', () => {
        it('blocks a parent change on a locked page with WIKI_PAGE_MENU_LOCKED', async () => {
            arm({ lock: { data: { parent_page_id: 'a', menu_structure_locked: true } } });
            const err = await updateWikiPage('p1', { parentPageId: 'b' }, 1, ADMIN).catch((e) => e);
            expect(err.code).toBe('WIKI_PAGE_MENU_LOCKED');
            expect(updatesOf()).toHaveLength(0);
        });

        it('allows a locked page to keep its parent and an unlocked page to move (null-normalised)', async () => {
            arm({ lock: { data: { parent_page_id: 'a', menu_structure_locked: true } } });
            await updateWikiPage('p1', { parentPageId: 'a' }, 1, ADMIN);
            expect(updatesOf()[0].payload).toMatchObject({ parent_page_id: 'a' });
            fake.reset();
            arm({ lock: { data: null } });
            await updateWikiPage('p1', { parentPageId: '' }, 1, ADMIN);
            expect(updatesOf()[0].payload).toMatchObject({ parent_page_id: null });
        });

        it('soft-fails on a missing lock column (42703) and still moves the page', async () => {
            arm({ lock: { data: null, error: { code: '42703', message: 'no column' } } });
            await updateWikiPage('p1', { parentPageId: 'b' }, 1, ADMIN);
            expect(updatesOf()[0].payload).toMatchObject({ parent_page_id: 'b' });
        });

        it('fails closed on any other lock lookup error', async () => {
            arm({ lock: { data: null, error: { code: '08006', message: 'conn' } } });
            await expect(updateWikiPage('p1', { parentPageId: 'b' }, 1, ADMIN)).rejects.toThrow('Failed to verify wiki page menu lock');
            expect(updatesOf()).toHaveLength(0);
        });
    });

    it('retries without menu_structure_locked on a 42703 update error', async () => {
        arm({ updates: [{ error: { code: '42703', message: 'col' } }, { error: null }] });
        await updateWikiPage('p1', { menuStructureLocked: false, title: 'X' }, 1, ADMIN);
        const [first, second] = updatesOf();
        expect(first.payload).toMatchObject({ menu_structure_locked: false });
        expect('menu_structure_locked' in (second.payload as object)).toBe(false);
        expect(second.payload).toMatchObject({ title: 'X' });
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', { pageId: 'p1' });
    });

    it('does not retry a 42703 when the lock field was not part of the patch, and surfaces other errors', async () => {
        arm({ updates: [{ error: { code: '42703', message: 'col' } }] });
        await expect(updateWikiPage('p1', { title: 'X' }, 1, ADMIN)).rejects.toThrow('Failed to update wiki page');
        expect(updatesOf()).toHaveLength(1);
        fake.reset();
        arm({ updates: [{ error: { code: '42703' } }, { error: { code: '42703' } }] });
        await expect(updateWikiPage('p1', { menuStructureLocked: true }, 1, ADMIN)).rejects.toThrow('Failed to update wiki page');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    describe('marker replace compensation', () => {
        it('restores the previous live markers when the re-insert fails, then throws', async () => {
            arm({ live: { data: { classification_level: 0, wiki_page_limiting_markers: [{ marker: NF }, { marker: { name: 'noid' } }] } }, mInserts: [{ error: { message: 'fk' } }, { error: null }] });
            await expect(updateWikiPage('p1', { markerIds: [] as number[] }, 1, ADMIN)).resolves.toBeUndefined();
            expect(fake.find('wiki_page_limiting_markers', 'insert')).toHaveLength(0); // [] = clear only
            fake.reset();
            broadcastSpy.mockClear();
            arm({ live: { data: { classification_level: 0, wiki_page_limiting_markers: [{ marker: NF }, { marker: { name: 'noid' } }] } }, mInserts: [{ error: { message: 'fk' } }, { error: null }] });
            await expect(updateWikiPage('p1', { markerIds: [9] }, 1, ADMIN)).rejects.toThrow('Failed to apply wiki page limiting markers');
            const [attempt, restore] = fake.find('wiki_page_limiting_markers', 'insert');
            expect(attempt.payload).toEqual([{ page_id: 'p1', marker_id: 9 }]);
            expect(restore.payload).toEqual([{ page_id: 'p1', marker_id: 7 }]);
            expect(broadcastSpy).not.toHaveBeenCalled();
        });

        it('skips the restore when the page had no markers, and still throws if the restore fails', async () => {
            arm({ mInserts: [{ error: { message: 'fk' } }] });
            await expect(updateWikiPage('p1', { markerIds: [9] }, 1, ADMIN)).rejects.toThrow('Failed to apply wiki page limiting markers');
            expect(fake.find('wiki_page_limiting_markers', 'insert')).toHaveLength(1);
            fake.reset();
            arm({ live: { data: { classification_level: 0, wiki_page_limiting_markers: [{ marker: NF }] } }, mInserts: [{ error: { message: 'fk' } }, { error: { message: 'again' } }] });
            await expect(updateWikiPage('p1', { markerIds: [9] }, 1, ADMIN)).rejects.toThrow('Failed to apply wiki page limiting markers');
            expect(fake.find('wiki_page_limiting_markers', 'insert')).toHaveLength(2);
        });

        it('throws when the marker clear itself fails', async () => {
            arm({ mDelete: { error: { message: 'x' } } });
            await expect(updateWikiPage('p1', { markerIds: [7] }, 1, ADMIN)).rejects.toThrow('Failed to clear wiki page limiting markers');
            expect(fake.find('wiki_page_limiting_markers', 'insert')).toHaveLength(0);
        });
    });
});

// -----------------------------------------------------------------------------
describe('deleteWikiPage', () => {
    function arm(o: { live?: unknown; children?: unknown; del?: unknown } = {}) {
        fake.on('wiki_pages', (q) => {
            if (q.op === 'select' && q.columns === LIVE_COLS) return (o.live as never) ?? { data: { classification_level: 0, wiki_page_limiting_markers: [] } };
            if (isCount(q)) return (o.children as never) ?? { count: 0 };
            if (q.op === 'delete') return (o.del as never) ?? { error: null };
            return { data: null };
        });
    }

    it('fails closed on a lookup error and rejects unknown / not-cleared pages', async () => {
        arm({ live: { data: null, error: { message: 'x' } } });
        await expect(deleteWikiPage('p1', ADMIN)).rejects.toThrow('refusing the delete');
        fake.reset(); arm({ live: { data: null } });
        await expect(deleteWikiPage('p1', ADMIN)).rejects.toThrow('Wiki page not found or access denied.');
        fake.reset(); arm({ live: { data: { classification_level: 1, wiki_page_limiting_markers: null } } });
        await expect(deleteWikiPage('p1', LOW)).rejects.toThrow('You are not cleared to delete this page.');
        expect(fake.find('wiki_pages', 'delete')).toHaveLength(0);
    });

    it('a leaf delete emits the page id (slice removal)', async () => {
        arm();
        await deleteWikiPage('p1', LOW);
        const probe = fake.find('wiki_pages').find(isCount)!;
        expect(hasCall(probe, 'eq', 'parent_page_id', 'p1')).toBe(true);
        expect(hasCall(fake.find('wiki_pages', 'delete')[0], 'eq', 'id', 'p1')).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', { pageId: 'p1' });
    });

    it('a parent delete (or a failed child probe) emits an id-less full-refetch nudge', async () => {
        arm({ children: { count: 2 } });
        await deleteWikiPage('p1', ADMIN);
        expect(broadcastSpy).toHaveBeenLastCalledWith('wiki_update', {});
        fake.reset(); arm({ children: { count: null, error: { message: 'probe' } } });
        await deleteWikiPage('p1', ADMIN);
        expect(broadcastSpy).toHaveBeenLastCalledWith('wiki_update', {});
    });

    it('surfaces the delete error without broadcasting', async () => {
        arm({ del: { error: { message: 'fk' } } });
        await expect(deleteWikiPage('p1', ADMIN)).rejects.toThrow('Failed to delete wiki page');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('reorderWikiPages', () => {
    it('is a no-op for an empty list', async () => {
        await reorderWikiPages([], ADMIN);
        expect(fake.queries).toHaveLength(0);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('surfaces a clearance lookup error instead of silently reordering nothing', async () => {
        fake.queue('wiki_pages', { data: null, error: { message: 'x' } });
        await expect(reorderWikiPages([{ id: 'a', sortOrder: 1 }], ADMIN)).rejects.toThrow('Failed to verify wiki page clearance for reorder');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('reorders only pages the actor can see; unknown ids are treated as invisible', async () => {
        fake.queue('wiki_pages', { data: [
            { id: 'open', classification_level: null, wiki_page_limiting_markers: null },
            { id: 'secret', classification_level: 3, wiki_page_limiting_markers: [] },
            { id: 'marked', classification_level: 0, wiki_page_limiting_markers: [{ marker: { id: 8 } }] },
        ] });
        await reorderWikiPages([{ id: 'open', sortOrder: 2 }, { id: 'secret', sortOrder: 0 }, { id: 'marked', sortOrder: 1 }, { id: 'ghost', sortOrder: 3 }], CLEARED);
        const live = fake.find('wiki_pages', 'select')[0];
        expect(live.columns).toBe(`id, ${LIVE_COLS}`);
        expect(hasCall(live, 'in', 'id', ['open', 'secret', 'marked', 'ghost'])).toBe(true);
        const ups = fake.find('wiki_pages', 'update');
        expect(ups).toHaveLength(1);
        expect(ups[0].payload).toEqual({ sort_order: 2 });
        expect(hasCall(ups[0], 'eq', 'id', 'open')).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', {});
    });

    it('surfaces a write error', async () => {
        fake.queue('wiki_pages', { data: [{ id: 'a', classification_level: 0 }] }, { error: { message: 'x' } });
        await expect(reorderWikiPages([{ id: 'a', sortOrder: 1 }], ADMIN)).rejects.toThrow('Failed to reorder wiki pages');
    });

    it('tolerates a null row set (nothing visible → nothing written)', async () => {
        fake.queue('wiki_pages', { data: null });
        await reorderWikiPages([{ id: 'a', sortOrder: 1 }], ADMIN);
        expect(fake.find('wiki_pages', 'update')).toHaveLength(0);
    });
});

// -----------------------------------------------------------------------------
describe('exportWikiPages', () => {
    function arm(branding: unknown, home: unknown) {
        fake.queue('wiki_pages', { data: [
            pageRow({ id: 'open', slug: 'open', sort_order: 1 }),
            pageRow({ id: 'secret', slug: 'secret', classification_level: 2, content: { type: 'doc', content: [para('TOP SECRET BODY')] } }),
            pageRow({ id: 'nf', slug: 'nf', wiki_page_limiting_markers: [{ marker: NF }] }),
        ] });
        fake.on('settings', (q) => {
            const key = filters(q, 'eq')[0]?.[1];
            return { data: key === 'brandingConfig' ? branding : home };
        });
    }

    it('applies the read-path clearance filter so bodies and marker names never leak', async () => {
        arm({ value: { name: 'Alpha Org' } }, { value: { title: 'Home' } });
        const out = await exportWikiPages(LOW);
        expect(out.pages.map((p) => p.id)).toEqual(['open']);
        expect(JSON.stringify(out)).not.toContain('TOP SECRET BODY');
        expect(JSON.stringify(out)).not.toContain('NOFORN');
        expect(out).toMatchObject({ version: 1, sourceOrg: { id: '', name: 'Alpha Org' }, wikiHomeConfig: { title: 'Home' } });
        expect(out.pages[0]).toEqual({ id: 'open', parentPageId: null, title: 'T', slug: 'open', content: doc(), classificationLevel: 0, sortOrder: 1, markerNames: [] });
        const settings = fake.find('settings');
        expect(settings.map((q) => q.columns)).toEqual(['value', 'value']);
        expect(hasCall(settings[0], 'eq', 'key', 'brandingConfig')).toBe(true);
        expect(hasCall(settings[1], 'eq', 'key', 'wikiHomeConfig')).toBe(true);
    });

    it('treats an absent actor as clearance 0 and falls back to defaults', async () => {
        arm({ data: null }, null);
        fake.on('settings', { data: null });
        const out = await exportWikiPages(undefined);
        expect(out.pages.map((p) => p.id)).toEqual(['open']);
        expect(out.sourceOrg.name).toBe('Organization');
        expect(out.wikiHomeConfig).toBeNull();
    });

    it('a cleared actor exports marker names of pages they can see', async () => {
        arm({ value: {} }, { value: null });
        const out = await exportWikiPages(CLEARED);
        expect(out.pages.map((p) => [p.id, p.markerNames])).toEqual([['open', []], ['secret', []], ['nf', ['NOFORN']]]);
        expect(out.sourceOrg.name).toBe('Organization');
    });
});

// -----------------------------------------------------------------------------
describe('importWikiPages', () => {
    const page = (over: Partial<WikiExportPage> = {}): WikiExportPage => ({
        id: 'src-1', parentPageId: null, title: 'Imported', slug: 'imported', content: doc(para('hi')),
        classificationLevel: 0, sortOrder: 1, markerNames: [], ...over,
    });
    const bundle = (pages: WikiExportPage[], extra: Partial<WikiExportBundle> = {}): WikiExportBundle => ({
        version: 1, exportedAt: 'x', sourceOrg: { id: '', name: 'Src' }, wikiHomeConfig: null, pages, ...extra,
    });

    interface ArmOpts { existing?: unknown; markers?: unknown; insert?: unknown; update?: unknown; parentUpdate?: unknown }
    function arm(o: ArmOpts = {}) {
        fake.on('wiki_pages', (q) => {
            if (q.op === 'select') return (o.existing as never) ?? { data: [] };
            if (q.op === 'insert') return (o.insert as never) ?? { error: null };
            if (q.op === 'update') {
                if ('parent_page_id' in (q.payload as object)) return (o.parentUpdate as never) ?? { error: null };
                return (o.update as never) ?? { error: null };
            }
            return { data: null };
        });
        fake.on('security_limiting_markers', (o.markers as never) ?? { data: [{ id: 7, name: 'NOFORN' }] });
        fake.on('wiki_page_limiting_markers', { error: null });
    }
    const writes = () => fake.queries.filter((q) => q.op !== 'select');

    it.each([
        [null], [{ version: 2, pages: [] }], [{ version: 1, pages: 'x' }],
    ])('rejects an invalid bundle %#', async (b) => {
        await expect(importWikiPages(b as unknown as WikiExportBundle, 'skip', false, 1, ADMIN)).rejects.toThrow('Invalid wiki export bundle');
    });

    it('rejects an unknown mode', async () => {
        await expect(importWikiPages(bundle([]), 'merge' as never, false, 1, ADMIN)).rejects.toThrow('Invalid import mode: merge');
        expect(fake.queries).toHaveLength(0);
    });

    it('fails closed when existing pages or markers cannot be loaded', async () => {
        arm({ existing: { data: null, error: { message: 'x' } } });
        await expect(importWikiPages(bundle([page()]), 'overwrite', false, 1, ADMIN)).rejects.toThrow('Failed to load existing wiki pages for import');
        fake.reset();
        arm({ markers: { data: null, error: { message: 'x' } } });
        await expect(importWikiPages(bundle([page()]), 'overwrite', false, 1, ADMIN)).rejects.toThrow('Failed to load limiting markers for import');
        expect(writes()).toHaveLength(0);
        const ex = fake.find('wiki_pages', 'select')[0];
        expect(ex.columns).toBe(`id, slug, ${LIVE_COLS}`);
        expect(fake.find('security_limiting_markers')[0].columns).toBe('id, name');
    });

    it('pre-flights every page BEFORE any write: unknown marker, mislabel-up, overwrite of an unseen page', async () => {
        arm();
        await expect(importWikiPages(bundle([page(), page({ id: 's2', slug: 's2', markerNames: ['GHOST'] })]), 'new', false, 1, ADMIN))
            .rejects.toThrow('references limiting marker "GHOST" which does not exist');
        await expect(importWikiPages(bundle([page({ classificationLevel: 3 })]), 'new', false, 1, CLEARED)).rejects.toThrow('above your own clearance');
        expect(writes()).toHaveLength(0);
        fake.reset();
        arm({ existing: { data: [{ id: 'live-1', slug: 'imported', classification_level: 3, wiki_page_limiting_markers: [] }] } });
        await expect(importWikiPages(bundle([page()]), 'overwrite', false, 1, CLEARED)).rejects.toThrow('not cleared to overwrite the existing page "imported"');
        expect(writes()).toHaveLength(0);
    });

    it('skip mode leaves existing slugs alone and inserts the rest', async () => {
        arm({ existing: { data: [{ id: 'live-1', slug: 'imported', classification_level: 0, wiki_page_limiting_markers: null }] } });
        const out = await importWikiPages(bundle([page(), page({ id: 's2', slug: 'fresh', markerNames: ['NOFORN'], classificationLevel: 1, title: '<b>T</b>' })]), 'skip', false, 4, ADMIN);
        expect(out).toEqual({ inserted: 1, updated: 0, skipped: 1 });
        const ins = fake.find('wiki_pages', 'insert')[0];
        const p = ins.payload as Record<string, unknown>;
        expect(p).toMatchObject({ parent_page_id: null, title: 'T', slug: 'fresh', classification_level: 1, sort_order: 1, created_by_id: 4, updated_by_id: 4 });
        expect(typeof p.id).toBe('string');
        expect(fake.find('wiki_page_limiting_markers', 'insert')[0].payload).toEqual([{ page_id: p.id, marker_id: 7 }]);
        expect(broadcastSpy).toHaveBeenCalledWith('wiki_update', {});
        expect(m.updateWikiHomeConfig).not.toHaveBeenCalled();
    });

    it('overwrite mode updates visible existing pages (sanitised), replacing markers with restore-on-failure semantics', async () => {
        arm({ existing: { data: [{ id: 'live-1', slug: 'imported', classification_level: 0, wiki_page_limiting_markers: [{ marker: NF }] }] } });
        const out = await importWikiPages(bundle([page({ title: '<script></script>', content: doc(para('x', 'javascript:alert(1)')), classificationLevel: undefined as unknown as number, sortOrder: undefined as unknown as number })]), 'overwrite', false, 2, ADMIN);
        expect(out).toEqual({ inserted: 0, updated: 1, skipped: 0 });
        const up = fake.find('wiki_pages', 'update')[0];
        expect(hasCall(up, 'eq', 'id', 'live-1')).toBe(true);
        expect(up.payload).toMatchObject({ title: 'Untitled', classification_level: 0, sort_order: 0, updated_by_id: 2 });
        expect(JSON.stringify((up.payload as { content: unknown }).content)).not.toContain('javascript:');
        expect(hasCall(fake.find('wiki_page_limiting_markers', 'delete')[0], 'eq', 'page_id', 'live-1')).toBe(true);
    });

    it('overwrite mode inserts a non-colliding page at its own slug', async () => {
        arm();
        const out = await importWikiPages(bundle([page({ slug: 'brand-new' })]), 'overwrite', false, 1, ADMIN);
        expect(out).toEqual({ inserted: 1, updated: 0, skipped: 0 });
        expect(fake.find('wiki_pages', 'insert')[0].payload).toMatchObject({ slug: 'brand-new' });
    });

    it('new mode always inserts, de-duplicating slugs against existing AND earlier bundle pages', async () => {
        arm({ existing: { data: [{ id: 'live-1', slug: 'dup', classification_level: 0 }] } });
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const ts = (1_700_000_000_000).toString(36);
        await importWikiPages(bundle([page({ id: 'a', slug: 'dup' }), page({ id: 'b', slug: 'dup' }), page({ id: 'c', slug: 'solo' })]), 'new', false, 1, ADMIN);
        expect(fake.find('wiki_pages', 'insert').map((q) => (q.payload as { slug: string }).slug)).toEqual([`dup-${ts}`, `dup-${ts}-1`, 'solo']);
    });

    it('re-links parent references to the new target ids (skips orphans and skipped pages; logs link failures)', async () => {
        arm({ existing: { data: [{ id: 'live-kid', slug: 'kept', classification_level: 0 }] }, parentUpdate: { error: { message: 'x' } } });
        const out = await importWikiPages(bundle([
            page({ id: 'root', slug: 'root' }),
            page({ id: 'kid', slug: 'kid', parentPageId: 'root' }),
            page({ id: 'orphan', slug: 'orphan', parentPageId: 'not-in-bundle' }),
            page({ id: 'kept', slug: 'kept', parentPageId: 'root' }),
        ]), 'skip', false, 1, ADMIN);
        expect(out).toEqual({ inserted: 3, updated: 0, skipped: 1 });
        const ids = Object.fromEntries(fake.find('wiki_pages', 'insert').map((q) => [(q.payload as { slug: string }).slug, (q.payload as { id: string }).id]));
        const links = fake.find('wiki_pages', 'update').filter((q) => 'parent_page_id' in (q.payload as object));
        expect(links).toHaveLength(1);
        expect(links[0].payload).toEqual({ parent_page_id: ids.root });
        expect(hasCall(links[0], 'eq', 'id', ids.kid)).toBe(true);
    });

    it('replaces (not merges) the home config when asked and the bundle carries one', async () => {
        arm();
        await importWikiPages(bundle([], { wikiHomeConfig: { title: 'H' } as never }), 'new', true, 1, ADMIN);
        expect(m.updateWikiHomeConfig).toHaveBeenCalledWith({ title: 'H' }, { merge: false });
        m.updateWikiHomeConfig.mockClear();
        await importWikiPages(bundle([]), 'new', true, 1, ADMIN);
        expect(m.updateWikiHomeConfig).not.toHaveBeenCalled();
    });

    it('surfaces insert and overwrite write errors', async () => {
        arm({ insert: { error: { message: 'x' } } });
        await expect(importWikiPages(bundle([page()]), 'new', false, 1, ADMIN)).rejects.toThrow('Failed to import wiki pages');
        fake.reset();
        arm({ existing: { data: [{ id: 'l', slug: 'imported', classification_level: 0 }] }, update: { error: { message: 'x' } } });
        await expect(importWikiPages(bundle([page()]), 'overwrite', false, 1, ADMIN)).rejects.toThrow('Failed to overwrite wiki page during import');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('tolerates null existing/marker row sets and a non-array markerNames', async () => {
        arm({ existing: { data: null }, markers: { data: null } });
        const out = await importWikiPages(bundle([page({ markerNames: 'x' as unknown as string[] })]), 'overwrite', false, 1, LOW);
        expect(out).toEqual({ inserted: 1, updated: 0, skipped: 0 });
    });
});
