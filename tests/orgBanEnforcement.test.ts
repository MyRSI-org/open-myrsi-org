import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ORG BANS — the enforcement contract.
//
// Before this the open build had NO admin-initiated member exclusion of any kind. The
// only levers were bulk-demote-to-client, a conduct entry, and revoke-sessions — which
// kicks a session the member re-establishes with one Discord click.
//
// The two properties that matter most are both about FAILURE DIRECTION:
//
//   1. findActiveBan FAILS CLOSED. A query fault THROWS rather than returning null,
//      because "not banned" on a DB blip is the one failure mode that silently un-bans
//      everybody at once.
//   2. ...but it must NEVER fail INTO a ban screen. A read fault is a retryable 503,
//      not an accusation. Telling an innocent member they are banned because a query
//      failed is its own kind of incident.
//
// Those pull in opposite directions, which is exactly why both are pinned.

const h = vi.hoisted(() => ({
    banRows: [] as Array<Record<string, unknown>>,
    banError: null as { code?: string; message: string } | null,
    inserted: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    queries: [] as Array<{ table: string; orders: string[]; limit?: number; ins: Array<{ col: string; vals: unknown[] }> }>,
    // Rows for the tables the holder lookup walks (permissions → role_permissions →
    // users), plus the system-role slots it resolves its identity arm from.
    tableRows: {} as Record<string, Array<Record<string, unknown>>>,
    tableError: {} as Record<string, { code?: string; message: string } | undefined>,
    systemRoles: {} as { admin?: { id: number; name: string } },
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const rec = { table, orders: [] as string[], limit: undefined as number | undefined, ins: [] as Array<{ col: string; vals: unknown[] }> };
        const state = { op: 'select' };
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'not', 'or', 'range', 'gte', 'lte', 'ilike']) b[m] = () => b;
        // .in() is recorded, not ignored: the holder lookup's whole correctness is
        // WHICH role ids it asks about.
        b.in = (col: string, vals: unknown[]) => { rec.ins.push({ col, vals }); return b; };
        b.order = (col: string) => { rec.orders.push(col); return b; };
        b.limit = (n: number) => { rec.limit = n; return b; };
        b.insert = (v: Record<string, unknown>) => { state.op = 'insert'; h.inserted.push(v); return b; };
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; h.updates.push(v); return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        const settle = (mode: 'one' | 'many') => {
            h.queries.push(rec);
            const err = table === 'organization_bans' ? h.banError : h.tableError[table];
            if (err) return Promise.resolve({ data: null, error: err });
            if (state.op === 'insert') return Promise.resolve({ data: h.banRows[0] ?? null, error: null });
            if (state.op === 'update' || state.op === 'delete') return Promise.resolve({ data: h.banRows[0] ?? null, error: null });
            const rows = table === 'organization_bans' ? h.banRows : (h.tableRows[table] ?? []);
            return Promise.resolve({ data: mode === 'one' ? (rows[0] ?? null) : rows, error: null });
        };
        b.single = () => settle('one');
        b.maybeSingle = () => settle('one');
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle('many').then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => h.systemRoles, safeFetch: async () => [],
    };
});

import { findActiveBan, filterActivelyBanned, getBanPermissionHolderIds, BanCheckUnavailable } from '../lib/db/bans';
import { stripSqlComments } from './stripComments';

const activeBan = (over: Record<string, unknown> = {}) => ({
    id: 1, reason: 'Repeated griefing', expires_at: null, banned_at: '2026-01-01T00:00:00Z', ...over,
});

beforeEach(() => {
    h.banRows = []; h.banError = null; h.inserted = []; h.updates = []; h.queries = [];
    h.tableRows = {}; h.tableError = {}; h.systemRoles = {};
});

