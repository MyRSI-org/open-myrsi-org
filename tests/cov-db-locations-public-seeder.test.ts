import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/seeder.ts — first-boot / repair seeding. The role-permission grant rules
// (fresh-tier check, one-shot marker) are pinned in tests/seederRoleDefaults.test.ts;
// this suite pins the rest of the control flow:
//   - every reference-data upsert is idempotent (onConflict + ignoreDuplicates) and a
//     failed one is logged without aborting the seed;
//   - the two hard failures (no roles after the upsert, unreadable permissions) throw
//     BEFORE any role_permissions write;
//   - a partial seed never stamps the optional-module marker (fails closed: the
//     backfill stays re-armable);
//   - existing HQ unit / dispatch channel / locations are never duplicated;
//   - location parent links resolve through freshly-inserted and pre-existing rows, and
//     an insert failure orphans its children rather than mis-parenting them;
//   - resetOrgDefaults FORCE-resets branding (no ignoreDuplicates) after the full seed.

const h = vi.hoisted(() => {
    type Call = { m: string; a: unknown[] };
    type Q = { table: string; calls: Call[] };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
    const state = {
        queries: [] as Q[],
        respond: ((_q: Q) => ({ data: null, error: null })) as (q: Q) => unknown,
    };
    function from(table: string) {
        const q: Q = { table, calls: [] };
        state.queries.push(q);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'insert', 'upsert']) {
            b[m] = (...a: unknown[]) => { q.calls.push({ m, a }); return b; };
        }
        const settle = () => Promise.resolve().then(() => state.respond(q));
        b.maybeSingle = () => { q.calls.push({ m: 'maybeSingle', a: [] }); return settle(); };
        b.single = () => { q.calls.push({ m: 'single', a: [] }); return settle(); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return { state, logger, from, markApplied: vi.fn(async () => undefined) };
});

vi.mock('../lib/db/common', () => ({ supabase: { from: h.from } }));
vi.mock('../lib/db/roleDefaults', () => ({ markOptionalModuleDefaultsApplied: h.markApplied }));
vi.mock('../lib/log', () => ({ log: h.logger }));

import { seedInstall, seedMarketplaceCategories, resetOrgDefaults, seedDefaultLocations, seedNewOrganization } from '../lib/db/seeder';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { cache } from '../lib/cache';

type Q = { table: string; calls: Array<{ m: string; a: unknown[] }> };
const has = (q: Q, m: string) => q.calls.some((c) => c.m === m);
const arg = (q: Q, m: string, i = 0) => q.calls.find((c) => c.m === m)?.a[i];
const ofTable = (t: string) => h.state.queries.filter((q) => q.table === t);
const upsertsOf = (t: string) => ofTable(t).filter((q) => has(q, 'upsert'));
const insertsOf = (t: string) => ofTable(t).filter((q) => has(q, 'insert'));
const errorMsgs = () => h.logger.error.mock.calls.map((c) => c[0]);

// --- configurable fake world ---------------------------------------------------
interface World {
    upsertError: Record<string, unknown>;
    rolesUpsert: { data: unknown; error: unknown };
    roles: Array<{ id: number; name: string }> | null;
    permissions: Array<{ id: number; name: string }> | null;
    rpCount: Record<number, { count: number | null; error: unknown }>;
    unitExists: boolean;
    channelExists: boolean;
    channelInsertError: unknown;
    existingLocations: Record<string, number>;
    locationInsertError: Record<string, unknown>;
    locationInsertNull: Set<string>;
    categoryParents: Array<{ id: number; slug: string }> | null;
    childUpsertError: unknown;
}
let w: World;
let nextLocId = 1000;

const ROLES = [{ id: 1, name: 'Client' }, { id: 2, name: 'Member' }, { id: 3, name: 'Dispatcher' }, { id: 4, name: 'Admin' }];
const PERMS = [
    { id: 11, name: CLIENT_DEFAULT_PERMS[0] },
    { id: 12, name: 'requests:view' },
    { id: 13, name: 'admin:config:roles' },
];

