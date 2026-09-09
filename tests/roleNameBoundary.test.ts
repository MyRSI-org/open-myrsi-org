import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The role-NAME boundary.
//
// `roles.name` is operator-supplied free text under a CASE-SENSITIVE unique
// constraint, and `admin:config:roles` lets a delegated role manager mint one. So
// the name must not be authority anywhere:
//   - toUser's ladder produces a DISPLAY / AUDIENCE tier only (announcements.audience
//     and external_tools.audience store those four literal strings), and matches the
//     four seeded names BYTE-EXACTLY — no 'commander'/'director'/'administrator'/
//     'officer'/'recruit' aliases, and no case folding that would let 'admin'
//     inherit 'Admin'.
//   - addRole/updateRole reserve those four names case-insensitively, a SUPERSET of
//     what the ladder accepts, so no NEW role can reach an elevated tier by name.
//   - nothing in lib/**, api/** or server.ts compares a role name to decide
//     authorization any more (the ratchet at the bottom).

const h = vi.hoisted(() => ({
    roleRow: null as { name: string; is_system?: boolean } | null,
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ patch: Record<string, unknown>; id: unknown }>,
    insertError: null as { message: string } | null,
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); calls.push({ method: 'insert', args: [row] }); return b; };
        b.update = (patch: Record<string, unknown>) => {
            calls.push({ method: 'update', args: [patch] });
            const withEq: Record<string, unknown> = { ...b };
            withEq.eq = (_c: string, id: unknown) => { h.updates.push({ patch, id }); return b; };
            return withEq;
        };
        const settle = () => Promise.resolve(
            calls.some(c => c.method === 'insert')
                ? { data: null, error: h.insertError }
                : { data: h.roleRow, error: null },
        );
        b.single = settle;
        b.maybeSingle = settle;
        (b as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: () => builder(), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} }, TTL: {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {}, seedInstall: async () => {} }));

import { toUser, inferUserRoleTier } from '../lib/db/mappers';
import { addRole, updateRole } from '../lib/db/system';
import { UserRole } from '../types';

beforeEach(() => {
    h.roleRow = null;
    h.inserts = [];
    h.updates = [];
    h.insertError = null;
});

// A users row with just the role embed the tier ladder reads.
const rowWithRole = (name: string, perms: string[] = []) => ({
    id: 1,
    role_id: 9,
    role: { id: 9, name, role_permissions: perms.map(p => ({ permission: { name: p } })) },
}) as unknown as Parameters<typeof toUser>[0];

// ---------------------------------------------------------------------------
// The tier ladder: audience contract preserved, aliases gone
// ---------------------------------------------------------------------------
describe('toUser role tier — the four seeded names, byte-exact', () => {
    // AUDIENCE CONTRACT. announcements.audience / external_tools.audience hold these
    // literal strings, and contexts/SessionContext registerRealtimeAuth receives them.
    // If this stops holding, every member loses every notice and every external tool.
    it.each([
        ['Client', UserRole.Client],
        ['Member', UserRole.Member],
        ['Dispatcher', UserRole.Dispatcher],
        ['Admin', UserRole.Admin],
    ])('resolves the seeded name %s to its own tier', (name, tier) => {
        expect(toUser(rowWithRole(name))?.role).toBe(tier);
    });

    // The aliases were never seeded role names; 'Recruit' and 'Officer' are seeded
    // RANK names an operator could reasonably reuse for a role.
    it.each(['Commander', 'Director', 'Administrator', 'Officer', 'Recruit'])(
        'no longer maps the alias %s to a staff tier',
        (name) => {
            expect(toUser(rowWithRole(name))?.role).toBe(UserRole.Client);
        },
    );

    // roles_name_key is byte-exact, so 'admin' can coexist with 'Admin'. Under the
    // old lowercasing ladder it inherited the Admin AUDIENCE — i.e. the body of every
    // Admin-only notice and the title+url of every Admin-only external tool.
    it.each(['admin', 'ADMIN', 'dispatcher', 'member'])(
        'does not case-fold %s onto a seeded tier',
        (name) => {
            expect(toUser(rowWithRole(name))?.role).toBe(UserRole.Client);
        },
    );

    // The permission fallback is retained DELIBERATELY — which is exactly why the
    // admin:access defusal in lib/db/userFilters.ts must stay.
    it('still infers a tier from permissions for an unrecognised name', () => {
        expect(toUser(rowWithRole('Overlord', ['admin:access']))?.role).toBe(UserRole.Admin);
        expect(toUser(rowWithRole('Overlord', ['request:dispatch']))?.role).toBe(UserRole.Dispatcher);
        expect(toUser(rowWithRole('Overlord', ['request:accept']))?.role).toBe(UserRole.Member);
        expect(toUser(rowWithRole('Overlord', ['wiki:view']))?.role).toBe(UserRole.Client);
    });

    it('trims surrounding whitespace before matching', () => {
        expect(toUser(rowWithRole('  Admin  '))?.role).toBe(UserRole.Admin);
    });

    // The ladder is now a named export, so the three in-tree comments that cite
    // `inferUserRoleTier` (lib/radio.ts, lib/staffPerms.ts x2) name a real symbol.
    it('inferUserRoleTier is the same ladder toUser applies', () => {
        expect(inferUserRoleTier('Admin', [])).toBe(UserRole.Admin);
        expect(inferUserRoleTier('Commander', [])).toBe(UserRole.Client);
        expect(inferUserRoleTier('Overlord', ['admin:access'])).toBe(UserRole.Admin);
        expect(inferUserRoleTier(null, ['admin:access'])).toBe(UserRole.Client);
        expect(inferUserRoleTier(undefined, [])).toBe(UserRole.Client);
    });
});

