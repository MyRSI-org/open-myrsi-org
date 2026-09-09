import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Phase 3 item 2 — the realtime EMIT CONTRACTS around identity and duty.
//
// Two separate rules are pinned here, and both are easy to regress silently because
// a missing broadcast produces no error anywhere:
//
//   1. `promoteUserToMember` MUST emit `user_update`. It is the normal way a Client
//      becomes a Member (the admin Clients tab and HR application approval both land
//      here), and it was the ONE role-writing path in lib/db/users.ts with no
//      broadcast while every sibling had one. From Phase 3 item 3 onward a non-staff
//      caller holds no roster, so SessionContext's roster reconcile cannot fire for
//      them — this broadcast is the ONLY thing that refreshes their role, permissions
//      and nav, and the only trigger for the staff-transition rehydrate.
//      It must sit AFTER the write's error check: a failed write emits nothing.
//
//   2. CLAUDE.md security rule 4 — realtime carries IDS, NEVER CONTENT.
//      `toggleUserDutyStatus` used to put `status` (user X's duty state) on the wire
//      to every base-channel receiver with no permission gate. The sole consumer
//      destructures nothing and refetches the permission-gated users_presence subset
//      for the answer, so the value had no reader at all.
//      The sibling emitter in `cleanupInactiveDutyUsers` keeps `{ cleanup: true }` —
//      that is a SWEEP DISCRIMINATOR naming which event happened, not a per-user
//      state value, which is why it may stay while `status` had to go. The ratchet
//      does not close unless BOTH duty_update emitters are pinned, so both are here.

const h = vi.hoisted(() => ({
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    sysRoles: {} as Record<string, unknown>,
    resolveQuery: (() => ({ data: null as unknown, error: null as unknown })) as
        (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    calls: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => mk(),
    });
    return { log: mk() };
});

// Discord role push is fire-and-forget off the promote path; stub it so the test
// never reaches the network and a rejection cannot colour the assertion.
vi.mock('../lib/discord', () => ({
    getDiscordMember: async () => null,
    pushDiscordRolesForUser: async () => undefined,
    getDiscordUserById: async () => null,
    buildGlobalAvatarUrl: () => null,
}));