describe('findActiveBan — fails CLOSED, but never into a ban screen', () => {
    it('finds an active ban by user id', async () => {
        h.banRows = [activeBan()];
        const ban = await findActiveBan({ userId: 5 });
        expect(ban?.id).toBe(1);
        expect(ban?.reason).toBe('Repeated griefing');
    });

    it('THROWS on a query fault rather than degrading to "not banned"', async () => {
        // The one failure mode that silently un-bans everybody at once.
        h.banError = { message: 'connection reset' };
        await expect(findActiveBan({ userId: 5 })).rejects.toBeInstanceOf(BanCheckUnavailable);
    });

    it('evaluates expiry against the SERVER clock, not a client assertion', async () => {
        h.banRows = [activeBan({ expires_at: '2020-01-01T00:00:00Z' })];
        expect(await findActiveBan({ userId: 5 })).toBeNull();

        h.banRows = [activeBan({ expires_at: '2999-01-01T00:00:00Z' })];
        expect(await findActiveBan({ userId: 5 })).not.toBeNull();
    });

    it('an unidentifiable caller is NOT an error — and issues no query', async () => {
        expect(await findActiveBan({})).toBeNull();
        expect(await findActiveBan({ userId: null, discordId: null })).toBeNull();
        expect(h.queries).toEqual([]);
    });

    it('refuses a malformed discord id rather than interpolating it into a filter', async () => {
        // The id lands in a raw PostgREST .or() grammar when both identities are present.
        expect(await findActiveBan({ discordId: 'not-a-snowflake' })).toBeNull();
        expect(await findActiveBan({ discordId: '123,user_id.eq.1' })).toBeNull();
        expect(h.queries).toEqual([]);
    });

    it('matches on EITHER identity, so a ban survives a soft delete and re-signup', async () => {
        // deleteUser retains discord_id "for ban-evasion detection", and the evasion route
        // is delete-then-sign-in-again, which mints a NEW user row with the same Discord id.
        h.banRows = [activeBan()];
        expect(await findActiveBan({ userId: 5, discordId: '123456789' })).not.toBeNull();
        expect(await findActiveBan({ discordId: '123456789' })).not.toBeNull();
    });

    it('reads with a total order and a cap (the absolute order rule)', async () => {
        h.banRows = [activeBan()];
        await findActiveBan({ userId: 5 });
        const q = h.queries.find((x) => x.table === 'organization_bans')!;
        expect(q.orders).toContain('id');
        expect(q.limit).toBe(2);
    });
});

describe('filterActivelyBanned — the recoverability guard cannot guess', () => {
    it('fails CLOSED so "I could not tell" never reads as "nobody is banned"', async () => {
        h.banError = { message: 'connection reset' };
        await expect(filterActivelyBanned([1, 2, 3])).rejects.toBeInstanceOf(BanCheckUnavailable);
    });

    it('issues no query for an empty id set', async () => {
        expect(await filterActivelyBanned([])).toEqual(new Set());
        expect(h.queries).toEqual([]);
    });

    it('caps at EXACTLY the id count, which the partial unique index makes exact', async () => {
        // A truncating cap here would silently UNDER-report who is banned — the direction
        // that strands the org with nobody able to lift.
        h.banRows = [];
        await filterActivelyBanned([1, 2, 3]);
        const q = h.queries.find((x) => x.table === 'organization_bans')!;
        expect(q.limit).toBe(3);
        expect(q.orders).toContain('id');
    });

    it('drops expired bans from the active set', async () => {
        h.banRows = [
            { user_id: 1, expires_at: '2020-01-01T00:00:00Z' },
            { user_id: 2, expires_at: null },
        ];
        const out = await filterActivelyBanned([1, 2]);
        expect([...out]).toEqual([2]);
    });
});

