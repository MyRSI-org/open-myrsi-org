import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/common.ts — the shared data-layer primitives every lib/db module leans on:
//   - broadcastToOrg / broadcastToChannel over a pooled set of PRIVATE realtime channels
//     (Security rule 4: every broadcast channel is private, authorised server-side with the
//     service-role key, never a fallback literal);
//   - safeFetch, the read wrapper whose contract is "any read failure → the caller's
//     fallback" (fail-closed: callers pass [] / null, so an outage shows nothing rather
//     than crashing or leaking);
//   - getSystemRoles / getSystemRolesUncached query shape and null-tolerance.
// The pool-eviction cap and the Admin-slot election rules are pinned in
// tests/broadcastChannelPool.test.ts and tests/adminIdentity.test.ts; this suite covers
// the remaining behaviour.

const h = vi.hoisted(() => {
    type Call = { m: string; a: unknown[] };
    type Q = { table: string; calls: Call[] };
    const logger = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        child: () => logger,
    };
    const state = {
        // realtime
        setAuth: vi.fn<(k: string) => void>(),
        channels: [] as Array<{ topic: string; opts: unknown }>,
        subscribeStatus: 'SUBSCRIBED' as string | null,
        sendImpl: (async () => 'ok') as (msg: unknown) => Promise<unknown>,
        sends: [] as Array<{ topic: string; msg: unknown }>,
        removed: [] as string[],
        removeImpl: (async () => 'ok') as () => Promise<unknown>,
        // postgrest
        queries: [] as Q[],
        respond: ((_q: Q) => ({ data: null, error: null })) as (q: Q) => unknown,
    };
    function from(table: string) {
        const q: Q = { table, calls: [] };
        state.queries.push(q);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'in', 'is']) {
            b[m] = (...a: unknown[]) => { q.calls.push({ m, a }); return b; };
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve().then(() => state.respond(q)).then(res, rej);
        return b;
    }
    const supabase = {
        from,
        channel: (topic: string, opts: unknown) => {
            state.channels.push({ topic, opts });
            return {
                topic,
                subscribe: (cb: (s: string) => void) => {
                    if (state.subscribeStatus) cb(state.subscribeStatus);
                    return undefined;
                },
                send: async (msg: unknown) => {
                    const r = await state.sendImpl(msg);
                    state.sends.push({ topic, msg });
                    return r;
                },
            };
        },
        removeChannel: async (c: { topic: string }) => { state.removed.push(c.topic); return state.removeImpl(); },
        realtime: { setAuth: (k: string) => state.setAuth(k) },
    };
    return { state, logger, supabase };
});

vi.mock('../lib/supabaseServer', () => ({
    supabase: h.supabase,
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
}));
vi.mock('../lib/log', () => ({ log: h.logger }));

import {
    broadcastToOrg, broadcastToChannel, safeFetch, getSystemRoles, getSystemRolesUncached,
    __resetChannelPoolForTest, __channelPoolStateForTest,
} from '../lib/db/common';
import { cache } from '../lib/cache';

const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

beforeEach(async () => {
    await __resetChannelPoolForTest();
    h.state.setAuth = vi.fn<(k: string) => void>();
    h.state.channels = [];
    h.state.subscribeStatus = 'SUBSCRIBED';
    h.state.sendImpl = async () => 'ok';
    h.state.sends = [];
    h.state.removed = [];
    h.state.removeImpl = async () => 'ok';
    h.state.queries = [];
    h.state.respond = () => ({ data: null, error: null });
    h.logger.info.mockClear(); h.logger.warn.mockClear(); h.logger.error.mockClear();
    cache.invalidate('system_roles');
});

afterEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('broadcastToOrg', () => {
    it('sends the event on the single-org db-changes topic', async () => {
        await broadcastToOrg('settings_update', { id: 'abc' });
        expect(h.state.sends).toEqual([
            { topic: 'db-changes', msg: { type: 'broadcast', event: 'settings_update', payload: { id: 'abc' } } },
        ]);
    });

    it('defaults the payload to an empty object (ids-only contract: no content)', async () => {
        await broadcastToOrg('ping');
        expect(h.state.sends[0].msg).toEqual({ type: 'broadcast', event: 'ping', payload: {} });
    });

    it('broadcastToChannel defaults its payload to an empty object too', async () => {
        await broadcastToChannel('auth-alerts', 'force_logout');
        expect(h.state.sends).toEqual([
            { topic: 'auth-alerts', msg: { type: 'broadcast', event: 'force_logout', payload: {} } },
        ]);
    });
});

// ---------------------------------------------------------------------------
describe('channel creation is always PRIVATE (Security rule 4)', () => {
    it('creates each pooled channel with config.private = true', async () => {
        await broadcastToChannel('db-changes', 'e', {});
        await broadcastToChannel('op-board-1', 'e', {});
        expect(h.state.channels).toEqual([
            { topic: 'db-changes', opts: { config: { private: true } } },
            { topic: 'op-board-1', opts: { config: { private: true } } },
        ]);
    });
});

