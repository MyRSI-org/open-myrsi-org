import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verifies the per-page clearance gates on deleteWikiPage and
// reorderWikiPages. The dispatcher only checks the coarse
// wiki:delete_page / wiki:edit_page permission (both held by the default
// non-Admin Dispatcher role) with NO per-page clearance, so the db layer must
// re-apply the SAME live-visibility guard that updateWikiPage/importWikiPages
// enforce — otherwise a clearance-0 holder who learns a classified page's id can
// destroy it (delete) or reshuffle/relocate it (reorder) without ever being able
// to read it.
//
// Driven through a select-string-aware supabase mock (mirrors
// tests/accessControlGuards.test.ts) so the live-classification fetch, the
// child-count probe, and the actual mutation are all exercised.

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

// Handler-level mock of the db barrel (lib/db.ts). The api/actions/wiki handlers
// must thread the dispatcher-injected `user` actor into the db layer — if the
// handler drops it (db.deleteWikiPage(id) with no actor), the db-direct tests
// below could never catch it because they pass the actor explicitly. These
// spies let us assert the 2nd arg is the actor.
const dbMock = vi.hoisted(() => ({
    deleteWikiPage: vi.fn((_id: string, _user?: unknown): Promise<void> => Promise.resolve()),
    reorderWikiPages: vi.fn((_pages: unknown, _user?: unknown): Promise<void> => Promise.resolve()),
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

// Mock the db barrel used by the handlers (api/actions/wiki imports
// '../../lib/db.js'). Fully stubbed so importing the handler module does not pull
// in the real (heavy) db layer; only the two functions under test are spies.
vi.mock('../lib/db', () => ({
    deleteWikiPage: dbMock.deleteWikiPage,
    reorderWikiPages: dbMock.reorderWikiPages,
    createWikiPage: vi.fn(),
    updateWikiPage: vi.fn(),
    exportWikiPages: vi.fn(),
    importWikiPages: vi.fn(),
}));

import { createWikiPage, updateWikiPage, deleteWikiPage, reorderWikiPages } from '../lib/db/wiki';
import { wikiActions } from '../api/actions/wiki';
import type { ClearanceUser } from '../lib/clearance';
import type { User } from '../types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeCssLength } from '../components/views/wiki/extensions/IframeExtension';

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.broadcasts = [];
});

// The wiki passes an EMPTY bypass list at every clearance call site (there is no
// wiki:manage permission), so `isSystemAdmin` — role IDENTITY, stamped by
// getUserById — is the entire bypass here. A `role: 'Admin'` fixture must NOT clear
// it: the name is not authority.
const actor = (over: Record<string, unknown> = {}): ClearanceUser => ({
    permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [],
    ...over,
} as ClearanceUser);

// Wire the wiki_pages mock for the delete path: the live-classification fetch
// (select 'classification_level, ...' + maybeSingle) returns `liveLevel`; the
// child-count probe returns count 0; the delete succeeds.
function wireDelete(liveLevel: number, liveMarkers: unknown[] = []) {
    h.resolveQuery = ({ table, calls }) => {
        if (table !== 'wiki_pages') return { data: null, error: null };
        if (calls.some((c) => c.method === 'delete')) return { data: null, error: null };
        const sel = String(calls.find((c) => c.method === 'select')?.args[0] ?? '');
        if (sel.startsWith('classification_level')) {
            return { data: { classification_level: liveLevel, wiki_page_limiting_markers: liveMarkers.map((m) => ({ marker: m })) }, error: null };
        }
        // child-count probe: select('id', { count: 'exact', head: true })
        return { data: null, error: null, count: 0 };
    };
}

describe('deleteWikiPage per-page clearance gate', () => {
    it('blocks a clearance-0 holder from deleting a classified page they cannot see', async () => {
        wireDelete(5);
        await expect(deleteWikiPage('p1', actor())).rejects.toThrow(/not cleared/i);
    });

    it('blocks deletion when the actor lacks a limiting marker the page carries', async () => {
        wireDelete(0, [{ id: 7, code: 'NOFORN', name: 'NOFORN' }]);
        await expect(deleteWikiPage('p1', actor())).rejects.toThrow(/not cleared/i);
    });

    it('fails closed for a missing actor on a classified page', async () => {
        wireDelete(3);
        await expect(deleteWikiPage('p1', undefined)).rejects.toThrow(/not cleared/i);
    });

    it('lets the stamped system Admin delete a classified page (bypass intact)', async () => {
        wireDelete(5);
        await expect(deleteWikiPage('p1', actor({ isSystemAdmin: true }))).resolves.toBeUndefined();
    });

    it('refuses a forged Admin role NAME with no permissions and clearance 0', async () => {
        wireDelete(5);
        await expect(deleteWikiPage('p1', actor({ role: 'Admin' }))).rejects.toThrow(/not cleared/i);
    });

    it('lets a sufficiently-cleared author delete the page', async () => {
        wireDelete(2);
        await expect(deleteWikiPage('p1', actor({ clearanceLevel: { level: 4 } }))).resolves.toBeUndefined();
    });

    it('allows deleting an unclassified page even with no actor (no behaviour change for public pages)', async () => {
        wireDelete(0);
        await expect(deleteWikiPage('p1', undefined)).resolves.toBeUndefined();
    });
});

// The clearance guards used to be written `if (live) { ... }` against a lookup that
// discarded its Supabase `error`, so a failed read SKIPPED the check and the write
// went through unguarded. That window is reachable: the lookup carries a PostgREST
// embed (wiki_page_limiting_markers(...)), and an unconverged schema cache answers
// PGRST200 with data null — while the UPDATE/DELETE, which carry no embed, still
// succeed. Every write path must now refuse rather than proceed unchecked.
describe('wiki write-path clearance fails CLOSED on a lookup error', () => {
    // Record every mutation the mock sees so a test can assert NOTHING was written.
    function wireLookupError(err: unknown = { code: 'PGRST200', message: 'Could not find a relationship in the schema cache' }) {
        const writes: Array<{ table: string; method: string }> = [];
        h.resolveQuery = ({ table, calls }) => {
            for (const m of ['update', 'insert', 'delete', 'upsert']) {
                if (calls.some((c) => c.method === m)) { writes.push({ table, method: m }); return { data: null, error: null }; }
            }
            return { data: null, error: err };
        };
        return writes;
    }

    it('updateWikiPage refuses the edit and writes nothing', async () => {
        const writes = wireLookupError();
        await expect(updateWikiPage('p1', { title: 'pwned', markerIds: [] }, 1, actor()))
            .rejects.toThrow(/Failed to verify wiki page clearance/);
        expect(writes).toEqual([]);
    });

    it('deleteWikiPage refuses and never reaches the DELETE', async () => {
        const writes = wireLookupError();
        await expect(deleteWikiPage('p1', actor())).rejects.toThrow(/Failed to verify wiki page clearance/);
        expect(writes.filter((w) => w.method === 'delete')).toEqual([]);
        expect(h.broadcasts).toEqual([]);
    });

    it('reorderWikiPages refuses instead of silently reordering nothing and reporting success', async () => {
        const writes = wireLookupError();
        await expect(reorderWikiPages([{ id: 'p1', sortOrder: 1 }], actor()))
            .rejects.toThrow(/Failed to verify wiki page clearance for reorder/);
        expect(writes.filter((w) => w.method === 'update')).toEqual([]);
        expect(h.broadcasts).toEqual([]);
    });

    // A clean not-found (maybeSingle → data null, error null) is now a denial too,
    // matching lib/db/ops.ts updateOperationDetails, rather than a silent no-op that
    // still broadcasts success.
    it('a page that does not exist is a denial, not a silent no-op', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await expect(updateWikiPage('gone', { title: 'x' }, 1, actor())).rejects.toThrow(/not found or access denied/i);
        await expect(deleteWikiPage('gone', actor())).rejects.toThrow(/not found or access denied/i);
        expect(h.broadcasts).toEqual([]);
    });
});