function respond(q: Q): unknown {
    switch (q.table) {
        case 'roles':
            if (has(q, 'upsert')) return w.rolesUpsert;
            return { data: w.roles, error: null };
        case 'permissions':
            return { data: w.permissions, error: null };
        case 'role_permissions':
            if (has(q, 'upsert')) return { error: w.upsertError.role_permissions ?? null };
            return w.rpCount[arg(q, 'eq', 1) as number] ?? { count: 0, error: null };
        case 'units':
            if (has(q, 'insert')) return { error: null };
            return { data: w.unitExists ? { id: 7 } : null, error: null };
        case 'radio_channels':
            if (has(q, 'insert')) return { error: w.channelInsertError };
            return { data: w.channelExists ? { id: 'dispatch' } : null, error: null };
        case 'locations': {
            if (has(q, 'insert')) {
                const name = (arg(q, 'insert') as { name: string }).name;
                if (w.locationInsertError[name]) return { data: null, error: w.locationInsertError[name] };
                if (w.locationInsertNull.has(name)) return { data: null, error: null };
                return { data: { id: nextLocId++ }, error: null };
            }
            const name = arg(q, 'eq', 1) as string;
            return { data: name in w.existingLocations ? { id: w.existingLocations[name] } : null, error: null };
        }
        case 'marketplace_categories': {
            if (has(q, 'upsert')) {
                const rows = arg(q, 'upsert') as Array<{ parent_id?: number }>;
                const isChildren = rows.some((r) => 'parent_id' in r);
                return { error: isChildren ? w.childUpsertError : (w.upsertError.marketplace_categories ?? null) };
            }
            return { data: w.categoryParents, error: null };
        }
        default:
            return { error: w.upsertError[q.table] ?? null };
    }
}

beforeEach(() => {
    nextLocId = 1000;
    w = {
        upsertError: {},
        rolesUpsert: { data: [{ id: 1 }], error: null },
        roles: ROLES,
        permissions: PERMS,
        rpCount: {},
        unitExists: false,
        channelExists: false,
        channelInsertError: null,
        existingLocations: {},
        locationInsertError: {},
        locationInsertNull: new Set(),
        categoryParents: [{ id: 501, slug: 'services' }, { id: 502, slug: 'components' }, { id: 503, slug: 'weapons-armor' }, { id: 504, slug: 'cargo-commodities' }],
        childUpsertError: null,
    };
    h.state.queries = [];
    h.state.respond = (q) => respond(q as Q);
    h.logger.error.mockClear(); h.logger.info.mockClear();
    h.markApplied.mockClear();
});

