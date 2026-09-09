import { describe, it, expect, vi, beforeEach } from 'vitest';

// User-package authorization tests.
//
// Author-clearance clamp: updateUserClearance / bulkUpdateUserClearances /
//   updateUser's clearance write reject a target level above the acting user's
//   own clearance level, and reject markerIds the actor does not hold — unless the
//   actor is Admin or passes canViewAllClassifications. A plain profile edit (no
//   clearanceLevelId) is unaffected.
//
// getUserById does not resolve a soft-deleted (deleted_at != null) user, since it
//   backs session resolution on both the mutation and read paths.
//
// createUser throws on a duplicate (non-deleted) discord_id rather than inserting
//   a second account-squat row.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }>,
}));

// Chainable supabase mock with .is() / .eq() filter support so deleted_at and
// security_clearances lookups behave like the real PostgREST builder.
vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as 'select' | 'insert' | 'update' | 'delete',
            values: null as Record<string, unknown> | null,
            filters: {} as Record<string, unknown>,
        };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [c, v] of Object.entries(state.filters)) {
                if (r[c] !== v) return false;
            }
            return true;
        });
        const b: any = {};
        b.select = () => b;
        b.insert = (v: Record<string, unknown> | Record<string, unknown>[]) => { state.op = 'insert'; state.values = (Array.isArray(v) ? v[0] : v) ?? null; return b; };
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; state.values = v; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        // .eq sets an equality filter; .is(col, null) maps to filtering col === null/undefined.
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.is = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.in = () => b; b.not = () => b; b.gt = () => b; b.lt = () => b; b.ilike = () => b; b.limit = () => b; b.order = () => b; b.range = () => b;
        const isNullFilter = (r: Record<string, unknown>) => {
            // Treat .is(col, null) — recorded as filters[col] === null — as
            // "row's col is null/undefined".
            for (const [c, v] of Object.entries(state.filters)) {
                if (v === null) { if (r[c] !== null && r[c] !== undefined) return false; }
                else if (r[c] !== v) return false;
            }
            return true;
        };
        const matched = () => (h.tables[table] ?? []).filter(isNullFilter);
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                const data = matched();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'insert') {
                h.inserts.push({ table, values: state.values as Record<string, unknown> });
                const inserted = { id: `gen-${(h.tables[table]?.length ?? 0) + 1}`, ...(state.values as Record<string, unknown>) };
                (h.tables[table] = h.tables[table] ?? []).push(inserted);
                return Promise.resolve({ data: inserted, error: null });
            }
            if (state.op === 'update') {
                h.updates.push({ table, values: state.values as Record<string, unknown>, filters: { ...state.filters } });
                for (const r of matched()) Object.assign(r, state.values);
                return Promise.resolve({ data: matched()[0] ?? { id: 1 }, error: null });
            }
            if (state.op === 'delete') {
                const doomed = matched();
                h.tables[table] = (h.tables[table] ?? []).filter((r) => !doomed.includes(r));
                return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (res: any, rej: any) => settle('many').then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        getSystemRoles: async () => ({ client: { id: 10 }, member: { id: 11 }, dispatcher: { id: 12 }, admin: { id: 13 } }),
    };
});

// mappers.toUser is pure but pulls the whole types barrel; stub it to a
// deterministic passthrough so getUserById/createUser assertions are simple.
vi.mock('../lib/db/mappers', () => ({
    toUser: (row: any) => (row ? { id: row.id, name: row.name, discordId: row.discord_id, deletedAt: row.deleted_at } : null),
    toReputationHistoryEntry: (r: any) => r,
    toRatingHistoryEntry: (r: any) => r,
}));

// External-effect modules — stub so importing users.ts and exercising the
// write paths doesn't reach Discord / web-push / settings.
vi.mock('../lib/db/system', () => ({ getAllSettings: async () => ({ brandingConfig: {}, platformSettings: {} }) }));
vi.mock('../lib/discord', () => ({
    getDiscordMember: async () => null,
    pushDiscordRolesForUser: async () => {},
    getDiscordUserById: async () => null,
    buildGlobalAvatarUrl: () => '',
}));
vi.mock('../lib/push', () => ({ isAllowedPushEndpoint: () => true, MAX_PUSH_SUBSCRIPTIONS_PER_USER: 5 }));