// The limiting-marker writes discarded their errors too. updateWikiPage's is a
// delete-then-reinsert, so a swallowed insert failure after a successful delete left
// the page with NO compartment markers — strictly WIDER access than the caller asked
// for — behind a 200.
describe('wiki limiting-marker writes fail CLOSED', () => {
    const adminActor = () => actor({ isSystemAdmin: true });

    // `markerInsertFails` errors the wiki_page_limiting_markers INSERT only; every
    // other statement succeeds. Returns the recorded calls for inspection.
    function wireMarkerWrites(liveMarkers: unknown[], opts: { newPageId?: string } = {}) {
        const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
        h.resolveQuery = ({ table, calls: qc }) => {
            const mutation = ['update', 'insert', 'delete', 'upsert'].find((m) => qc.some((c) => c.method === m));
            if (mutation) {
                const args = qc.find((c) => c.method === mutation)!.args;
                const eqArgs = qc.filter((c) => c.method === 'eq').map((c) => c.args);
                calls.push({ table, method: mutation, args: [...args, ...eqArgs] });
                if (table === 'wiki_page_limiting_markers' && mutation === 'insert') {
                    const rows = args[0] as Array<{ marker_id: number }>;
                    // The restore attempt (previous ids) must be allowed to succeed so the
                    // test can tell a restore apart from the failed primary insert.
                    const isRestore = rows.every((r) => liveMarkers.some((m) => (m as { id: number }).id === r.marker_id));
                    if (!isRestore) return { data: null, error: { code: '23503', message: 'insert failed' } };
                }
                if (table === 'wiki_pages' && mutation === 'insert') {
                    return { data: { id: opts.newPageId ?? 'new1' }, error: null };
                }
                return { data: null, error: null };
            }
            if (table !== 'wiki_pages') return { data: null, error: null };
            const sel = String(qc.find((c) => c.method === 'select')?.args[0] ?? '');
            if (sel.startsWith('classification_level')) {
                return { data: { classification_level: 0, wiki_page_limiting_markers: liveMarkers.map((m) => ({ marker: m })) }, error: null };
            }
            return { data: null, error: null, count: 0 };
        };
        return calls;
    }

    it('updateWikiPage restores the previous markers and throws rather than leaving the page decompartmented', async () => {
        const prev = [{ id: 3, code: 'HCS', name: 'HCS' }];
        const calls = wireMarkerWrites(prev);
        await expect(updateWikiPage('p1', { markerIds: [7] }, 1, adminActor()))
            .rejects.toThrow(/Failed to apply wiki page limiting markers/);
        const markerInserts = calls.filter((c) => c.table === 'wiki_page_limiting_markers' && c.method === 'insert');
        // 1st = the failed new set, 2nd = the compensating restore of the live set.
        expect(markerInserts).toHaveLength(2);
        expect(markerInserts[1].args[0]).toContainEqual(expect.objectContaining({ marker_id: 3 }));
        expect(h.broadcasts).toEqual([]);
    });

    it('createWikiPage removes the page it just created and emits no broadcast for it', async () => {
        const calls = wireMarkerWrites([], { newPageId: 'fresh1' });
        await expect(createWikiPage({ title: 'Secret', markerIds: [7] }, 1, adminActor()))
            .rejects.toThrow(/Failed to apply wiki page limiting markers/);
        const cleanup = calls.filter((c) => c.table === 'wiki_pages' && c.method === 'delete');
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0].args).toContainEqual(['id', 'fresh1']);
        expect(h.broadcasts).toEqual([]);
    });
});