// ---------------------------------------------------------------------------
describe('server realtime authorisation (module-level, so each test loads a fresh copy)', () => {
    async function freshCommon() {
        vi.resetModules();
        return import('../lib/db/common');
    }

    it('authorises the realtime socket with the service-role key exactly once', async () => {
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-role-jwt';
        const mod = await freshCommon();
        await mod.broadcastToChannel('t-1', 'e', {});
        await mod.broadcastToChannel('t-2', 'e', {});
        expect(h.state.setAuth).toHaveBeenCalledTimes(1);
        expect(h.state.setAuth).toHaveBeenCalledWith('svc-role-jwt');
        await mod.__resetChannelPoolForTest();
    });

    it('never sets auth with a fallback literal when the key is absent', async () => {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        const mod = await freshCommon();
        await mod.broadcastToChannel('t-1', 'e', {});
        expect(h.state.setAuth).not.toHaveBeenCalled();
        // ...and the send still happens on the channel.
        expect(h.state.sends.map((s) => s.topic)).toEqual(['t-1']);
        await mod.__resetChannelPoolForTest();
    });

    it('a throwing setAuth is logged and re-armed, so the next new channel retries it', async () => {
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-role-jwt';
        h.state.setAuth = vi.fn<(k: string) => void>(() => { throw new Error('socket not ready'); });
        const mod = await freshCommon();
        await mod.broadcastToChannel('t-1', 'e', {});
        expect(h.logger.warn).toHaveBeenCalledWith('failed to set server realtime auth', { err: expect.any(Error) });
        // The broadcast itself still went out.
        expect(h.state.sends.map((s) => s.topic)).toEqual(['t-1']);

        h.state.setAuth = vi.fn<(k: string) => void>();
        await mod.broadcastToChannel('t-2', 'e', {});
        expect(h.state.setAuth).toHaveBeenCalledWith('svc-role-jwt');
        await mod.__resetChannelPoolForTest();
    });
});

// ---------------------------------------------------------------------------
describe('channel readiness', () => {
    it('a channel that never reports SUBSCRIBED still sends after the 5s timeout', async () => {
        vi.useFakeTimers();
        h.state.subscribeStatus = 'CHANNEL_ERROR';
        let done = false;
        const p = broadcastToChannel('slow-topic', 'evt', { id: 1 }).then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(4999);
        expect(done).toBe(false);
        expect(h.state.sends).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(done).toBe(true);
        expect(h.state.sends.map((s) => s.topic)).toEqual(['slow-topic']);
    });
});

