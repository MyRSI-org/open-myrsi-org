import { describe, it, expect, vi, beforeEach } from 'vitest';

// read-scope-1: getAnnouncementsState filters notices by the caller's audience
// SERVER-SIDE (the client filter is cosmetic). A Client must never receive an
// Admin-only / staff-only notice body; managers (Admin or admin:config:notices)
// see all for the management tab.

const h = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
    lastContains: null as { col: string; vals: string[] } | null,
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = () => b;
        }
        // Faithful stand-in for PostgREST's `cs` (array contains) so a query-level
        // audience filter is actually exercised, not just asserted on the result.
        let contains: { col: string; vals: string[] } | null = null;
        b.contains = (col: string, vals: string[]) => { contains = { col, vals }; h.lastContains = { col, vals }; return b; };
        const rows = () => contains
            ? h.rows.filter((r) => Array.isArray(r[contains!.col]) && contains!.vals.every((v) => (r[contains!.col] as string[]).includes(v)))
            : h.rows;
        const settle = () => Promise.resolve({ data: rows(), error: null });
        b.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        b.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: () => builder(), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}), safeFetch: async () => [],
    };
});

import { getAnnouncementsState, getLoginScreenAnnouncements } from '../lib/db';

beforeEach(() => {
    h.lastContains = null;
    h.rows = [
        { id: 'a1', title: 'Member notice', body: 'm', audience: ['Member'], publish_date: 't' },
        { id: 'a2', title: 'Admin only', body: 'secret', audience: ['Admin'], publish_date: 't' },
        { id: 'a3', title: 'All', body: 'x', audience: ['Member', 'Client'], publish_date: 't' },
    ];
});

const ids = (r: { announcements: Array<{ id: string }> }) => r.announcements.map(a => a.id).sort();

describe('getAnnouncementsState audience scoping', () => {
    it('a Client sees only Client-audience notices', async () => {
        const out = await getAnnouncementsState({ role: 'Client', permissions: [] });
        expect(ids(out)).toEqual(['a3']);
    });
    it('a Member sees Member-audience notices, not Admin-only', async () => {
        const out = await getAnnouncementsState({ role: 'Member', permissions: [] });
        expect(ids(out)).toEqual(['a1', 'a3']);
    });
    it('a Dispatcher inherits Member-targeted notices', async () => {
        const out = await getAnnouncementsState({ role: 'Dispatcher', permissions: [] });
        expect(ids(out)).toEqual(['a1', 'a3']);
    });
    it('an Admin sees everything', async () => {
        const out = await getAnnouncementsState({ role: 'Admin', permissions: [] });
        expect(ids(out)).toEqual(['a1', 'a2', 'a3']);
    });
    it('admin:config:notices manager sees everything', async () => {
        const out = await getAnnouncementsState({ role: 'Member', permissions: ['admin:config:notices'] });
        expect(ids(out)).toEqual(['a1', 'a2', 'a3']);
    });
    it('an absent caller sees nothing (fail closed)', async () => {
        const out = await getAnnouncementsState(null);
        expect(out.announcements).toEqual([]);
    });
});

// The anonymous public page previously called getAnnouncementsState() with no
// viewer. That helper scopes by ROLE and — correctly — drops every row when
// there is no viewer, so the public Notices card was permanently empty. The fix
// is a dedicated pre-auth read, NOT a loosening of the role filter; both halves
// are pinned here so a future "fix" can't take the unsafe route.
describe('getLoginScreenAnnouncements (pre-auth public page read)', () => {
    // Scoped to this block so the manager-sees-everything assertions above keep
    // their exact expected sets.
    beforeEach(() => {
        h.rows = [...h.rows, { id: 'a4', title: 'Welcome', body: 'public', audience: ['Login Screen'], publish_date: 't' }];
    });

    it('returns Login Screen notices for an anonymous caller', async () => {
        expect(ids(await getLoginScreenAnnouncements())).toEqual(['a4']);
    });

    it('scopes to the Login Screen audience IN THE QUERY, not after the fact', async () => {
        await getLoginScreenAnnouncements();
        expect(h.lastContains).toEqual({ col: 'audience', vals: ['Login Screen'] });
    });

    it('never surfaces Member / Client / Admin-audience notices to anonymous callers', async () => {
        const out = ids(await getLoginScreenAnnouncements());
        expect(out).not.toContain('a1');
        expect(out).not.toContain('a2');
        expect(out).not.toContain('a3');
    });

    it('getAnnouncementsState with no viewer still returns nothing (stays fail-closed)', async () => {
        expect(ids(await getAnnouncementsState())).toEqual([]);
        expect(ids(await getAnnouncementsState(null))).toEqual([]);
    });
});