// Wire the reorder path: the bulk classification SELECT (.in('id', ids))
// returns a fixed level map; every update is recorded so the test can assert
// exactly which pages were reordered.
function wireReorder(rows: Array<{ id: string; level: number; markers?: unknown[] }>): Array<{ id: string; sortOrder: number }> {
    const updates: Array<{ id: string; sortOrder: number }> = [];
    h.resolveQuery = ({ table, calls }) => {
        if (table !== 'wiki_pages') return { data: null, error: null };
        const updateCall = calls.find((c) => c.method === 'update');
        if (updateCall) {
            const eqCall = calls.find((c) => c.method === 'eq');
            const sortOrder = (updateCall.args[0] as { sort_order: number }).sort_order;
            updates.push({ id: String(eqCall?.args[1]), sortOrder });
            return { data: null, error: null };
        }
        if (calls.some((c) => c.method === 'in')) {
            return {
                data: rows.map((r) => ({
                    id: r.id,
                    classification_level: r.level,
                    wiki_page_limiting_markers: (r.markers || []).map((m) => ({ marker: m })),
                })),
                error: null,
            };
        }
        return { data: null, error: null };
    };
    return updates;
}

describe('reorderWikiPages per-page clearance gate', () => {
    it('skips the classified page but still reorders the public page for a clearance-0 editor', async () => {
        const updates = wireReorder([
            { id: 'classified', level: 5 },
            { id: 'public', level: 0 },
        ]);
        await reorderWikiPages([{ id: 'classified', sortOrder: 9999 }, { id: 'public', sortOrder: 1 }], actor());
        expect(updates.map((u) => u.id)).toEqual(['public']);
        expect(updates.find((u) => u.id === 'classified')).toBeUndefined();
    });

    it('skips a page guarded by a marker the editor does not hold', async () => {
        const updates = wireReorder([
            { id: 'compartmented', level: 0, markers: [{ id: 9, code: 'HCS', name: 'HCS' }] },
            { id: 'public', level: 0 },
        ]);
        await reorderWikiPages([{ id: 'compartmented', sortOrder: 2 }, { id: 'public', sortOrder: 1 }], actor());
        expect(updates.map((u) => u.id)).toEqual(['public']);
    });

    it('lets the stamped system Admin reorder every page (bypass intact)', async () => {
        const updates = wireReorder([
            { id: 'classified', level: 5 },
            { id: 'public', level: 0 },
        ]);
        await reorderWikiPages([{ id: 'classified', sortOrder: 9999 }, { id: 'public', sortOrder: 1 }], actor({ isSystemAdmin: true }));
        expect(updates.map((u) => u.id)).toEqual(['classified', 'public']);
    });

    it('skips the classified page for a forged Admin role NAME', async () => {
        const updates = wireReorder([
            { id: 'classified', level: 5 },
            { id: 'public', level: 0 },
        ]);
        await reorderWikiPages([{ id: 'classified', sortOrder: 9999 }, { id: 'public', sortOrder: 1 }], actor({ role: 'Admin' }));
        expect(updates.map((u) => u.id)).toEqual(['public']);
    });

    it('lets a sufficiently-cleared editor reorder the page within their clearance', async () => {
        const updates = wireReorder([{ id: 'sop', level: 2 }]);
        await reorderWikiPages([{ id: 'sop', sortOrder: 3 }], actor({ clearanceLevel: { level: 3 } }));
        expect(updates.map((u) => u.id)).toEqual(['sop']);
    });
});

