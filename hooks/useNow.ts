import { useState, useEffect } from 'react';

/**
 * Returns a wall-clock timestamp (`Date.now()`) that refreshes on a fixed
 * interval. This lets time-relative derivations (memos that classify items as
 * "overdue", "in the last 30 days", "upcoming", etc.) stay reactive — and
 * therefore pure under the React Compiler `react-hooks/purity` rule — instead
 * of reading `Date.now()` directly during render.
 *
 * The seed is sampled once via a lazy initializer (so the first render already
 * has a real timestamp), then the value advances every `intervalMs`. A consumer
 * memo that lists the returned value in its dependency array recomputes on each
 * tick as well as whenever its data dependencies change.
 *
 * @param intervalMs how often to re-sample the clock; defaults to 60s, which is
 *        the right granularity for minute-or-coarser relative-time windows.
 */
export function useNow(intervalMs: number = 60_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
}