// ---------------------------------------------------------------------------
describe('seedInstall — reference data', () => {
    it('upserts every reference table idempotently and returns the role map', async () => {
        const res = await seedInstall();
        expect(res).toEqual({ success: true, roles: { Client: 1, Member: 2, Dispatcher: 3, Admin: 4 } });

        const idem = (t: string, onConflict: string) => {
            const qs = upsertsOf(t);
            expect(qs, t).toHaveLength(1);
            expect(arg(qs[0], 'upsert', 1), t).toEqual({ onConflict, ignoreDuplicates: true });
            return arg(qs[0], 'upsert') as Array<Record<string, unknown>>;
        };
        expect(idem('service_types', 'name').map((r) => r.name)).toEqual(['Security', 'Rescue', 'Logistics']);
        expect(idem('security_clearances', 'level').map((r) => r.level)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(idem('ranks', 'name').map((r) => r.name)).toEqual(['Recruit', 'Member', 'Officer', 'Command']);
        expect(idem('specialization_tags', 'name')).toHaveLength(5);
        expect(idem('certifications', 'name')).toHaveLength(3);
        expect(idem('commendations', 'name')).toHaveLength(3);
        const settings = idem('settings', 'key');
        expect(settings.map((r) => r.key)).toEqual(['brandingConfig', 'discordConfig', 'systemConfig']);
        // Discord ships disabled; the seeded config carries no credentials.
        expect(settings[1].value).toEqual({ enabled: false });

        // The four system roles are flagged is_system (the Admin-identity resolver depends on it).
        const rolesUp = upsertsOf('roles')[0];
        expect(arg(rolesUp, 'upsert')).toEqual([
            expect.objectContaining({ name: 'Client', is_system: true }),
            expect.objectContaining({ name: 'Member', is_system: true }),
            expect.objectContaining({ name: 'Dispatcher', is_system: true }),
            expect.objectContaining({ name: 'Admin', is_system: true }),
        ]);
        expect(arg(rolesUp, 'upsert', 1)).toEqual({ onConflict: 'name' });
        expect(arg(rolesUp, 'select')).toBe('id');
        // Role and permission maps are read with explicit columns.
        expect(ofTable('roles').filter((q) => !has(q, 'upsert')).map((q) => arg(q, 'select'))).toEqual(['id, name']);
        expect(arg(ofTable('permissions')[0], 'select')).toBe('id, name');
    });

    it('a failed reference upsert is logged and the seed carries on', async () => {
        for (const t of ['service_types', 'security_clearances', 'ranks', 'settings', 'specialization_tags', 'certifications', 'commendations']) {
            w.upsertError[t] = { message: `${t} failed` };
        }
        w.rolesUpsert = { data: null, error: { message: 'roles upsert failed' } };
        const res = await seedInstall();
        expect(res.success).toBe(true);
        expect(errorMsgs()).toEqual(expect.arrayContaining([
            'service types seed failed', 'clearances seed failed', 'roles seed failed', 'ranks seed failed',
            'settings seed failed', 'specializations seed failed', 'certifications seed failed', 'commendations seed failed',
        ]));
        expect(h.logger.error).toHaveBeenCalledWith('roles seed failed', { err: { message: 'roles upsert failed' } });
        // Downstream steps still ran.
        expect(insertsOf('units')).toHaveLength(1);
    });

    it('an upsert that returns no rows (and no error) is logged as a roles failure but proceeds', async () => {
        w.rolesUpsert = { data: null, error: null };
        await seedInstall();
        expect(h.logger.error).toHaveBeenCalledWith('roles seed failed', { err: null });
    });
});

describe('seedInstall — hard failures stop before any grant is written', () => {
    it.each([[null], [[]]])('throws when no roles exist after the upsert (%j)', async (roles) => {
        w.roles = roles as World['roles'];
        await expect(seedInstall()).rejects.toThrow('Roles missing after seed attempt.');
        expect(ofTable('role_permissions')).toEqual([]);
        expect(ofTable('permissions')).toEqual([]);
    });

    it('throws when the global permission list cannot be read', async () => {
        w.permissions = null;
        await expect(seedInstall()).rejects.toThrow('Failed to fetch global permissions');
        expect(ofTable('role_permissions')).toEqual([]);
        expect(h.markApplied).not.toHaveBeenCalled();
    });
});

describe('seedInstall — role permission grants', () => {
    const grantRows = () => (arg(upsertsOf('role_permissions')[0], 'upsert') ?? []) as Array<{ role_id: number; permission_id: number }>;

    it('checks tier freshness with a head count per tier and only ever counts role_id', async () => {
        await seedInstall();
        const counts = ofTable('role_permissions').filter((q) => !has(q, 'upsert'));
        expect(counts.map((q) => q.calls)).toEqual([
            [{ m: 'select', a: ['role_id', { count: 'exact', head: true }] }, { m: 'eq', a: ['role_id', 2] }],
            [{ m: 'select', a: ['role_id', { count: 'exact', head: true }] }, { m: 'eq', a: ['role_id', 3] }],
        ]);
        expect(arg(upsertsOf('role_permissions')[0], 'upsert', 1)).toEqual({ ignoreDuplicates: true });
    });

    it('Admin receives every global permission; unknown permission names are silently skipped', async () => {
        await seedInstall();
        const admin = grantRows().filter((r) => r.role_id === 4).map((r) => r.permission_id).sort();
        expect(admin).toEqual([11, 12, 13]);
        // Client receives only what exists in the permission table (CLIENT_DEFAULT_PERMS[0] → 11).
        expect(grantRows().filter((r) => r.role_id === 1).map((r) => r.permission_id)).toEqual([11]);
    });

    it('a fresh seed of both tiers stamps the one-shot optional-module marker', async () => {
        await seedInstall();
        expect(h.markApplied).toHaveBeenCalledTimes(1);
    });

    it('a failed freshness count skips that tier (fails closed) and leaves the marker unstamped', async () => {
        w.rpCount[2] = { count: null, error: { message: 'count failed' } };
        await seedInstall();
        expect(h.logger.error).toHaveBeenCalledWith('role permission freshness check failed; skipping tier', {
            tier: 'Member', err: { message: 'count failed' },
        });
        expect(grantRows().some((r) => r.role_id === 2)).toBe(false);
        expect(h.markApplied).not.toHaveBeenCalled();
    });

    it('a populated tier keeps its grants untouched and the marker stays unstamped', async () => {
        w.rpCount[3] = { count: 4, error: null };
        await seedInstall();
        expect(h.logger.info).toHaveBeenCalledWith('tier already holds permissions; leaving its grants alone', { tier: 'Dispatcher', count: 4 });
        expect(grantRows().some((r) => r.role_id === 3)).toBe(false);
        expect(h.markApplied).not.toHaveBeenCalled();
    });

    it('a failed grant upsert is logged and does NOT stamp the marker', async () => {
        w.upsertError.role_permissions = { message: 'fk violation' };
        await seedInstall();
        expect(h.logger.error).toHaveBeenCalledWith('role permissions seed failed', { err: { message: 'fk violation' } });
        expect(h.markApplied).not.toHaveBeenCalled();
    });

    it('missing tier roles are skipped entirely, and with nothing to grant no upsert is issued', async () => {
        w.roles = [{ id: 9, name: 'Custom' }];
        w.permissions = [];
        await seedInstall();
        expect(ofTable('role_permissions')).toEqual([]);
        expect(h.markApplied).not.toHaveBeenCalled();
    });
});

describe('seedInstall — singletons and cache', () => {
    it('creates the Headquarters unit and dispatch channel only when absent', async () => {
        await seedInstall();
        expect(arg(ofTable('units')[0], 'select')).toBe('id');
        expect(arg(ofTable('units')[0], 'eq', 1)).toBe('Headquarters');
        expect(arg(insertsOf('units')[0], 'insert')).toEqual(expect.objectContaining({ name: 'Headquarters' }));
        expect(arg(insertsOf('radio_channels')[0], 'insert')).toEqual({ id: 'dispatch', name: 'Dispatch', color: '#38bdf8', type: 'voice', sort_order: 0 });
    });

    it('never duplicates an existing unit or channel', async () => {
        w.unitExists = true;
        w.channelExists = true;
        await seedInstall();
        expect(insertsOf('units')).toEqual([]);
        expect(insertsOf('radio_channels')).toEqual([]);
    });

    it('a failed channel insert is logged and the seed completes', async () => {
        w.channelInsertError = { message: 'dup' };
        expect((await seedInstall()).success).toBe(true);
        expect(h.logger.error).toHaveBeenCalledWith('default radio channel seed failed', { err: { message: 'dup' } });
    });

    it('busts the system-role memo at the end of the seed', async () => {
        cache.set('system_roles', { stale: true }, 60_000);
        await seedInstall();
        expect(cache.get('system_roles')).toBeUndefined();
    });

    it('seedNewOrganization is the same function (deprecated alias)', () => {
        expect(seedNewOrganization).toBe(seedInstall);
    });
});

// ---------------------------------------------------------------------------
describe('seedMarketplaceCategories', () => {
    it('upserts the 7 top-level categories, then children resolved against parent ids', async () => {
        await seedMarketplaceCategories();
        const [tops, children] = upsertsOf('marketplace_categories');
        expect((arg(tops, 'upsert') as Array<{ slug: string }>).map((r) => r.slug)).toEqual([
            'ships-vehicles', 'components', 'weapons-armor', 'cargo-commodities', 'consumables', 'services', 'other',
        ]);
        expect(arg(tops, 'upsert', 1)).toEqual({ onConflict: 'slug', ignoreDuplicates: true });
        const parentRead = ofTable('marketplace_categories').find((q) => !has(q, 'upsert'))!;
        expect(parentRead.calls).toEqual([{ m: 'select', a: ['id, slug'] }, { m: 'is', a: ['parent_id', null] }]);
        const kids = arg(children, 'upsert') as Array<{ slug: string; parent_id: number }>;
        expect(kids).toHaveLength(15);
        expect(kids.find((k) => k.slug === 'svc-hauling')!.parent_id).toBe(501);
        expect(kids.find((k) => k.slug === 'cmp-qd')!.parent_id).toBe(502);
        expect(kids.find((k) => k.slug === 'cc-refined')!.parent_id).toBe(504);
        expect(arg(children, 'upsert', 1)).toEqual({ onConflict: 'slug', ignoreDuplicates: true });
    });

    it('a failed top-level upsert stops before reading parents or seeding children', async () => {
        w.upsertError.marketplace_categories = { message: 'top failed' };
        await seedMarketplaceCategories();
        expect(ofTable('marketplace_categories')).toHaveLength(1);
        expect(h.logger.error).toHaveBeenCalledWith('marketplace categories (top) seed failed', { err: { message: 'top failed' } });
    });

    it('children whose parent did not resolve are dropped (never inserted with a null parent)', async () => {
        w.categoryParents = [{ id: 777, slug: 'components' }];
        await seedMarketplaceCategories();
        const kids = arg(upsertsOf('marketplace_categories')[1], 'upsert') as Array<{ slug: string; parent_id: number }>;
        expect(kids.map((k) => k.slug)).toEqual(['cmp-power', 'cmp-shields', 'cmp-coolers', 'cmp-qd']);
        expect(kids.every((k) => k.parent_id === 777)).toBe(true);
    });

    it('no resolvable parents at all means no child upsert', async () => {
        w.categoryParents = null;
        await seedMarketplaceCategories();
        expect(upsertsOf('marketplace_categories')).toHaveLength(1);
    });

    it('a failed child upsert is logged', async () => {
        w.childUpsertError = { message: 'child failed' };
        await seedMarketplaceCategories();
        expect(h.logger.error).toHaveBeenCalledWith('marketplace categories (children) seed failed', { err: { message: 'child failed' } });
    });
});

// ---------------------------------------------------------------------------
describe('seedDefaultLocations', () => {
    const insertRows = () => insertsOf('locations').map((q) => arg(q, 'insert') as { name: string; type: string; parent_id: number | null });
    const inserted = (name: string) => insertRows().find((r) => r.name === name);

    it('inserts systems → planets → moons → facilities, wiring each parent to its db id', async () => {
        const res = await seedDefaultLocations();
        const rows = insertRows();
        expect(rows).toHaveLength(100);
        expect(res).toEqual({ success: true, count: 100 });
        // Type order: all systems first, facilities last.
        expect(rows.slice(0, 3).map((r) => r.type)).toEqual(['System', 'System', 'System']);
        expect(rows.at(-1)!.type).toBe('Facility');
        expect(inserted('Stanton')).toEqual({ name: 'Stanton', type: 'System', parent_id: null });
        expect(inserted('Hurston')!.parent_id).toBe(1000);           // Stanton was the first insert
        const crusaderId = 1000 + rows.findIndex((r) => r.name === 'Crusader');
        expect(inserted('Yela')!.parent_id).toBe(crusaderId);
        // Each existence probe selects only id, by name.
        const probe = ofTable('locations').find((q) => !has(q, 'insert'))!;
        expect(probe.calls).toEqual([{ m: 'select', a: ['id'] }, { m: 'eq', a: ['name', 'Stanton'] }, { m: 'maybeSingle', a: [] }]);
        const ins = insertsOf('locations')[0];
        expect(arg(ins, 'select')).toBe('id');
        expect(has(ins, 'single')).toBe(true);
    });

    it('re-uses an existing row (no duplicate insert) and parents its children to it', async () => {
        w.existingLocations = { Microtech: 42 };
        const res = await seedDefaultLocations();
        expect(inserted('Microtech')).toBeUndefined();
        expect(inserted('Clio')!.parent_id).toBe(42);
        expect(inserted('New Babbage')!.parent_id).toBe(42);
        expect(res.count).toBe(100);
    });

    it('an insert failure is logged and its children are orphaned (parent null), not mis-parented', async () => {
        w.locationInsertError = { Crusader: { message: 'unique violation' } };
        const res = await seedDefaultLocations();
        expect(h.logger.error).toHaveBeenCalledWith('location insert failed', { location: 'Crusader', message: 'unique violation' });
        for (const moon of ['Cellin', 'Daymar', 'Yela']) expect(inserted(moon)!.parent_id).toBeNull();
        expect(res.count).toBe(99);
    });

    it('an insert that returns no row (and no error) is not counted', async () => {
        w.locationInsertNull = new Set(['Nyx']);
        const res = await seedDefaultLocations();
        expect(res.count).toBe(99);
        expect(h.logger.error).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('resetOrgDefaults', () => {
    it('runs the full seed, then FORCE-resets branding (overwrite, no ignoreDuplicates)', async () => {
        const res = await resetOrgDefaults();
        expect(res).toEqual({ success: true });
        const settingsUps = upsertsOf('settings');
        expect(settingsUps).toHaveLength(2);
        // The seed's insert-if-absent pass comes first...
        expect(arg(settingsUps[0], 'upsert', 1)).toEqual({ onConflict: 'key', ignoreDuplicates: true });
        // ...then the forced overwrite of branding only.
        const forced = settingsUps[1];
        expect(arg(forced, 'upsert', 1)).toEqual({ onConflict: 'key' });
        const payload = arg(forced, 'upsert') as { key: string; value: Record<string, unknown> };
        expect(payload.key).toBe('brandingConfig');
        expect(payload.value).toEqual(expect.objectContaining({ name: 'Operations', iconUrl: '/media/cross-swords.png', dutyTimeoutMinutes: 30 }));
        expect(Object.keys(payload.value).sort()).toEqual([
            'assignmentSoundUrl', 'bootSoundUrl', 'dutyTimeoutMinutes', 'eamSoundUrl', 'iconUrl', 'name',
            'newRequestSoundUrl', 'radioMicCueUrl', 'radioSquelchUrl',
        ]);
    });

    it('a failed branding reset is logged and still reports success', async () => {
        let n = 0;
        h.state.respond = (q) => {
            if (q.table === 'settings' && has(q as Q, 'upsert') && ++n === 2) return { error: { message: 'write failed' } };
            return respond(q as Q);
        };
        expect(await resetOrgDefaults()).toEqual({ success: true });
        expect(h.logger.error).toHaveBeenCalledWith('branding defaults reset failed', { err: { message: 'write failed' } });
    });

    it('a seed that cannot find roles aborts the reset before branding is touched', async () => {
        w.roles = [];
        await expect(resetOrgDefaults()).rejects.toThrow('Roles missing after seed attempt.');
        expect(upsertsOf('settings')).toEqual([]);
    });
});