describe('the dispatcher gate is positioned and shaped correctly', () => {
    const src = readFileSync(resolve(__dirname, '..', 'api', 'services.ts'), 'utf8');

    it('runs ABOVE the permission gate, because user: maps to a pseudo-permission', () => {
        // 'user:' maps to user:manage:self, which stops nobody — so a ban gate below the
        // permission gate would still let a banned member call user:heartbeat (staying on
        // the duty roster), user:toggle_duty, user:apply_job and user:delete_self.
        const gate = src.indexOf('ORG BAN GATE');
        const permGate = src.indexOf('fullPermissionMap[action]');
        expect(gate).toBeGreaterThan(-1);
        expect(permGate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(permGate);
    });

    it('runs BELOW the watermark check, and ban:place does not stamp the watermark', () => {
        // If placing a ban revoked sessions, the watermark 401 above this gate would fire
        // first — every token a banned member holds predates their ban by definition — so
        // they could never reach BAN_EXEMPT_ACTIONS and the whole appeal flow would be dead.
        const watermark = src.indexOf('isSessionRevokedByWatermark');
        expect(watermark).toBeLessThan(src.indexOf('ORG BAN GATE'));

        const actions = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'bans.ts'), 'utf8');
        const place = actions.slice(actions.indexOf("'ban:place'"), actions.indexOf("'ban:lift'"));
        expect(place).not.toMatch(/revokeUserSessions/);
    });

    it('a ban-check fault is a 503, never a ban screen', () => {
        const gate = src.slice(src.indexOf('ORG BAN GATE'), src.indexOf('--- PAYLOAD INJECTION ---'));
        expect(gate).toContain('BAN_CHECK_UNAVAILABLE');
        expect(gate).toContain('503');
        // And the catch is not bare: an unexpected throw in the gate itself must be logged,
        // not silently turned into a permanent outage for every user.
        expect(gate).toMatch(/name !== 'BanCheckUnavailable'/);
        expect(gate).toContain('log.error');
    });

    it('exempts exactly the three actions a banned member is still entitled to', () => {
        const m = /const BAN_EXEMPT_ACTIONS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
        expect(m, 'BAN_EXEMPT_ACTIONS was renamed').not.toBeNull();
        const list = m![1];
        for (const a of ['user:logout', 'ban:my_notice', 'ban:submit_appeal']) {
            expect(list).toContain(a);
        }
        expect(list.split(',').filter((x) => x.trim()).length).toBe(3);
    });

    it('the ban namespace is a PROTECTED prefix and every action is in the permission map', () => {
        expect(src).toMatch(/PROTECTED_PREFIXES[^\n]*'ban:'/);
        for (const a of ['ban:place', 'ban:lift', 'ban:list', 'ban:list_appeals', 'ban:review_appeal', 'ban:my_notice', 'ban:submit_appeal']) {
            expect(src, `${a} has no fullPermissionMap entry`).toContain(`'${a}':`);
        }
    });
});

