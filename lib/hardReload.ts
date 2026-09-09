// Unregister service workers, drop every Cache Storage entry, and reload.
//
// The one recovery sequence that actually clears a stale deploy: a plain location.reload() can
// be answered by the service worker from its own cache, so the user reloads into the same
// broken build. Two semantically identical copies of this lived in the two ErrorBoundary
// components with different local identifiers; the update banner needed the same sequence and
// would have made a third.
//
// Deliberately dependency-free (no imports at all), so it compiles under both tsconfigs and can
// be imported from client code without tripping the ESLint server-module boundary — same shape
// as lib/sliceMerge.ts and lib/serialRunner.ts.

/**
 * Best effort by design: every step is optional and failure is swallowed, because the reload
 * itself is the point. `location.replace` rather than `reload` so the broken page does not stay
 * in the back-forward history.
 */
export async function hardReload(): Promise<void> {
    try {
        if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
    } catch { /* no SW, or blocked — carry on to the caches */ }
    try {
        if (typeof caches !== 'undefined') {
            const names = await caches.keys();
            await Promise.all(names.map(n => caches.delete(n)));
        }
    } catch { /* Cache Storage unavailable (private mode, blocked site data) */ }
    try {
        window.location.replace(window.location.href);
    } catch {
        window.location.reload();
    }
}