// ---------------------------------------------------------------------------
describe('send failure handling', () => {
    it('logs a failed send, drops the stale channel, and recreates it on next use', async () => {
        h.state.sendImpl = async () => { throw new Error('socket closed'); };
        await expect(broadcastToChannel('op-board-x', 'board_update', { id: 'op1' })).resolves.toBeUndefined();
        expect(h.logger.warn).toHaveBeenCalledWith('broadcast send failed', {
            event: 'board_update', channelName: 'op-board-x', err: expect.any(Error),
        });
        expect(h.state.removed).toEqual(['op-board-x']);
        expect(__channelPoolStateForTest().names).not.toContain('op-board-x');

        h.state.sendImpl = async () => 'ok';
        await broadcastToChannel('op-board-x', 'board_update', { id: 'op1' });
        // A brand-new subscription, not the dropped one.
        expect(h.state.channels.filter((c) => c.topic === 'op-board-x')).toHaveLength(2);
        expect(h.state.sends.map((s) => s.topic)).toEqual(['op-board-x']);
    });

    it('a failing removeChannel during the drop is logged, and the pool entry is still gone', async () => {
        h.state.sendImpl = async () => { throw new Error('socket closed'); };
        h.state.removeImpl = async () => { throw new Error('unsubscribe timeout'); };
        await broadcastToChannel('op-board-y', 'e', {});
        expect(h.logger.warn).toHaveBeenCalledWith('channel removal failed', {
            channelName: 'op-board-y', err: expect.any(Error),
        });
        expect(__channelPoolStateForTest().names).not.toContain('op-board-y');
    });

    it('two concurrent failed sends on one topic tear it down exactly once', async () => {
        h.state.sendImpl = async () => { throw new Error('socket closed'); };
        await Promise.all([
            broadcastToChannel('op-board-z', 'a', {}),
            broadcastToChannel('op-board-z', 'b', {}),
        ]);
        expect(h.state.removed).toEqual(['op-board-z']);
        expect(h.logger.warn.mock.calls.filter((c) => c[0] === 'broadcast send failed')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
describe('safeFetch — any read failure resolves to the caller fallback', () => {
    const FALLBACK = ['fallback'];

    it('returns the data on success, without logging', async () => {
        const out = await safeFetch(Promise.resolve({ data: ['row'], error: null }), FALLBACK, 'target');
        expect(out).toEqual(['row']);
        expect(h.logger.warn).not.toHaveBeenCalled();
        expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('returns null data verbatim when there is no error (callers must tolerate null)', async () => {
        const out = await safeFetch<string[] | null>(Promise.resolve({ data: null, error: null }), FALLBACK, 'target');
        expect(out).toBeNull();
    });

    it.each(['PGRST205', 'PGRST204', 'PGRST200', 'PGRST201', '42P01'])(
        'schema-drift code %s → fallback with a warn carrying the full error shape',
        async (code) => {
            const out = await safeFetch(
                Promise.resolve({ data: null, error: { code, message: 'relation missing', hint: 'h', details: 'd' } }),
                FALLBACK, 'ops.list',
            );
            expect(out).toBe(FALLBACK);
            expect(h.logger.warn).toHaveBeenCalledWith('safeFetch returning fallback', {
                target: 'ops.list', code, errMessage: 'relation missing', hint: 'h', details: 'd',
            });
            expect(h.logger.error).not.toHaveBeenCalled();
        },
    );

    it('blank hint/details are normalised to empty strings in the warn', async () => {
        await safeFetch(Promise.resolve({ data: null, error: { code: '42P01', message: 'm' } }), FALLBACK, 't');
        expect(h.logger.warn).toHaveBeenCalledWith('safeFetch returning fallback', {
            target: 't', code: '42P01', errMessage: 'm', hint: '', details: '',
        });
    });

    it('any other DB error is logged in full and STILL resolves to the fallback (never a partial row set)', async () => {
        const out = await safeFetch(
            Promise.resolve({ data: ['partial'], error: { code: '57014', message: 'statement timeout' } }),
            FALLBACK, 'intel.list',
        );
        expect(out).toBe(FALLBACK);
        expect(h.logger.error).toHaveBeenCalledWith('safeFetch DB error', {
            target: 'intel.list', code: '57014', errMessage: 'statement timeout', hint: '', details: '',
        });
        // The handleSupabaseError rethrow is caught by safeFetch's own guard.
        expect(h.logger.error).toHaveBeenCalledWith('safeFetch fatal', {
            target: 'intel.list', err: expect.objectContaining({ message: 'intel.list' }),
        });
    });

    it('a rejected query promise resolves to the fallback and is logged as fatal', async () => {
        const boom = new Error('network down');
        const out = await safeFetch(Promise.reject(boom), FALLBACK, 'hr.list');
        expect(out).toBe(FALLBACK);
        expect(h.logger.error).toHaveBeenCalledWith('safeFetch fatal', { target: 'hr.list', err: boom });
    });
});

// ---------------------------------------------------------------------------
describe('getSystemRoles query shape', () => {
    const SEEDED = [
        { id: 1, name: 'Client', is_system: true },
        { id: 2, name: 'Member', is_system: true },
        { id: 3, name: 'Dispatcher', is_system: true },
        { id: 4, name: 'Admin', is_system: true },
    ];

    it('reads only id/name/is_system from the is_system set, ordered by id', async () => {
        h.state.respond = () => ({ data: SEEDED, error: null });
        const roles = await getSystemRoles();
        expect(h.state.queries).toHaveLength(1);
        expect(h.state.queries[0]).toEqual({
            table: 'roles',
            calls: [
                { m: 'select', a: ['id, name, is_system'] },
                { m: 'eq', a: ['is_system', true] },
                { m: 'order', a: ['id', { ascending: true }] },
            ],
        });
        expect(roles.admin).toEqual(SEEDED[3]);
        expect(roles.client).toEqual(SEEDED[0]);
    });

    it('falls back to an id/name read over every role when the flagged set is incomplete', async () => {
        h.state.respond = (q) => {
            const flagged = q.calls.some((c) => c.m === 'eq');
            return { data: flagged ? SEEDED.slice(0, 2) : SEEDED.map(({ id, name }) => ({ id, name })), error: null };
        };
        const roles = await getSystemRolesUncached();
        expect(h.state.queries).toHaveLength(2);
        expect(h.state.queries[1]).toEqual({
            table: 'roles',
            calls: [
                { m: 'select', a: ['id, name'] },
                { m: 'order', a: ['id', { ascending: true }] },
            ],
        });
        expect(roles.dispatcher).toEqual({ id: 3, name: 'Dispatcher' });
    });

    it('null data from both reads resolves every slot to undefined (deny) and is not cached', async () => {
        h.state.respond = () => ({ data: null, error: null });
        const roles = await getSystemRoles();
        expect(roles).toEqual({ client: undefined, member: undefined, dispatcher: undefined, admin: undefined });
        expect(cache.get('system_roles')).toBeUndefined();
    });

    it('tolerates a null role name in the case-insensitive pass without electing it', async () => {
        h.state.respond = () => ({
            data: [
                { id: 1, name: 'client' }, { id: 2, name: 'Member' }, { id: 3, name: 'Dispatcher' },
                { id: 4, name: null }, { id: 5, name: ' ADMIN ' },
            ],
            error: null,
        });
        const roles = await getSystemRolesUncached();
        expect(roles.client).toEqual({ id: 1, name: 'client' });
        expect(roles.admin).toEqual({ id: 5, name: ' ADMIN ' });
    });
});