// NOTE: ../lib/clearance is intentionally NOT mocked — the clamp's
// canViewAllClassifications bypass is part of the behaviour under test.

import {
    updateUserClearance,
    bulkUpdateUserClearances,
    updateUser,
    getUserById,
    createUser,
} from '../lib/db/users';

// security_clearances: id 1 → numeric level 1, id 5 → numeric level 5.
function seedClearances() {
    h.tables.security_clearances = [
        { id: 1, level: 1 },
        { id: 3, level: 3 },
        { id: 5, level: 5 },
    ];
}

// A clearance-manager actor: NOT Admin, NO intel:manage bypass, clearance
// level 1, holds marker id 100 only.
const lowActor = {
    id: 7,
    role: 'Member',
    permissions: ['admin:user:manage_clearance', 'admin:user:update'],
    clearanceLevel: { id: 1, level: 1 },
    limitingMarkers: [{ id: 100, code: 'ALPHA', name: 'Alpha' }],
} as any;

// Role IDENTITY (lib/db/adminIdentity.ts). The clearance bypass no longer reads the
// name-derived `role` tier, so `forgedAdminName` below is a NON-admin.
const adminActor = { id: 1, isSystemAdmin: true, permissions: [], clearanceLevel: { id: 1, level: 1 }, limitingMarkers: [] } as any;
const forgedAdminName = { id: 1, role: 'Admin', permissions: [], clearanceLevel: { id: 1, level: 1 }, limitingMarkers: [] } as any;
const bypassActor = { id: 2, role: 'Member', permissions: ['intel:manage'], clearanceLevel: { id: 1, level: 1 }, limitingMarkers: [] } as any;

beforeEach(() => {
    h.tables = {};
    h.inserts = [];
    h.updates = [];
    seedClearances();
    // A target user the clearance writes operate on.
    h.tables.users = [{ id: 42, name: 'Target', discord_id: 'd42', clearance_level_id: 1, deleted_at: null }];
});

describe('HIGH-2 — updateUserClearance author clamp', () => {
    it('rejects granting a level ABOVE the actor own clearance', async () => {
        await expect(updateUserClearance(42, 7, /* levelId */ 5, [], lowActor))
            .rejects.toThrow(/above your own/i);
        // No clearance write happened.
        expect(h.updates.find((u) => u.table === 'users' && 'clearance_level_id' in u.values)).toBeUndefined();
    });

    it('rejects granting a marker the actor does NOT hold', async () => {
        await expect(updateUserClearance(42, 7, /* levelId */ 1, [100, 200], lowActor))
            .rejects.toThrow(/marker you do not hold/i);
    });

    it('allows a grant at/below the actor level with only held markers', async () => {
        await expect(updateUserClearance(42, 7, 1, [100], lowActor)).resolves.toBeUndefined();
    });

    it('the stamped system Admin may grant any level + marker', async () => {
        await expect(updateUserClearance(42, 1, 5, [100, 200, 300], adminActor)).resolves.toBeUndefined();
    });

    // ROLE NAME IS NOT AUTHORITY: a permissionless custom role called 'Commander'
    // arrived as the Admin tier and could grant clearance above its own.
    it('a forged Admin role NAME is clamped to its own level and held markers', async () => {
        await expect(updateUserClearance(42, 1, 5, [100, 200, 300], forgedAdminName))
            .rejects.toThrow(/clearance level above your own/i);
    });

    it('canViewAllClassifications (intel:manage) actor bypasses the clamp', async () => {
        await expect(updateUserClearance(42, 2, 5, [999], bypassActor)).resolves.toBeUndefined();
    });
});

