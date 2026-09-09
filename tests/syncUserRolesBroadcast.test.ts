import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ROUTE F (Phase 3 wave 3, owner-approved) — syncUserRoles now emits a `user_update`.
//
// It was the ONE user-writing path in lib/db/users.ts with no emit, while its seven
// single-user siblings all have one, and it writes role_id, rank_id, name and avatar_url.
// Since Phase 3 item 3 roster delivery is permission-dependent, so a promotion or
// demotion applied here reached no connected client until something unrelated happened to
// emit — leaving both a stale-PROMOTION window (a user the org just promoted still
// rendering the customer nav) and a stale-DEMOTION window.
//
// A SEPARATE FILE from tests/userUpdateBroadcasts.test.ts on purpose: that file's
// `../lib/discord` mock returns `getDiscordMember: async () => null`, which would send
// every call here down the "User not in Discord server" early return.
//
// The properties pinned: exactly one emit, ids only, nothing on any early return, and
// nothing when the write fails (the emit sits AFTER handleSupabaseError).

const h = vi.hoisted(() => ({
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    sysRoles: {} as Record<string, unknown>,
    calls: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    member: null as unknown,
    userRow: null as unknown,
    userList: null as unknown,
    updateError: null as unknown,
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/discord', () => ({
    getDiscordMember: async () => h.member,
    pushDiscordRolesForUser: async () => undefined,
    getDiscordUserById: async () => null,
    buildGlobalAvatarUrl: () => 'https://cdn/a.png',
}));

vi.mock('../lib/db/system', () => ({
    getAllSettings: async () => ({ brandingConfig: { dutyTimeoutMinutes: 30 } }),
}));

/** Did this recorded chain include an update()? (Distinguishes the pre-read from the write.) */
const hasUpdate = (calls: Array<{ method: string }>) => calls.some(c => c.method === 'update');

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        h.calls.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gt', 'gte',
            'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        // `viaSingle` separates the two DIFFERENT `users` reads in play once
        // syncAllMemberRoles is under test: the per-user identity fetch inside
        // syncUserRoles ends in .single(), while the bulk roster listing is awaited
        // directly and must yield an ARRAY. Without the discriminator the bulk loop
        // receives one object and iterates its keys.
        const settle = (viaSingle: boolean) => {
            if (table === 'users') {
                if (hasUpdate(calls)) return Promise.resolve({ data: null, error: h.updateError });
                if (!viaSingle) return Promise.resolve({ data: h.userList, error: null });
                return Promise.resolve({ data: h.userRow, error: null });
            }
            if (table === 'rank_mappings') {
                return Promise.resolve({ data: [{ discord_role_id: '55', rank_id: 3, role_id: null }], error: null });
            }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(true); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(true); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle(false).then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown>) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        getSystemRoles: async () => h.sysRoles,
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import { syncUserRoles, syncAllMemberRoles } from '../lib/db/users';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** CRLF-SAFE body slice. `indexOf('\n}\n')` returns -1 in this checkout and
 *  `slice(start, -1)` then widens the body to nearly the whole file, so everything
 *  below it would pass for the wrong reason. Never omit the explicit end check. */
function fnBody(src: string, decl: string): string {
    const start = src.indexOf(decl);
    expect(start, `declaration not found: ${decl}`).toBeGreaterThan(-1);
    const end = src.slice(start).search(/\r?\n\}\r?\n/);
    expect(end, `closing brace not found for: ${decl}`).toBeGreaterThan(-1);
    return src.slice(start, start + end);
}

const usersUpdates = () => h.calls.filter(c => c.table === 'users' && hasUpdate(c.calls));

// syncAllMemberRoles holds its 15-minute cooldown in a module-scoped Map, so the second
// bulk call in this file would throw BULK_SYNC_COOLDOWN. Drive a stubbed clock forward
// instead of reaching into module private state — that also keeps the bulk tests
// order-independent, since each one advances past whatever the previous left behind.
let clock = Date.now();
vi.spyOn(Date, 'now').mockImplementation(() => clock);
const advancePastBulkCooldown = () => { clock += 20 * 60 * 1000; };

