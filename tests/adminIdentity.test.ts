import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Admin-identity primitive (lib/db/adminIdentity.ts) and the resolver it rests
// on (getSystemRoles, lib/db/common.ts).
//
// `User.role` is NOT a privilege fact: toUser derives a tier from the role row's
// free-text NAME, and roles.name carries only a CASE-SENSITIVE unique constraint —
// so 'Commander', or literally 'admin', resolved to UserRole.Admin with zero
// permissions. Nine apex gates plus the whole clearance module now key on role
// IDENTITY instead. That makes getSystemRoles load-bearing, so the two shortcuts it
// used to take are pinned dead here:
//   1. positional election (`systemRoles[3]` / `roles[3]`) — hands the org's apex
//      identity to whatever custom role happens to sort fourth;
//   2. a bare case-insensitive /^admin$/i match — the exact channel the reserved-name
//      guard exists to close.
// Both now resolve to `admin: undefined`, which is the DENY answer at every consumer.

const h = vi.hoisted(() => ({
    // Rows the mocked PostgREST returns, split by whether .eq('is_system', true) ran.
    systemRows: [] as Array<{ id: number; name: string; is_system?: boolean }>,
    allRows: [] as Array<{ id: number; name: string; is_system?: boolean }>,
    // Rows for a single .eq('id', n) role lookup (the fresh resolver's last resort).
    byId: null as { id: number; name: string; is_system?: boolean } | null,
    queries: 0,
    store: new Map<string, unknown>(),
}));

vi.mock('../lib/cache', () => ({
    cache: {
        get: (k: string) => h.store.get(k),
        set: (k: string, v: unknown) => { h.store.set(k, v); },
        invalidate: (k: string) => { h.store.delete(k); },
        invalidatePrefix: () => {},
    },
    TTL: { PLATFORM_SETTINGS: 1, SYSTEM_ROLES: 1, OP_ACCESS: 1 },
}));

vi.mock('../lib/supabaseServer', () => {
    function builder() {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'delete']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            h.queries++;
            const systemOnly = calls.some(c => c.method === 'eq' && c.args[0] === 'is_system' && c.args[1] === true);
            const byId = calls.find(c => c.method === 'eq' && c.args[0] === 'id');
            if (byId) return Promise.resolve({ data: h.byId, error: null });
            return Promise.resolve({ data: systemOnly ? h.systemRows : h.allRows, error: null });
        };
        b.single = settle;
        b.maybeSingle = settle;
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    };
});

import { getSystemRoles, getSystemRolesUncached } from '../lib/db/common';
import {
    isSystemAdminRole,
    resolveIsSystemAdmin,
    resolveIsSystemAdminFresh,
    stampSystemAdmin,
} from '../lib/db/adminIdentity';
import { blankSensitiveUserFields } from '../lib/db/mappers';
import { stripSensitiveUserFields } from '../lib/db/userFilters';
import type { User } from '../types';

const SEEDED = [
    { id: 1, name: 'Client', is_system: true },
    { id: 2, name: 'Member', is_system: true },
    { id: 3, name: 'Dispatcher', is_system: true },
    { id: 4, name: 'Admin', is_system: true },
];

beforeEach(() => {
    h.store.clear();
    h.queries = 0;
    h.byId = null;
    h.systemRows = SEEDED.map(r => ({ ...r }));
    h.allRows = SEEDED.map(r => ({ ...r }));
});