// Handler-level guard: the dispatcher injects the
// authenticated actor as `user` in the payload, but the per-page clearance gates
// live in the db layer — so the handler must forward `user` as the 2nd argument.
// If the handlers call db.deleteWikiPage(id) / db.reorderWikiPages(pages)
// with NO actor, the gate is defeated entirely. These tests drive the real
// wikiActions handlers and fail if the actor is dropped.
describe('wiki handlers thread the dispatcher actor into the db layer', () => {
    beforeEach(() => {
        dbMock.deleteWikiPage.mockClear();
        dbMock.reorderWikiPages.mockClear();
    });

    const dispatcherUser = (): User => ({ id: 1, role: 'Member' } as unknown as User);

    it('wiki:delete_page forwards `user` as the actor (2nd arg), not undefined', async () => {
        const user = dispatcherUser();
        await wikiActions['wiki:delete_page']({ id: 'p1', user });
        expect(dbMock.deleteWikiPage).toHaveBeenCalledWith('p1', user);
        // Pin the actor position explicitly — a missing 2nd arg defeats the gate.
        expect(dbMock.deleteWikiPage.mock.calls[0][1]).toBe(user);
    });

    it('wiki:reorder_pages forwards `user` as the actor (2nd arg), not undefined', async () => {
        const user = dispatcherUser();
        const pages = [{ id: 'p1', sortOrder: 1 }];
        await wikiActions['wiki:reorder_pages']({ pages, user });
        expect(dbMock.reorderWikiPages).toHaveBeenCalledWith(pages, user);
        expect(dbMock.reorderWikiPages.mock.calls[0][1]).toBe(user);
    });
});

describe('iframe geometry cannot smuggle CSS declarations', () => {
    // width/height are author-controlled node attributes, and renderHTML interpolates
    // them into a `style` string. Anything containing a `;` stops being a length and
    // becomes extra declarations — so a wiki author could pin an allow-listed
    // third-party frame over the whole viewport of every page the embed appears on.
    // The host allow-list is not the control: the frame is from a permitted host, and
    // the injection is in the geometry.
    it('accepts ordinary lengths', () => {
        for (const v of ['100%', '400px', '80vw', '50vh', '640', '12.5rem']) {
            expect(safeCssLength(v, 'FALLBACK'), `${v} should be accepted`).toBe(v);
        }
    });

    it('refuses anything that could close the declaration', () => {
        for (const v of [
            '100%; position: fixed; top: 0; left: 0; z-index: 9999',
            '100%;position:fixed',
            'calc(100% - 10px)',
            'expression(alert(1))',
            'url(javascript:alert(1))',
            '100% !important',
            '',
            null,
            undefined,
            '99999999px',
        ]) {
            expect(safeCssLength(v, 'FALLBACK'), `${String(v)} was accepted`).toBe('FALLBACK');
        }
    });

    it('the renderer coerces both dimensions rather than interpolating them', () => {
        const src = readFileSync(resolve(__dirname, '..', 'components', 'views', 'wiki', 'extensions', 'IframeExtension.ts'), 'utf8');
        const render = src.slice(src.indexOf('renderHTML('), src.indexOf('addCommands('));
        expect(render).toMatch(/safeCssLength\(HTMLAttributes\.width/);
        expect(render).toMatch(/safeCssLength\(HTMLAttributes\.height/);
        expect(render, 'a raw attribute is being interpolated into style again')
            .not.toMatch(/\$\{HTMLAttributes\.(width|height)\s*\|\|/);
    });
});
