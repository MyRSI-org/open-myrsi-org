// Run async tasks strictly one at a time, with latest-wins collapsing.
//
// Written for the realtime channel rebuild, where two effects in the SAME React commit both
// trigger a rebuild: the tear-down half of the first one awaits, and the second then enters
// and reads the same not-yet-cleared cleanup reference. supabase-js dedupes channels by topic
// and lets `.on('broadcast', …)` re-attach silently to an already-subscribed channel, so the
// visible result is a channel carrying two copies of every broadcast binding — a duplicate
// toast and a duplicate sound for every request, status change and bulletin, for the life of
// the tab.
//
// Dependency-free on purpose: no imports at all, so it compiles under BOTH tsconfigs and can
// be imported from client code without tripping the ESLint server-module boundary. Same shape
// as lib/sliceMerge.ts and lib/sliceCoalescer.ts.

export type SerialRunner = (task: () => Promise<void>) => Promise<void>;

/**
 * Serialize `task` calls. While one runs, at most ONE follow-up is held and later calls
 * replace it — a rebuild is idempotent, so running a queue of them back to back is pure waste,
 * and the newest caller has the newest inputs.
 *
 * A throwing task is reported through `onError` and does NOT poison the chain. This matters
 * more than it looks: if a failure could leave the runner permanently "running", every later
 * call would be silently queued and dropped, and the channel would never be rebuilt again for
 * the life of the tab — strictly worse than the race being fixed, and invisible because every
 * caller invokes this as `void`. Hence the `finally`, and hence `onError` itself being
 * guarded: a throwing error handler must not be able to wedge the runner either.
 */
export function makeSerialRunner(onError: (err: unknown) => void): SerialRunner {
    let queued: (() => Promise<void>) | null = null;
    let tail: Promise<void> = Promise.resolve();
    let running = false;

    return (task) => {
        if (running) {
            queued = task;
            return tail;
        }
        running = true;
        tail = (async () => {
            try {
                let next: (() => Promise<void>) | null = task;
                while (next) {
                    const current = next;
                    next = null;
                    try {
                        await current();
                    } catch (err) {
                        try { onError(err); } catch { /* a broken reporter must not wedge the runner */ }
                    }
                    next = queued;
                    queued = null;
                }
            } finally {
                // UNCONDITIONAL. See the note above — this is the difference between "the race
                // comes back" and "realtime never reconnects again".
                running = false;
            }
        })();
        return tail;
    };
}