// ---------------------------------------------------------------------------
// getSystemRoles — name resolution WITHIN the is_system set, never positional
// ---------------------------------------------------------------------------
describe('getSystemRoles resolves by name inside the is_system set', () => {
    it('resolves all four slots for a seeded org', async () => {
        const r = await getSystemRoles();
        expect(r.admin?.id).toBe(4);
        expect(r.client?.id).toBe(1);
        expect(r.member?.id).toBe(2);
        expect(r.dispatcher?.id).toBe(3);
    });

    // The old primary path took systemRoles[3] with no name check and no length cap.
    // An import can leave the is_system set in any order with any names.
    it('does NOT elect the fourth is_system row as Admin when no row is named Admin', async () => {
        h.systemRows = [
            { id: 1, name: 'Client', is_system: true },
            { id: 2, name: 'Member', is_system: true },
            { id: 3, name: 'Dispatcher', is_system: true },
            { id: 9, name: 'Overlord', is_system: true },
        ];
        h.allRows = h.systemRows.map(r => ({ ...r }));
        const r = await getSystemRoles();
        expect(r.admin).toBeUndefined();
    });

    // The old fallback was `find(/^admin$/i) || roles[3]`. roles_name_key is
    // byte-exact, so 'admin' can coexist with 'Admin' — and it sorted first by id.
    it('prefers the byte-exact Admin over a lowercase decoy', async () => {
        h.systemRows = [];
        h.allRows = [
            { id: 1, name: 'admin' },
            { id: 2, name: 'Client' },
            { id: 3, name: 'Member' },
            { id: 4, name: 'Dispatcher' },
            { id: 5, name: 'Admin' },
        ];
        const r = await getSystemRoles();
        expect(r.admin?.id).toBe(5);
    });

    it('does NOT elect a lone lowercase decoy positionally when no exact Admin exists', async () => {
        h.systemRows = [];
        h.allRows = [
            { id: 1, name: 'Client' },
            { id: 2, name: 'Member' },
            { id: 3, name: 'Dispatcher' },
            { id: 4, name: 'Contractors' },
        ];
        const r = await getSystemRoles();
        expect(r.admin).toBeUndefined();
    });

    it('refuses an ambiguous case-insensitive match rather than taking the lower id', async () => {
        h.systemRows = [];
        h.allRows = [
            { id: 1, name: 'admin' },
            { id: 2, name: ' ADMIN ' },
            { id: 3, name: 'Client' },
        ];
        const r = await getSystemRoles();
        expect(r.admin).toBeUndefined();
    });

    it('still resolves a pre-is_system org by exact name (no is_system rows at all)', async () => {
        h.systemRows = [];
        h.allRows = SEEDED.map(({ id, name }) => ({ id, name }));
        const r = await getSystemRoles();
        expect(r.admin?.id).toBe(4);
    });

    it('does not cache an incomplete result', async () => {
        h.systemRows = [];
        h.allRows = [{ id: 1, name: 'Client' }];
        await getSystemRoles();
        expect(h.store.has('system_roles')).toBe(false);
    });

    it('caches a complete result and serves the second call from the memo', async () => {
        await getSystemRoles();
        const after = h.queries;
        await getSystemRoles();
        expect(h.queries).toBe(after);
    });

    it('getSystemRolesUncached bypasses the memo and does not populate it', async () => {
        h.store.set('system_roles', { admin: { id: 999, name: 'Stale' } });
        const r = await getSystemRolesUncached();
        expect(r.admin?.id).toBe(4);
        expect((h.store.get('system_roles') as { admin?: { id: number } }).admin?.id).toBe(999);
    });
});