vi.mock('../lib/db/system', () => ({
    getAllSettings: async () => ({ brandingConfig: { dutyTimeoutMinutes: 30 } }),
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        h.calls.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gt', 'gte',
            'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
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

import { promoteUserToMember, toggleUserDutyStatus, cleanupInactiveDutyUsers } from '../lib/db/users';

const hasUpdate = (calls: Array<{ method: string; args: unknown[] }>) => calls.some((c) => c.method === 'update');

beforeEach(() => {
    h.broadcasts = [];
    h.calls = [];
    h.sysRoles = { client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' } };
    h.resolveQuery = () => ({ data: null, error: null });
});

describe('promoteUserToMember — the flagship Client → Member transition', () => {
    it('15. emits exactly one ("user_update", { userId })', async () => {
        h.resolveQuery = ({ table, calls }) => (
            table === 'users' && !hasUpdate(calls) ? { data: { role_id: 1 }, error: null } : { data: null, error: null }
        );
        await promoteUserToMember(42);
        const userUpdates = h.broadcasts.filter((b) => b.event === 'user_update');
        expect(userUpdates).toHaveLength(1);
        expect(userUpdates[0].payload).toEqual({ userId: 42 });
    });

    it('16. emits NOTHING when the role write fails (broadcast sits after handleSupabaseError)', async () => {
        // Ordering, not merely presence: a broadcast before the error check would tell
        // every client a promotion happened that did not.
        h.resolveQuery = ({ table, calls }) => {
            if (table !== 'users') return { data: null, error: null };
            return hasUpdate(calls)
                ? { data: null, error: { message: 'write failed' } }
                : { data: { role_id: 1 }, error: null };
        };
        await expect(promoteUserToMember(42)).rejects.toThrow(/Failed to promote user/);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('17. emits NOTHING when the target user does not exist', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await expect(promoteUserToMember(999)).rejects.toThrow(/User not found/);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('17b. emits NOTHING when the Member system role is unresolvable', async () => {
        h.sysRoles = { client: { id: 1, name: 'Client' } };
        h.resolveQuery = ({ table, calls }) => (
            table === 'users' && !hasUpdate(calls) ? { data: { role_id: 1 }, error: null } : { data: null, error: null }
        );
        await expect(promoteUserToMember(42)).rejects.toThrow(/Member role not found/);
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('duty_update — rule 4: ids only, never content', () => {
    it('18. toggleUserDutyStatus emits exactly { userId } — `status` is NOT on the wire', async () => {
        h.resolveQuery = ({ table, calls }) => (
            table === 'users' && !hasUpdate(calls) ? { data: { is_duty: false }, error: null } : { data: null, error: null }
        );
        await toggleUserDutyStatus(42);
        const duty = h.broadcasts.filter((b) => b.event === 'duty_update');
        expect(duty).toHaveLength(1);
        expect(duty[0].payload).toEqual({ userId: 42 });
        // The whole point: a per-user STATE VALUE must not ride the base channel, where
        // every authenticated receiver sees it with no permission gate.
        expect('status' in duty[0].payload).toBe(false);
        expect(JSON.stringify(duty[0].payload)).not.toContain('status');
    });

    it('18b. the same payload shape when the flip is ON duty (the user_presence upsert leg)', async () => {
        h.resolveQuery = ({ table, calls }) => (
            table === 'users' && !hasUpdate(calls) ? { data: { is_duty: true }, error: null } : { data: null, error: null }
        );
        await toggleUserDutyStatus(7);
        const duty = h.broadcasts.filter((b) => b.event === 'duty_update');
        expect(duty).toHaveLength(1);
        expect(duty[0].payload).toEqual({ userId: 7 });
    });

    it('19. emits nothing when the target row is absent (the silent no-op branch)', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await toggleUserDutyStatus(999);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('AC-T5. cleanupInactiveDutyUsers still emits exactly { cleanup: true }', async () => {
        // A SWEEP DISCRIMINATOR — it names which event happened and carries no user's
        // state — so it is permitted where `status` was not. Pinned so the ratchet
        // covers BOTH duty_update emitters: forcing this one down to ids would be a
        // change with no security gain, and dropping it would silently stop the sweep
        // from reaching any client.
        h.resolveQuery = ({ table }) => {
            if (table === 'user_presence') return { data: [{ user_id: 3 }], error: null };
            if (table === 'users') return { data: [{ id: 3, name: 'Stale' }], error: null };
            return { data: null, error: null };
        };
        const cleaned = await cleanupInactiveDutyUsers();
        expect(cleaned).toHaveLength(1);
        const duty = h.broadcasts.filter((b) => b.event === 'duty_update');
        expect(duty).toHaveLength(1);
        expect(duty[0].payload).toEqual({ cleanup: true });
    });

    it('AC-T5b. the sweep emits nothing when it cleared nobody', async () => {
        h.resolveQuery = ({ table }) => (
            table === 'user_presence' ? { data: [], error: null } : { data: null, error: null }
        );
        await cleanupInactiveDutyUsers();
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('AC-T6 — bulk promotion must not fan out one broadcast per user', () => {
    // SOURCE-TEXT RATCHET, declared as such. Driving bulkPromoteUsersToMember
    // behaviourally would require standing up assertCanAssignRole + roleTier +
    // assertCanChangeUsersRole against the stub, which pins those guards rather than
    // the emit contract this test is about. The property that actually matters is
    // structural: the bulk path must keep its OWN single aggregate emit and must not
    // delegate to the per-user path.
    const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'users.ts'), 'utf8');
    const bulkBody = (() => {
        const start = src.indexOf('export async function bulkPromoteUsersToMember');
        expect(start).toBeGreaterThan(-1);
        // Column-0 closing brace. CRLF-tolerant on purpose — this repo is developed on
        // Windows and an `indexOf('\n}\n')` silently over-reads the whole rest of the
        // file there, which makes the ratchet pass or fail for the wrong reason.
        const end = src.slice(start).search(/\r?\n\}\r?\n/);
        expect(end).toBeGreaterThan(-1);
        return src.slice(start, start + end);
    })();

    it('AC-T6. bulkPromoteUsersToMember does NOT route through promoteUserToMember', async () => {
        // Routing bulk through the single path would emit N user_update broadcasts to
        // every connected client for one admin action.
        expect(bulkBody).not.toContain('promoteUserToMember(');
    });

    it('AC-T6b. it emits ONE aggregate user_update carrying the updated ids', async () => {
        const emits = bulkBody.match(/broadcastToOrg\(/g) || [];
        expect(emits).toHaveLength(1);
        expect(bulkBody).toContain("broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds })");
    });
});
