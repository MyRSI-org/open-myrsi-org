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

import { deleteWikiPage, reorderWikiPages } from '../lib/db/wiki';
import { wikiActions } from '../api/actions/wiki';
import type { ClearanceUser } from '../lib/clearance';
import type { User } from '../types';

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.broadcasts = [];
});

const actor = (over: Record<string, unknown> = {}): ClearanceUser => ({
    role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [],
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

    it('lets an Admin delete a classified page (bypass intact)', async () => {
        wireDelete(5);
        await expect(deleteWikiPage('p1', actor({ role: 'Admin' }))).resolves.toBeUndefined();
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

    it('lets an Admin reorder every page (bypass intact)', async () => {
        const updates = wireReorder([
            { id: 'classified', level: 5 },
            { id: 'public', level: 0 },
        ]);
        await reorderWikiPages([{ id: 'classified', sortOrder: 9999 }, { id: 'public', sortOrder: 1 }], actor({ role: 'Admin' }));
        expect(updates.map((u) => u.id)).toEqual(['classified', 'public']);
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