// ---------------------------------------------------------------------------
// The reserved-name guard
// ---------------------------------------------------------------------------
describe('addRole reserves the four system names', () => {
    it.each(['admin', 'Admin', '  Admin ', 'ADMIN', 'client', 'Member', 'DISPATCHER'])(
        'refuses to create a role named %p, and writes nothing',
        async (name) => {
            await expect(addRole({ name } as never)).rejects.toThrow(/reserved for a system role/i);
            expect(h.inserts).toHaveLength(0);
        },
    );

    it('refuses a blank name and an over-long one', async () => {
        await expect(addRole({ name: '   ' } as never)).rejects.toThrow(/name is required/i);
        await expect(addRole({ name: 'x'.repeat(61) } as never)).rejects.toThrow(/too long/i);
        expect(h.inserts).toHaveLength(0);
    });

    it('creates an ordinary custom role, trimmed', async () => {
        await addRole({ name: '  Quartermaster  ', description: 'd' } as never);
        expect(h.inserts).toEqual([{ name: 'Quartermaster', description: 'd' }]);
    });

    // The insert error was previously discarded, so a UNIQUE violation returned
    // success and the Roles tab toasted a role that was never created.
    it('surfaces an insert failure instead of reporting success', async () => {
        h.insertError = { message: 'duplicate key value violates unique constraint' };
        await expect(addRole({ name: 'Quartermaster' } as never)).rejects.toThrow(/Failed to add role/i);
    });
});

describe('updateRole reserves the four system names on rename', () => {
    it('refuses to rename a CUSTOM role onto a reserved name', async () => {
        h.roleRow = { name: 'Contractors', is_system: false };
        await expect(updateRole({ id: 9, name: 'admin' } as never)).rejects.toThrow(/reserved for a system role/i);
        expect(h.updates).toHaveLength(0);
    });

    it('still refuses to rename a system role at all', async () => {
        h.roleRow = { name: 'Admin', is_system: true };
        await expect(updateRole({ id: 4, name: 'Overlord' } as never)).rejects.toThrow(/cannot be renamed/i);
        expect(h.updates).toHaveLength(0);
    });

    // A system role keeps its own name — the guard must not reject it for BEING one.
    it('allows a system role update that keeps its name', async () => {
        h.roleRow = { name: 'Admin', is_system: true };
        await updateRole({ id: 4, name: 'Admin', description: 'Full system access.' } as never);
        expect(h.updates).toHaveLength(1);
    });

    it('allows an ordinary custom rename', async () => {
        h.roleRow = { name: 'Contractors', is_system: false };
        await updateRole({ id: 9, name: 'Field Team' } as never);
        expect(h.updates[0].patch).toMatchObject({ name: 'Field Team' });
    });
});

