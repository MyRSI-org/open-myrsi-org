import { describe, it, expect, vi, beforeEach } from 'vitest';

// THE POOL WAS UNBOUNDED.
//
// Two static topics ('db-changes', 'auth-alerts') plus `op-board-<uuid>`, minted per operation
// by lib/db/ops.ts boardChannelName. Nothing ever removed a pooled channel except the error
// path, so a long-running server accumulated one permanently-subscribed websocket topic for
// every operation board anyone had ever opened — for the life of the process.
//
// The eviction has two traps that a naive implementation walks straight into, and both are
// pinned below: comparing the EVICTABLE subset against the cap instead of the dynamic total
// (a pool that is busy sheds nothing and grows anyway), and incrementing the in-flight counter
// after the first `await` (a concurrent broadcast can evict the channel you are about to send
// on, in that window).

const h = vi.hoisted(() => ({
    subscribed: [] as string[],
    removed: [] as string[],
    sends: [] as Array<{ topic: string; event: string }>,
    sendGate: null as null | (() => Promise<void>),
}));

vi.mock('../lib/supabaseServer', () => {
    const channel = (topic: string) => ({
        topic,
        subscribe: (cb: (s: string) => void) => { h.subscribed.push(topic); cb('SUBSCRIBED'); return undefined; },
        send: async (msg: { event: string }) => {
            if (h.sendGate) await h.sendGate();
            h.sends.push({ topic, event: msg.event });
            return 'ok';
        },
    });
    return {
        supabase: {
            channel: (topic: string) => channel(topic),
            removeChannel: async (c: { topic: string }) => { h.removed.push(c.topic); return 'ok'; },
            realtime: { setAuth: () => undefined },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    };
});
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {} }, TTL: {} }));

import {
    broadcastToChannel,
    __channelPoolStateForTest,
    __resetChannelPoolForTest,
    __MAX_DYNAMIC_CHANNELS_FOR_TEST as CAP,
} from '../lib/db/common';

const board = (n: number) => `op-board-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

beforeEach(async () => {
    await __resetChannelPoolForTest();
    h.subscribed = []; h.removed = []; h.sends = []; h.sendGate = null;
});

describe('the dynamic channel pool is bounded', () => {
    it('reuses a pooled channel instead of resubscribing per broadcast', async () => {
        for (let i = 0; i < 5; i++) await broadcastToChannel('db-changes', 'e', {});
        expect(h.subscribed.filter((t) => t === 'db-changes')).toHaveLength(1);
        expect(h.sends).toHaveLength(5);
    });

    it('stops growing at the cap however many boards are touched', async () => {
        for (let i = 0; i < CAP + 25; i++) await broadcastToChannel(board(i), 'e', {});
        const state = __channelPoolStateForTest();
        expect(state.dynamic).toBeLessThanOrEqual(CAP);
        expect(h.removed.length).toBeGreaterThanOrEqual(25);
    });

    it('evicts the LEAST-RECENTLY-USED board, not an arbitrary one', async () => {
        for (let i = 0; i < CAP; i++) await broadcastToChannel(board(i), 'e', {});
        // Touch the oldest so it is no longer the LRU, then force one eviction.
        await broadcastToChannel(board(0), 'e', {});
        await broadcastToChannel(board(CAP + 1), 'e', {});

        expect(h.removed).toContain(board(1));      // now the oldest
        expect(h.removed).not.toContain(board(0));  // refreshed
    });

    it('NEVER evicts the pinned org topics, however much churn there is', async () => {
        await broadcastToChannel('db-changes', 'e', {});
        await broadcastToChannel('auth-alerts', 'e', {});
        for (let i = 0; i < CAP * 2; i++) await broadcastToChannel(board(i), 'e', {});

        expect(h.removed).not.toContain('db-changes');
        expect(h.removed).not.toContain('auth-alerts');
        expect(__channelPoolStateForTest().names).toContain('db-changes');
        expect(__channelPoolStateForTest().names).toContain('auth-alerts');
    });

    it('counts the DYNAMIC TOTAL against the cap, so pinned topics do not consume the budget', async () => {
        await broadcastToChannel('db-changes', 'e', {});
        await broadcastToChannel('auth-alerts', 'e', {});
        for (let i = 0; i < CAP; i++) await broadcastToChannel(board(i), 'e', {});
        // Exactly CAP dynamic channels plus the two pinned — nothing shed yet.
        expect(__channelPoolStateForTest().dynamic).toBe(CAP);
        expect(h.removed).toEqual([]);
    });
});

describe('eviction never races a send in flight', () => {
    it('does not evict a channel that is mid-send', async () => {
        // Fill the pool, then park ONE board mid-send and drive enough new boards through to
        // trigger eviction. The parked channel must survive: evicting it would tear down the
        // subscription underneath a broadcast that has already started.
        for (let i = 0; i < CAP; i++) await broadcastToChannel(board(i), 'e', {});

        let release: () => void = () => {};
        h.sendGate = () => new Promise<void>((r) => { release = r; });
        const parked = broadcastToChannel(board(0), 'parked', {});
        await Promise.resolve();

        h.sendGate = null;
        for (let i = CAP; i < CAP + 10; i++) await broadcastToChannel(board(i), 'e', {});

        expect(h.removed).not.toContain(board(0));
        release();
        await parked;
    });

    it('a pool where everything is busy sheds nothing rather than evicting a live channel', async () => {
        const releases: Array<() => void> = [];
        h.sendGate = () => new Promise<void>((r) => { releases.push(r); });
        const inFlight = Array.from({ length: CAP + 5 }, (_, i) => broadcastToChannel(board(i), 'e', {}));
        await Promise.resolve();

        // Over cap, but nothing is safe to drop. The residue is bounded by CONCURRENCY, not
        // by history — which is the property that matters; the old pool was bounded by neither.
        expect(h.removed).toEqual([]);
        releases.forEach((r) => r());
        h.sendGate = null;
        await Promise.all(inFlight);
    });
});

describe('teardown and failure handling', () => {
    it('awaits removeChannel so a failed teardown is not left in flight', async () => {
        for (let i = 0; i < CAP + 1; i++) await broadcastToChannel(board(i), 'e', {});
        expect(h.removed.length).toBeGreaterThan(0);
    });

    it('drops the channel when a send throws, so the next broadcast reconnects', async () => {
        await broadcastToChannel(board(1), 'e', {});
        h.sendGate = () => Promise.reject(new Error('socket closed'));
        await broadcastToChannel(board(1), 'e', {});   // must not throw out
        expect(h.removed).toContain(board(1));

        h.sendGate = null;
        await broadcastToChannel(board(1), 'e', {});
        expect(h.subscribed.filter((t) => t === board(1))).toHaveLength(2);
    });

    it('a send failure never propagates to the caller — a broadcast is best-effort', async () => {
        h.sendGate = () => Promise.reject(new Error('socket closed'));
        await expect(broadcastToChannel('db-changes', 'e', {})).resolves.toBeUndefined();
    });
});
