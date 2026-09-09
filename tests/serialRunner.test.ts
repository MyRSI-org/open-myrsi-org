import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSerialRunner } from '../lib/serialRunner';

// The realtime channel rebuild ran unserialized: two effects in the same React commit both
// triggered it, the first suspended on its async teardown, and the second entered and built a
// second channel over the top. supabase-js dedupes channels by topic and lets broadcast
// handlers re-attach silently after subscribe, so the steady state was a channel carrying two
// copies of every broadcast binding — a duplicate toast and a duplicate sound for every
// request, status change and bulletin, for the life of the tab. This is the assertion that
// would have caught it.

const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

describe('makeSerialRunner', () => {
    it('never runs two tasks at once, even when the second starts mid-await', async () => {
        const errors: unknown[] = [];
        const run = makeSerialRunner((e) => errors.push(e));
        let active = 0;
        let maxActive = 0;
        const gate = deferred();

        const task = (waitFor?: Promise<void>) => async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            if (waitFor) await waitFor;
            active--;
        };

        const first = run(task(gate.promise));  // suspends
        const second = run(task());             // enters while the first is suspended
        gate.resolve();
        await Promise.all([first, second]);

        expect(maxActive).toBe(1);
        expect(errors).toEqual([]);
    });

    it('collapses a burst to the LATEST queued task', async () => {
        const run = makeSerialRunner(() => {});
        const ran: string[] = [];
        const gate = deferred();

        const first = run(async () => { ran.push('a'); await gate.promise; });
        run(async () => { ran.push('b'); });
        run(async () => { ran.push('c'); });
        run(async () => { ran.push('d'); });
        gate.resolve();
        await first;
        await new Promise(r => setTimeout(r, 0));

        // A rebuild is idempotent, so running the whole queue is pure waste and the newest
        // caller has the newest inputs.
        expect(ran).toEqual(['a', 'd']);
    });

    // THE PIN THAT MATTERS MOST. If a failure could leave the runner permanently "running",
    // every later call would be queued and silently dropped, and the channel would never be
    // rebuilt again for the life of the tab — strictly worse than the race being fixed, and
    // invisible because every caller invokes this as `void`.
    it('keeps serializing after a task throws', async () => {
        const errors: unknown[] = [];
        const run = makeSerialRunner((e) => errors.push(e));
        const ran: string[] = [];

        await run(async () => { throw new Error('build failed'); });
        await run(async () => { ran.push('after'); });

        expect(errors).toHaveLength(1);
        expect(ran).toEqual(['after']);
    });

    it('keeps serializing even when the error reporter ITSELF throws', async () => {
        const run = makeSerialRunner(() => { throw new Error('reporter exploded'); });
        const ran: string[] = [];

        await run(async () => { throw new Error('build failed'); });
        await run(async () => { ran.push('after'); });

        expect(ran).toEqual(['after']);
    });

    it('a rejected task does not reject the returned promise', async () => {
        const run = makeSerialRunner(() => {});
        await expect(run(async () => { throw new Error('x'); })).resolves.toBeUndefined();
    });

    it('runs sequentially when calls do not overlap', async () => {
        const run = makeSerialRunner(() => {});
        const ran: number[] = [];
        await run(async () => { ran.push(1); });
        await run(async () => { ran.push(2); });
        await run(async () => { ran.push(3); });
        expect(ran).toEqual([1, 2, 3]);
    });
});

describe('DataCoreContext wiring — the serializer is actually on the rebuild path', () => {
    const src = readFileSync(join(process.cwd(), 'contexts', 'DataCoreContext.tsx'), 'utf8');

    it('routes the exported rebuild entry point through the queue', () => {
        expect(src).toContain('const notifyDbConnected = useCallback(() => rebuildQueue(buildChannel)');
    });

    // The ref is what the settings_update handler and the not-ready retry call — i.e. the most
    // common rebuild triggers. Pointed at buildChannel instead of the wrapper, the fix would be
    // inert on exactly those paths while looking correct everywhere else.
    it('points notifyDbConnectedRef at the SERIALIZED wrapper, not the raw builder', () => {
        expect(src).toContain('notifyDbConnectedRef.current = notifyDbConnected;');
        expect(src).not.toContain('notifyDbConnectedRef.current = buildChannel');
    });

    // A superseded build's subscribe callback must not write the shared connection refs. The
    // guard has to be the first statement: the stale-channel path is reached through CLOSED,
    // not SUBSCRIBED, so a guard inside the SUBSCRIBED branch protects nothing.
    it('guards the subscribe callback by build generation, before the status test', () => {
        const sub = src.slice(src.indexOf('channel.subscribe((status) => {'));
        const guardIdx = sub.indexOf('if (myGen !== buildGenRef.current) return;');
        const statusIdx = sub.indexOf("if (status === 'SUBSCRIBED')");
        expect(guardIdx).toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(statusIdx);
    });

    // Guarding cleanup would skip removeChannel for a superseded build, leaking the channel and
    // making the rebuild path's own `await cleanup()` a no-op — reintroducing the exact
    // joining-corpse hazard that await exists to prevent.
    it('does NOT generation-guard cleanup', () => {
        const cleanup = src.slice(src.indexOf('const cleanup = async () => {'));
        expect(cleanup.slice(0, 900)).not.toContain('buildGenRef');
        expect(cleanup.slice(0, 900)).toContain('await supabase.removeChannel(channel)');
    });

    // Both recovery paths must call the same function, or they drift — which is exactly how
    // they came to be two hand-written lists that agreed only by coincidence.
    it('has exactly one resync implementation, used by both recovery paths', () => {
        expect(src).toContain('if (wasDisconnected) resyncHotSubsets();');
        const visibility = src.slice(src.indexOf('Tab visible after'));
        expect(visibility.slice(0, 400)).toContain('resyncHotSubsets();');
        // The old duplicated list must not creep back in.
        expect(src).not.toContain("permissionsRef.current.has('operations:view')");
    });

    // Without this, every rebuild looks like a reconnect (cleanup clears the connected ref), so
    // the widened resync would fire on every settings save, permission change and duty toggle.
    it('does not treat a deliberate teardown as a reconnect', () => {
        expect(src).toContain('deliberateTeardownRef.current = true;');
        expect(src).toContain('deliberateTeardownRef.current === false');
    });
});