describe('ban:place refusals cannot be used as an enumeration oracle', () => {
    const actions = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'bans.ts'), 'utf8');

    it('every refusal returns ONE generic message', () => {
        // api/services.ts returns error.message verbatim, and targetUserId is caller-chosen.
        // Distinguishable messages would make ban:place an oracle for "does user N hold
        // admin:user:ban" and "does user N exist".
        const place = actions.slice(actions.indexOf("'ban:place'"), actions.indexOf("'ban:lift'"));
        const denials = [...place.matchAll(/new SecurityDenial\(\s*([^,]+),/g)].map((m) => m[1].trim());
        expect(denials.length).toBeGreaterThanOrEqual(3);
        expect(new Set(denials).size, `distinct refusal messages: ${denials.join(' | ')}`).toBe(1);
    });

    it('but keeps DISTINCT audit slugs, because the trail is where detail belongs', () => {
        const place = actions.slice(actions.indexOf("'ban:place'"), actions.indexOf("'ban:lift'"));
        for (const slug of ['self_denied', 'peer_denied', 'last_lifter_denied']) {
            expect(place).toContain(slug);
        }
    });

    it('drops push AND evicts voice — the two channels the gate cannot reach', () => {
        const place = actions.slice(actions.indexOf("'ban:place'"), actions.indexOf("'ban:lift'"));
        // Asserts the CALL, not the identifier. `toContain('evictUserFromAllRooms')` passes
        // even when the call is replaced by a reference that never runs.
        expect(place).toMatch(/await db\.dropPushSubscriptions\(/);
        expect(place).toMatch(/await evictUserFromAllRooms\(/);
    });
});

describe('getBanPermissionHolderIds — the org\'s own Admin is a holder BY IDENTITY', () => {
    // The hole this pins: a permission reaches a role only through seedInstall (first
    // boot) or repairDatabase (a button someone has to click), so on an upgraded
    // install admin:user:ban sits in the catalogue while the Admin role holds no
    // role_permissions row for it. With only the delegated arm, the org's Admin was
    // not a "peer" — a delegated ban-holder could ban them out of their own org, and
    // the break-glass that undoes it is itself an Admin-gated control.
    const adminRole = { admin: { id: 9, name: 'Admin' } };
    const roleIdsAsked = () => h.queries.find((q) => q.table === 'users')?.ins.find((i) => i.col === 'role_id')?.vals;

    it('lists Admin-role members even when role_permissions grants the permission to nobody', async () => {
        h.systemRoles = adminRole;
        h.tableRows = { permissions: [{ id: 1 }], role_permissions: [], users: [{ id: 42 }] };
        expect(await getBanPermissionHolderIds()).toEqual([42]);
        expect(roleIdsAsked()).toContain(9);
    });

    it('unions the two arms rather than picking one', async () => {
        h.systemRoles = adminRole;
        h.tableRows = { permissions: [{ id: 1 }], role_permissions: [{ role_id: 3 }, { role_id: 3 }], users: [{ id: 7 }, { id: 42 }] };
        await getBanPermissionHolderIds();
        const asked = roleIdsAsked() as number[];
        expect([...asked].sort()).toEqual([3, 9]);
    });

    it('does not short-circuit before the identity arm when the permission itself is missing', async () => {
        // The catalogue row is absent entirely (a schema older than the ban feature).
        // The old code returned [] here, which reads as "nobody can lift" — the state
        // that both strands the org AND leaves its Admin unprotected.
        h.systemRoles = adminRole;
        h.tableRows = { permissions: [], role_permissions: [], users: [{ id: 42 }] };
        expect(await getBanPermissionHolderIds()).toEqual([42]);
        expect(roleIdsAsked()).toEqual([9]);
    });

    it('the identity arm only ever ADDS — an unresolvable Admin slot degrades, never throws', async () => {
        // A pre-migration org whose roles cannot be identified keeps a working ban
        // feature at exactly the strength it had before this arm existed.
        h.systemRoles = {};
        h.tableRows = { permissions: [{ id: 1 }], role_permissions: [{ role_id: 3 }], users: [{ id: 7 }] };
        expect(await getBanPermissionHolderIds()).toEqual([7]);
        expect(roleIdsAsked()).toEqual([3]);
    });

    it('returns [] without a users read when neither arm yields a role', async () => {
        h.systemRoles = {};
        h.tableRows = { permissions: [{ id: 1 }], role_permissions: [] };
        expect(await getBanPermissionHolderIds()).toEqual([]);
        expect(h.queries.some((q) => q.table === 'users')).toBe(false);
    });

    it('fails CLOSED on a read fault in either arm', async () => {
        h.systemRoles = adminRole;
        h.tableError = { permissions: { message: 'connection reset' } };
        await expect(getBanPermissionHolderIds()).rejects.toBeInstanceOf(BanCheckUnavailable);

        h.tableError = { role_permissions: { message: 'connection reset' } };
        h.tableRows = { permissions: [{ id: 1 }] };
        await expect(getBanPermissionHolderIds()).rejects.toBeInstanceOf(BanCheckUnavailable);

        h.tableError = { users: { message: 'connection reset' } };
        h.tableRows = { permissions: [{ id: 1 }], role_permissions: [{ role_id: 3 }] };
        await expect(getBanPermissionHolderIds()).rejects.toBeInstanceOf(BanCheckUnavailable);
    });

    it('reads with a total order and a cap (the absolute order rule)', async () => {
        h.systemRoles = adminRole;
        h.tableRows = { permissions: [{ id: 1 }], role_permissions: [{ role_id: 3 }], users: [] };
        await getBanPermissionHolderIds();
        const q = h.queries.find((x) => x.table === 'users')!;
        expect(q.orders).toContain('id');
        expect(q.limit).toBe(500);
    });
});

describe('a ban tears down REALTIME too, not just push and voice', () => {
    // The third channel a ban has to close. ban:place already drops push subscriptions
    // and evicts LiveKit rooms, because neither is a request the ban gate gets to
    // refuse. A Supabase Realtime subscription is the same shape and the widest of the
    // three: it authorizes on a JWT minted BEFORE the ban, so without a server-side ban
    // term a banned member kept receiving private-channel broadcasts — and kept their
    // PostgREST read of every rt_client_tables() table — for the life of that token.
    //
    // ban:place deliberately does not stamp tokens_valid_from (that would 401 the member
    // out of their own appeal), so the token cannot be the boundary. The ban ROW has to
    // be, on this surface exactly as on every HTTP one.
    const schema = stripSqlComments(readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8'));
    const fn = (name: string) => {
        const i = schema.indexOf(`CREATE OR REPLACE FUNCTION private.${name}`);
        expect(i, `${name} was renamed or removed`).toBeGreaterThan(-1);
        const j = schema.indexOf('$$;', i);
        expect(j, `${name} has no body terminator`).toBeGreaterThan(i);
        return schema.slice(i, j);
    };

    it('rt_is_live_member refuses an ACTIVE ban, on either identity', () => {
        const body = fn('rt_is_live_member');
        expect(body).toContain('organization_bans');
        expect(body, 'a lifted ban must not keep locking anyone out').toContain('lifted_at IS NULL');
        expect(body, 'expiry is evaluated server-side, like findActiveBan').toContain('expires_at');
        // Either identity: a ban survives a soft delete and re-signup, which mints a new
        // users row carrying the same discord_id.
        expect(body).toContain('b.user_id = u.id');
        expect(body).toContain('b.discord_id = u.discord_id');
        // NOT EXISTS, not EXISTS — the direction is the whole point.
        expect(body).toMatch(/AND NOT EXISTS\s*\(\s*SELECT 1 FROM public\.organization_bans/);
    });

    it('rt_can_read_op_board DELEGATES liveness instead of restating it', () => {
        // This predicate used to carry its own copy of deleted_at + tokens_valid_from —
        // the "second place to keep them right" the rt_is_staff() note warns against —
        // and a second copy is exactly how the ban term would go missing from one of
        // them. The tactical board carries full element content, so that miss is a live
        // content leak, not a cosmetic one.
        const body = fn('rt_can_read_op_board');
        expect(body).toContain('private.rt_is_live_member()');
        expect(body, 'liveness was restated here again — it must be delegated').not.toContain('tokens_valid_from');
        expect(body).not.toContain('u.deleted_at');
    });

    it('the client drops its realtime auth the moment a ban is observed', () => {
        // The server is the boundary; this is belt-and-braces so the browser is not
        // holding an open channel retrying against a predicate that can never pass.
        const src = readFileSync(resolve(__dirname, '..', 'contexts', 'SessionContext.tsx'), 'utf8');
        const i = src.indexOf('registerRealtimeAuth(realtimeToken');
        expect(i).toBeGreaterThan(-1);
        const effect = src.slice(src.lastIndexOf('useEffect', i), src.indexOf('}, [', i));
        expect(effect, 'the ban is not consulted before re-registering realtime auth').toContain('!banNotice');
        // And banNotice must be a dependency, or the teardown never re-runs.
        expect(src.slice(i, src.indexOf(']);', i))).toContain('banNotice');
    });
});