beforeEach(() => {
    h.broadcasts = [];
    h.calls = [];
    h.updateError = null;
    h.sysRoles = { client: { id: 1 }, member: { id: 2 }, dispatcher: { id: 3 }, admin: { id: 4 } };
    h.userRow = { discord_id: '1', role_id: 2, discord_synced_at: null };
    h.userList = [{ id: 1 }, { id: 2 }, { id: 3 }];
    h.member = { nick: 'Ana', roles: ['55'], user: { id: '1', username: 'ana', global_name: 'Ana', avatar: 'abc' } };
});

describe('ROUTE F — syncUserRoles emits user_update', () => {
    it('23. a successful sync emits EXACTLY ONE user_update, ids only', async () => {
        await expect(syncUserRoles(42)).resolves.toBe('Identity & Roles Synced');
        expect(h.broadcasts).toHaveLength(1);
        expect(h.broadcasts[0].event).toBe('user_update');
        expect(h.broadcasts[0].payload).toEqual({ userId: 42 });
        expect(Object.keys(h.broadcasts[0].payload)).toEqual(['userId']);
    });

    it('24. rule 4 — the payload carries no CONTENT, only the id', async () => {
        // The temptation on a sync path is to put "what changed" on the wire. The
        // receiver must fetch it back through the permission-gated users_slice /
        // user_detail paths instead.
        await syncUserRoles(42);
        const blob = JSON.stringify(h.broadcasts[0].payload);
        for (const forbidden of ['role_id', 'rank_id', 'discord', 'avatar', 'name']) {
            expect(blob, `${forbidden} rode the broadcast payload`).not.toContain(forbidden);
        }
    });

    it('25. the COOLDOWN early return emits nothing and writes nothing', async () => {
        h.userRow = { discord_id: '1', role_id: 2, discord_synced_at: new Date(Date.now()).toISOString() };
        await expect(syncUserRoles(42)).resolves.toMatch(/^SYNC_COOLDOWN:/);
        expect(h.broadcasts).toEqual([]);
        expect(usersUpdates()).toHaveLength(0);
    });

    it('26. the NOT-IN-GUILD early return emits nothing', async () => {
        h.member = null;
        await expect(syncUserRoles(42)).resolves.toBe('User not in Discord server');
        expect(h.broadcasts).toEqual([]);
        expect(usersUpdates()).toHaveLength(0);
    });

    it('27. a missing user row throws and emits nothing', async () => {
        h.userRow = null;
        await expect(syncUserRoles(42)).rejects.toThrow(/User not found/);
        expect(h.broadcasts).toEqual([]);
    });

    it('28. ORDERING — a FAILED write emits nothing', async () => {
        // A broadcast placed before handleSupabaseError would tell every connected client
        // a role change happened that did not. Same property test 16 of
        // tests/userUpdateBroadcasts.test.ts pins for promoteUserToMember.
        h.updateError = { message: 'boom' };
        await expect(syncUserRoles(42)).rejects.toThrow(/Failed to update synced user/);
        expect(h.broadcasts).toEqual([]);
    });

    it('29. the guard and the ordering are pinned STRUCTURALLY (source-text, CRLF-safe)', () => {
        // The guard is `Object.keys(updates).length > 0`, exactly as the owner decision is
        // written. IT IS CURRENTLY ALWAYS TRUE: `updates.discord_synced_at` is stamped
        // unconditionally a few lines above, and name/avatar_url whenever the Discord
        // member carries a user object. It is kept because it is the right SHAPE — if the
        // stamp ever becomes conditional the broadcast narrows with it. DO NOT delete it
        // as dead code, and do not hoist it above the stamp or narrow it to specific
        // columns: either CHANGES the decision and needs the owner. A behavioural test
        // cannot express this, which is why the ratchet is here.
        const body = fnBody(read('lib/db/users.ts'), 'export async function syncUserRoles');
        expect(body).toContain('if (Object.keys(updates).length > 0 && !options?.suppressBroadcast) {');
        expect(body).toContain('await broadcastUserUpdate(userId);');
        const iErr = body.indexOf('handleSupabaseError({ error: updateError');
        const iEmit = body.indexOf('await broadcastUserUpdate(userId);');
        expect(iErr).toBeGreaterThan(-1);
        expect(iEmit).toBeGreaterThan(iErr);
    });

    it('30. syncAllMemberRoles suppresses the per-user emit and sends ONE aggregate frame', async () => {
        // OWNER RULING 2026-09-03, replacing the deliberately-unblessed placeholder that
        // stood here while the question was open. The per-user emit as first written made
        // a bulk sync of an N-member org issue N broadcasts, bounded not by
        // SYNC_COOLDOWN_MS (bypassed here) but by the 15-minute BULK_SYNC_COOLDOWN_MS —
        // against this file's own convention, which the five other bulk paths follow.
        advancePastBulkCooldown();
        await syncAllMemberRoles();
        expect(usersUpdates()).toHaveLength(3);        // all three users really were written
        expect(h.broadcasts).toHaveLength(1);          // ...and it cost ONE frame, not three
        expect(h.broadcasts[0].event).toBe('user_update');
        expect(h.broadcasts[0].payload).toEqual({ bulk: true, count: 3, userIds: [1, 2, 3] });
    });

    it('31. the aggregate payload matches the shape the five sibling bulk paths use', async () => {
        // { bulk: true, count, userIds } — a receiver keyed on `bulk` must not have to
        // special-case this one path, and rule 4 still holds: ids only, no content.
        advancePastBulkCooldown();
        await syncAllMemberRoles();
        expect(Object.keys(h.broadcasts[0].payload).sort()).toEqual(['bulk', 'count', 'userIds']);
        const blob = JSON.stringify(h.broadcasts[0].payload);
        for (const forbidden of ['role_id', 'rank_id', 'discord', 'avatar', 'name']) {
            expect(blob, `${forbidden} rode the aggregate payload`).not.toContain(forbidden);
        }
    });

    it('32. a bulk run where NOTHING synced emits nothing at all', async () => {
        // Every user short-circuits on the not-in-guild return, so no row is written. An
        // unconditional aggregate emit would nudge every connected browser into a
        // users_slice refetch for a run that changed nothing.
        h.member = null;
        advancePastBulkCooldown();
        await syncAllMemberRoles();
        expect(usersUpdates()).toHaveLength(0);
        expect(h.broadcasts).toEqual([]);
    });

    it('33. a bulk run where every user FAILS emits nothing', async () => {
        // The loop catches and logs per-user failures. A failed write must not appear in
        // userIds — telling clients to refetch rows that did not change is the same lie
        // test 28 pins for the single-user path.
        h.updateError = { message: 'boom' };
        advancePastBulkCooldown();
        await syncAllMemberRoles();
        expect(h.broadcasts).toEqual([]);
    });

    it('34. the suppression is STRUCTURALLY pinned to the bulk caller alone', () => {
        // `suppressBroadcast` exists for exactly one caller. Setting it anywhere else to
        // quieten a noisy path re-creates the stale-roster bug ROUTE F was opened to
        // close, so the ratchet pins both that the bulk path passes it and that nothing
        // else in the file does.
        const src = read('lib/db/users.ts');
        const bulk = fnBody(src, 'export async function syncAllMemberRoles');
        expect(bulk).toContain('{ bypassCooldown: true, suppressBroadcast: true }');
        expect(bulk).toContain("broadcastToOrg('user_update', { bulk: true, count: syncedIds.length, userIds: syncedIds })");
        // Exactly ONE site actually SETS it. Prose mentions do not count, which is why
        // this counts the call form rather than the bare identifier.
        expect(src.split('suppressBroadcast: true').length - 1).toBe(1);
    });
});
