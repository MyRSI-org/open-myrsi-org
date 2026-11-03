import { describe, it, expect, vi, beforeEach } from 'vitest';

// wiki:export_pages is mapped to admin:access — an admin-panel bucket the seeded Dispatcher
// also holds, and one a custom role can carry without wiki:view. The export returns the same
// page bodies the 'wiki' read subset serves behind wiki:view, so without its own check it was
// a second route to the wiki for a caller the read path refuses. The handler now asks the
// read path's question (permissionSatisfied(perms, 'wiki:view'), no role-name bypass).

const h = vi.hoisted(() => ({
    user: { id: 1, role: 'Member', permissions: [] as string[] } as Record<string, unknown>,
    exportWikiPages: vi.fn(async (_user?: unknown) => ({ version: 1, pages: [] })),
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => ({ userId: 1 }),
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => 'rt-token',
}));
vi.mock('../lib/db/userFilters', () => ({
    stripSensitiveUserFields: (u: unknown) => u,
    stripSensitiveUserFieldsBulk: (u: unknown) => u,
}));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    findActiveBan: async () => null,
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    isOptionalFeatureEnabled: async () => true,
    isClientCaller: async () => false,
    recordSecurityEvent: async () => undefined,
    exportWikiPages: h.exportWikiPages,
}));

import { wikiActions } from '../api/actions/wiki';
import servicesHandler, { fullPermissionMap } from '../api/services';
import { isSecurityDenial } from '../lib/errors';
import type { User } from '../types';

const asUser = (perms: string[], over: Record<string, unknown> = {}) =>
    ({ id: 1, role: 'Member', permissions: perms, ...over }) as unknown as User;

beforeEach(() => { h.exportWikiPages.mockClear(); });

describe('wiki:export_pages handler requires wiki:view', () => {
    it('refuses an admin:access holder without wiki:view, before any read', () => {
        let thrown: unknown;
        try { void wikiActions['wiki:export_pages']({ user: asUser(['admin:access']) }); } catch (e) { thrown = e; }
        expect(isSecurityDenial(thrown)).toBe(true);
        expect((thrown as Error).message).not.toMatch(/admin:access|wiki:view/);
        expect(h.exportWikiPages).not.toHaveBeenCalled();
    });

    it('refuses a missing actor (fail closed)', () => {
        expect(() => wikiActions['wiki:export_pages']({})).toThrow();
        expect(h.exportWikiPages).not.toHaveBeenCalled();
    });

    // The role NAME is free text (lib/db/mappers.ts) and the wiki read gate has no
    // role-name bypass, so neither does this.
    it('a role merely NAMED Admin is not authority', () => {
        expect(() => wikiActions['wiki:export_pages']({ user: asUser(['admin:access'], { role: 'Admin' }) })).toThrow();
        expect(h.exportWikiPages).not.toHaveBeenCalled();
    });

    it('exports for a wiki:view holder, threading the actor for the clearance filter', async () => {
        const user = asUser(['admin:access', 'wiki:view']);
        await wikiActions['wiki:export_pages']({ user });
        expect(h.exportWikiPages).toHaveBeenCalledWith(user);
    });
});

describe('wiki:export_pages through the dispatcher', () => {
    const post = () => ({ method: 'POST', secure: false, query: {}, headers: { authorization: 'Bearer tok' }, body: { action: 'wiki:export_pages', payload: {} } }) as any;
    function mockRes() {
        const res: any = { statusCode: 0, body: undefined, headers: {} };
        res.status = (c: number) => { res.statusCode = c; return res; };
        res.json = (b: unknown) => { res.body = b; return res; };
        res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
        return res;
    }

    it('is still mapped to admin:access (the handler check is in ADDITION, not instead)', () => {
        expect(fullPermissionMap['wiki:export_pages']).toBe('admin:access');
    });

    it('403s an admin:access-only caller — a denial, not a 500', async () => {
        h.user = { id: 1, role: 'Member', permissions: ['admin:access'] };
        const res = mockRes();
        await servicesHandler(post(), res);
        expect(res.statusCode).toBe(403);
        expect(h.exportWikiPages).not.toHaveBeenCalled();
    });

    it('serves a caller holding both', async () => {
        h.user = { id: 1, role: 'Member', permissions: ['admin:access', 'wiki:view'] };
        const res = mockRes();
        await servicesHandler(post(), res);
        expect(res.statusCode).toBe(200);
        expect(h.exportWikiPages).toHaveBeenCalledTimes(1);
    });
});