describe('HIGH-2 — bulkUpdateUserClearances author clamp', () => {
    it('rejects an above-own-level bulk grant before any write', async () => {
        await expect(bulkUpdateUserClearances([42], 7, 5, [], 'replace', lowActor))
            .rejects.toThrow(/above your own/i);
    });

    it('rejects an unheld-marker bulk grant', async () => {
        await expect(bulkUpdateUserClearances([42], 7, 1, [200], 'add', lowActor))
            .rejects.toThrow(/marker you do not hold/i);
    });

    it('allows in-bounds bulk grant; Admin/bypass actor may grant above', async () => {
        await expect(bulkUpdateUserClearances([42], 7, 1, [100], 'replace', lowActor)).resolves.toMatchObject({ updated: expect.any(Number) });
        await expect(bulkUpdateUserClearances([42], 1, 5, [500], 'replace', adminActor)).resolves.toBeTruthy();
        await expect(bulkUpdateUserClearances([42], 2, 5, [500], 'replace', bypassActor)).resolves.toBeTruthy();
    });
});

describe('HIGH-2 — updateUser clearance write clamp', () => {
    it('rejects an above-own-level clearance set through the generic profile path', async () => {
        await expect(updateUser(42, { clearanceLevelId: 5 }, lowActor))
            .rejects.toThrow(/above your own/i);
        expect(h.updates.find((u) => u.table === 'users' && 'clearance_level_id' in u.values)).toBeUndefined();
    });

    it('allows an in-bounds clearance set', async () => {
        await expect(updateUser(42, { clearanceLevelId: 1 }, lowActor)).resolves.toBeUndefined();
    });

    it('Admin actor may set any clearance level', async () => {
        await expect(updateUser(42, { clearanceLevelId: 5 }, adminActor)).resolves.toBeUndefined();
    });

    it('a plain profile edit (no clearanceLevelId) is UNAFFECTED by the clamp', async () => {
        // No actor, no clearance change — must not throw or require an actor.
        await expect(updateUser(42, { name: 'Renamed' })).resolves.toBeUndefined();
        expect(h.updates.some((u) => u.table === 'users' && u.values.name === 'Renamed')).toBe(true);
    });
});

describe('MED (auth#2) — getUserById excludes soft-deleted users', () => {
    it('returns null for a soft-deleted user', async () => {
        h.tables.users = [{ id: 99, name: 'Gone', discord_id: 'd99', deleted_at: '2026-01-01T00:00:00Z' }];
        const u = await getUserById(99);
        expect(u).toBeNull();
    });

    it('still returns a live (non-deleted) user', async () => {
        h.tables.users = [{ id: 99, name: 'Live', discord_id: 'd99', deleted_at: null }];
        const u = await getUserById(99);
        expect(u).toMatchObject({ id: 99, name: 'Live' });
    });
});

describe('HIGH-3 (partial) — createUser blocks duplicate discord_id', () => {
    const newUser = { discordId: 'dup-1', name: 'Squatter', avatarUrl: '', rsiHandle: 'h', isAdmin: false };

    it('throws when a non-deleted user with the same discord_id exists', async () => {
        h.tables.users = [{ id: 5, name: 'Victim', discord_id: 'dup-1', deleted_at: null }];
        await expect(createUser(newUser)).rejects.toThrow(/already exists/i);
        // No insert into users occurred.
        expect(h.inserts.some((i) => i.table === 'users')).toBe(false);
    });

    it('creates a user when no live row holds that discord_id', async () => {
        h.tables.users = [];
        const created = await createUser(newUser);
        expect(created).toBeTruthy();
        expect(h.inserts.some((i) => i.table === 'users' && i.values.discord_id === 'dup-1')).toBe(true);
    });

    it('treats a soft-deleted duplicate as NOT blocking (only live rows block)', async () => {
        h.tables.users = [{ id: 5, name: 'Old', discord_id: 'dup-1', deleted_at: '2026-01-01T00:00:00Z' }];
        await expect(createUser(newUser)).resolves.toBeTruthy();
    });
});