// ---------------------------------------------------------------------------
// Repo-wide ratchet: no role-NAME authorization anywhere in server code
// ---------------------------------------------------------------------------
const ROOT = resolve(__dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel, acc);
        else if (entry.name.endsWith('.ts')) acc.push(rel);
    }
    return acc;
}
// Comments are dropped before scanning so prose DESCRIBING a removed gate does not
// register as the gate itself. Deliberately LINE-based with an explicit block-comment
// state machine rather than a `/\*[\s\S]*?\*\//` regex: server.ts contains regex
// literals whose slashes make that pattern swallow hundreds of real lines (it
// silently returned an empty match for the whole import-stream route).
function stripComments(src: string): string {
    const out: string[] = [];
    let inBlock = false;
    for (const raw of src.split('\n')) {
        const line = raw.trim();
        if (inBlock) {
            if (line.includes('*/')) inBlock = false;
            continue;
        }
        if (line.startsWith('/*')) {
            if (!line.includes('*/')) inBlock = true;
            continue;
        }
        if (line.startsWith('//')) continue;
        out.push(raw.replace(/\s+\/\/[^'"`]*$/, ''));
    }
    return out.join('\n');
}

describe('no server authorization compares a role NAME', () => {

    // `x.role === 'Admin'` and friends. Data-only role NAME uses (the announcements /
    // external-tools audience arrays, the importer's export-fidelity lookups, the
    // push fan-out, SYSTEM_ROLE_NAMES) do not take this shape.
    const NAME_COMPARE = /\.role\s*(?:===|!==)\s*['"](?:Admin|Client|Member|Dispatcher)['"]/g;

    it('lib/**, api/** and server.ts contain zero role-name comparisons', () => {
        const files = [...walk('lib'), ...walk('api'), 'server.ts'];
        const offenders: string[] = [];
        for (const rel of files) {
            const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
            const hits = src.match(NAME_COMPARE);
            if (hits) offenders.push(`${rel}: ${hits.join(', ')}`);
        }
        expect(offenders).toEqual([]);
    });

    // The same rule for the "everyone who isn't a customer" shape, which the EAM gate
    // used to take (`user.role !== 'Client'`). That is now hasAnyStaffViewPerm.
    it('no handler infers "is staff" from not being called Client', () => {
        const files = [...walk('lib'), ...walk('api'), 'server.ts'];
        const offenders = files.filter((rel) =>
            /\.role\s*!==\s*['"]Client['"]/.test(stripComments(readFileSync(join(ROOT, rel), 'utf8'))));
        expect(offenders).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The fourth API surface. server.ts is not importable under vitest (it binds a
// listener and registers cron), so this route is pinned on source text — the same
// idiom tests/sessionRevocationDrift.test.ts already uses for its sibling gates.
// ---------------------------------------------------------------------------
describe('POST /api/admin/import-stream is gated on the genuine system Admin', () => {
    const server = stripComments(readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8'));
    const start = server.indexOf("'/api/admin/import-stream'");
    const route = server.slice(start, server.indexOf('importOrgData', start));

    it('requires the stamped role identity', () => {
        expect(route).toContain("user.isSystemAdmin !== true");
    });

    // TIGHTENED (owner decision). The route replaces every seeded table via
    // SEEDED_PRECLEAR and can re-anchor the acting admin onto a new users.id, yet it
    // admitted admin:access — which the seeded DISPATCHER holds — while every other
    // apex surface (danger zone, maintenance toggle, force-logout-all, apex gov
    // seats) explicitly refuses that permission. A Dispatcher-shaped actor holding
    // admin:access is now refused.
    it('no longer admits admin:access, and no longer admits the role NAME', () => {
        expect(route).not.toContain("admin:access");
        expect(route).not.toContain("role === 'Admin'");
    });

    it('the gate sits before the importer runs', () => {
        const gateAt = server.indexOf('isSystemAdmin', start);
        const importerAt = server.indexOf('importOrgData', start);
        expect(gateAt).toBeGreaterThan(-1);
        expect(importerAt).toBeGreaterThan(gateAt);
    });
});

// ---------------------------------------------------------------------------
// The org importer must drop the role memo it invalidates nowhere today.
// getSystemRoles backs the Admin-identity gates, and SEEDED_PRECLEAR full-table
// deletes `roles` before re-inserting the export's rows with their own ids — so a
// stale slot either denies the re-anchored admin their maintenance/repair escape
// or, on an imported-id collision, grants apex authority to a stranger.
// ---------------------------------------------------------------------------
describe('the importer invalidates the system-roles memo', () => {
    const importer = readFileSync(resolve(__dirname, '..', 'lib/db/importer.ts'), 'utf8');

    it('invalidates after the seeded pre-clear', () => {
        const preclearAt = importer.indexOf('for (const { table, col, val } of SEEDED_PRECLEAR)');
        expect(preclearAt).toBeGreaterThan(-1);
        const after = importer.slice(preclearAt, preclearAt + 1200);
        expect(after).toContain("cache.invalidate('system_roles')");
        expect(after).toContain("cache.invalidate('platform_settings')");
    });

    it('invalidates again on the merge re-anchor, before the fresh token is minted', () => {
        const anchorAt = importer.indexOf('async function reanchorAdminOntoImportedUser');
        expect(anchorAt).toBeGreaterThan(-1);
        const body = importer.slice(anchorAt, importer.indexOf('\n}', importer.indexOf('return { userId: importedUserId', anchorAt)));
        expect(body).toContain("cache.invalidate('system_roles')");
    });
});

describe('updateRole cannot corrupt a system role name, and both paths cap description', () => {
    // getSystemRoles resolves the Admin slot by a BYTE-EXACT name match (deliberately,
    // so a decoy role called 'admin' cannot claim it). The rename guard compares
    // data.name.trim() against the stored name — so '  Admin  ' PASSES it — and the
    // is_system branch then wrote that raw, untrimmed string straight to the column.
    // A padded name silently unresolves the Admin slot, and every apex gate that reads
    // it (assertAdminRole, the danger zone, the ban identity arm) starts denying the
    // org's real Admin. A refused rename has to be a no-op, not a whitespace edit.
    it('a padded name that passes the rename guard is NOT written through', async () => {
        h.roleRow = { name: 'Admin', is_system: true };
        await updateRole({ id: 4, name: '  Admin  ', description: 'd' } as never);
        expect(h.updates).toHaveLength(1);
        expect(h.updates[0].patch.name, 'the stored system-role name was overwritten with padding').toBe('Admin');
    });

    it('a real rename of a system role is still refused outright', async () => {
        h.roleRow = { name: 'Admin', is_system: true };
        await expect(updateRole({ id: 4, name: 'Overlord' } as never)).rejects.toThrow(/cannot be renamed/i);
        expect(h.updates).toHaveLength(0);
    });

    it('a custom role still goes through the reserved-name and length checks', async () => {
        h.roleRow = { name: 'Quartermaster', is_system: false };
        await expect(updateRole({ id: 9, name: 'admin' } as never)).rejects.toThrow(/reserved/i);
        await expect(updateRole({ id: 9, name: 'x'.repeat(61) } as never)).rejects.toThrow(/too long/i);
    });

    it('description is capped on BOTH paths, which nothing checked before', async () => {
        h.roleRow = { name: 'Quartermaster', is_system: false };
        await expect(updateRole({ id: 9, name: 'Quartermaster', description: 'x'.repeat(501) } as never))
            .rejects.toThrow(/description is too long/i);
        await expect(addRole({ name: 'Logistics', description: 'x'.repeat(501) } as never))
            .rejects.toThrow(/description is too long/i);
    });

    it('description is trimmed, and an empty one stores NULL rather than an empty string', async () => {
        h.roleRow = { name: 'Quartermaster', is_system: false };
        await updateRole({ id: 9, name: 'Quartermaster', description: '   ' } as never);
        expect(h.updates[0].patch.description).toBeNull();
    });

    it('a failed update is reported instead of discarded', async () => {
        // updateRole used to drop its error entirely, so the Roles tab toasted success
        // for a write that never landed — the same defect addRole was fixed for.
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'system.ts'), 'utf8');
        const fn = src.slice(src.indexOf('export async function updateRole'), src.indexOf('export async function deleteRole'));
        expect(fn).toMatch(/handleSupabaseError\(\{ error, message: 'Failed to update role' \}\)/);
    });
});