// ---------------------------------------------------------------------------
// isSystemAdminRole — the corroborating, unforgeable local signal
// ---------------------------------------------------------------------------
describe('isSystemAdminRole', () => {
    it('accepts the is_system row named Admin, case/whitespace insensitively', () => {
        expect(isSystemAdminRole({ id: 4, name: 'Admin', is_system: true })).toBe(true);
        expect(isSystemAdminRole({ id: 4, name: ' admin ', is_system: true })).toBe(true);
    });
    // A custom role can be NAMED admin (addRole never writes is_system) or BE
    // is_system (updateRole refuses to rename one) — never both.
    it('rejects a role named Admin that is not is_system', () => {
        expect(isSystemAdminRole({ id: 9, name: 'Admin', is_system: false })).toBe(false);
        expect(isSystemAdminRole({ id: 9, name: 'admin' })).toBe(false);
    });
    it('rejects an is_system role that is not the Admin slot', () => {
        expect(isSystemAdminRole({ id: 3, name: 'Dispatcher', is_system: true })).toBe(false);
        expect(isSystemAdminRole({ id: 3, name: 'Commander', is_system: true })).toBe(false);
    });
    it('rejects null/undefined', () => {
        expect(isSystemAdminRole(null)).toBe(false);
        expect(isSystemAdminRole(undefined)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// resolveIsSystemAdmin — fail closed in every direction
// ---------------------------------------------------------------------------
describe('resolveIsSystemAdmin', () => {
    it('is true for the resolved Admin role id', async () => {
        await expect(resolveIsSystemAdmin(4)).resolves.toBe(true);
    });
    it('is false for a custom role id', async () => {
        await expect(resolveIsSystemAdmin(9)).resolves.toBe(false);
    });
    it('is false for a missing / non-integer / non-positive role id', async () => {
        await expect(resolveIsSystemAdmin(undefined)).resolves.toBe(false);
        await expect(resolveIsSystemAdmin(null)).resolves.toBe(false);
        await expect(resolveIsSystemAdmin(0)).resolves.toBe(false);
        await expect(resolveIsSystemAdmin(1.5)).resolves.toBe(false);
    });
    it('is false when the Admin slot cannot be resolved (fail closed)', async () => {
        h.systemRows = [];
        h.allRows = [{ id: 4, name: 'Overlord' }];
        await expect(resolveIsSystemAdmin(4)).resolves.toBe(false);
    });
    // The embedded role row removes the dependency on a second read: a getSystemRoles
    // fault must not strip a real Admin of their bypasses.
    it('accepts the corroborating embedded role row even when the resolver disagrees', async () => {
        h.systemRows = [];
        h.allRows = [];
        await expect(resolveIsSystemAdmin(77, { id: 77, name: 'Admin', is_system: true })).resolves.toBe(true);
    });
    it('does NOT accept a forged embedded role row', async () => {
        h.systemRows = [];
        h.allRows = [];
        await expect(resolveIsSystemAdmin(77, { id: 77, name: 'admin', is_system: false })).resolves.toBe(false);
    });
});

// ---------------------------------------------------------------------------
// resolveIsSystemAdminFresh — the recovery family's cache-free re-check
// ---------------------------------------------------------------------------
describe('resolveIsSystemAdminFresh', () => {
    // lib/db/importer.ts full-table-deletes and rebuilds `roles`; repairDatabase is
    // the tool that re-stamps is_system. Gating repair on the memo repair exists to
    // fix is the circularity that manufactures a lockout.
    it('ignores a stale memo and re-reads the live roles', async () => {
        h.store.set('system_roles', { admin: { id: 999, name: 'Admin' } });
        await expect(resolveIsSystemAdminFresh(4)).resolves.toBe(true);
        await expect(resolveIsSystemAdminFresh(999)).resolves.toBe(false);
    });

    it('falls back to the actor own role row when the name resolution is ambiguous', async () => {
        h.systemRows = [];
        h.allRows = [{ id: 1, name: 'admin' }, { id: 2, name: 'ADMIN' }];
        h.byId = { id: 2, name: 'Admin', is_system: true };
        await expect(resolveIsSystemAdminFresh(2)).resolves.toBe(true);
    });

    it('is false for a missing role id and never throws', async () => {
        await expect(resolveIsSystemAdminFresh(undefined)).resolves.toBe(false);
        h.systemRows = [];
        h.allRows = [];
        h.byId = null;
        await expect(resolveIsSystemAdminFresh(4)).resolves.toBe(false);
    });
});

// ---------------------------------------------------------------------------
// stampSystemAdmin + the wire boundary
// ---------------------------------------------------------------------------
describe('stampSystemAdmin', () => {
    it('stamps true for the Admin role and false for anything else', async () => {
        await expect(stampSystemAdmin({ roleId: 4 })).resolves.toMatchObject({ isSystemAdmin: true });
        await expect(stampSystemAdmin({ roleId: 9 })).resolves.toMatchObject({ isSystemAdmin: false });
    });
    it('passes nullish actors through untouched', async () => {
        await expect(stampSystemAdmin(null)).resolves.toBeNull();
        await expect(stampSystemAdmin(undefined)).resolves.toBeUndefined();
    });
});

describe('isSystemAdmin never crosses the wire', () => {
    const admin = (over: Partial<User> = {}): User => ({
        id: 1, name: 'A', role: 'Admin', roleId: 4, isSystemAdmin: true,
        isDuty: false, permissions: [], createdAt: 'now',
        avatarUrl: '', discordId: '1', rsiHandle: '', reputation: 0,
        ...over,
    } as User);

    // It rides `...full` off a stamped session actor, so both scrubbers must clear it
    // explicitly — the browser must never see or gate on it (client filters are
    // cosmetic), and a leaked flag is a map of who holds the apex role.
    it('blankSensitiveUserFields clears it', () => {
        expect(blankSensitiveUserFields(admin()).isSystemAdmin).toBeUndefined();
    });

    it('stripSensitiveUserFields clears it on the SELF path', () => {
        const out = stripSensitiveUserFields(admin(), { id: 1, role: 'Admin', isSystemAdmin: true, permissions: [] });
        expect(out.isSystemAdmin).toBeUndefined();
    });

    it('stripSensitiveUserFields clears it on the full-record bypass path', () => {
        const apex = [
            'admin:user:update', 'user:manage:personnel_notes', 'user:manage:conduct_record',
            'admin:user:manage_clearance', 'admin:view:roster',
        ];
        const out = stripSensitiveUserFields(admin({ id: 2 }), { id: 1, role: 'Admin', isSystemAdmin: true, permissions: apex });
        expect(out.isSystemAdmin).toBeUndefined();
    });

    it('stripSensitiveUserFields clears it on the unauthenticated path', () => {
        expect(stripSensitiveUserFields(admin(), null).isSystemAdmin).toBeUndefined();
    });

    it('JSON round-trip carries no isSystemAdmin key', () => {
        const wire = JSON.parse(JSON.stringify(blankSensitiveUserFields(admin())));
        expect(Object.hasOwn(wire, 'isSystemAdmin')).toBe(false);
    });
});