describe('updateUser — identity/profile write boundary', () => {
    const userUpdate = () => h.updates.find((u) => u.table === 'users')?.values ?? {};

    it('DROPS rsiHandle — the generic admin path cannot rewrite a verified identity', async () => {
        // admin:user:update is delegable and weaker than the verify flow; rewriting
        // rsi_handle reassigns who the row IS and absorbs that handle's ad-hoc requests.
        await expect(updateUser(42, { rsiHandle: 'Attacker', name: 'Renamed' }, adminActor)).resolves.toBeUndefined();
        // Key-based, so an accidental `rsi_handle: undefined` still fails.
        expect(Object.keys(userUpdate())).not.toContain('rsi_handle');
        // ...while the legitimate sibling field on the same call still lands.
        expect(userUpdate().name).toBe('Renamed');
    });

    it.each([
        ['javascript:alert(1)'],
        ['http://cdn.example/a.png'],
        ['https://cdn.example/a.svg'],
        ['https://user:pass@cdn.example/a.png'],
        ['https://tracker.example/pixel'],
    ])('clears a non-image / non-https avatarUrl (%s) to null', async (bad) => {
        await expect(updateUser(42, { avatarUrl: bad }, adminActor)).resolves.toBeUndefined();
        expect(userUpdate().avatar_url).toBeNull();
    });

    it('preserves a real Discord CDN avatar verbatim', async () => {
        const real = 'https://cdn.discordapp.com/avatars/1/abc.png';
        await expect(updateUser(42, { avatarUrl: real }, adminActor)).resolves.toBeUndefined();
        expect(userUpdate().avatar_url).toBe(real);
    });

    it('strips markup out of name and never blanks it', async () => {
        await updateUser(42, { name: '<img src=x onerror=alert(1)>Bob' }, adminActor);
        expect(userUpdate().name).toBe('Bob');
        h.updates = [];
        // A name that is nothing BUT markup is a no-op, not a blanking.
        await updateUser(42, { name: '<b></b>' }, adminActor);
        expect(Object.keys(userUpdate())).not.toContain('name');
    });
});

describe('createUser — pre-auth identity / avatar / name guards', () => {
    // auth:finalize_setup is a PUBLIC_ACTION: rsiHandle, name and avatarUrl are all
    // client-supplied and only discordId is bound by the identity grant.
    const insertedUser = () => h.inserts.find((i) => i.table === 'users')?.values ?? {};
    const payload = (over: Record<string, unknown> = {}) => ({
        discordId: '9', name: 'Newbie', avatarUrl: 'https://cdn.discordapp.com/avatars/9/abc.png',
        rsiHandle: 'Ok_Handle', isAdmin: false, ...over,
    } as Parameters<typeof createUser>[0]);

    beforeEach(() => {
        // The suite-wide beforeEach seeds a live users row, and the mock builder's
        // .ilike() is a no-op — so the handle-uniqueness pre-check would match it and
        // throw before any assertion here could run.
        h.tables.users = [];
    });

    it('clears an arbitrary-origin avatarUrl to null', async () => {
        await createUser(payload({ avatarUrl: 'https://evil.example/x' }));
        expect(insertedUser().avatar_url).toBeNull();
        // The rest of the row still lands.
        expect(insertedUser().rsi_handle).toBe('Ok_Handle');
    });

    it('keeps a genuine Discord avatar URL verbatim', async () => {
        await createUser(payload());
        expect(insertedUser().avatar_url).toBe('https://cdn.discordapp.com/avatars/9/abc.png');
    });

    it('strips markup out of the client-supplied name, falling back to the handle', async () => {
        await createUser(payload({ name: '<script>alert(1)</script>Newbie' }));
        expect(insertedUser().name).toBe('alert(1)Newbie');
        h.inserts = [];
        h.tables.users = [];
        await createUser(payload({ name: '<b></b>' }));
        expect(insertedUser().name).toBe('Ok_Handle');
    });

    it.each(['%', 'a/b', '', 'a'.repeat(61), 'has space', '../etc'])('refuses a malformed rsiHandle (%s) with no insert', async (handle) => {
        await expect(createUser(payload({ rsiHandle: handle }))).rejects.toThrow(/valid RSI handle/i);
        expect(h.inserts.some((i) => i.table === 'users')).toBe(false);
    });
});
