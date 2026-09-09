// Client-side "a new version is available" detector.
//
// Every API response carries an X-Build-Id header. The first one seen becomes this tab's
// baseline; a DIFFERENT one means the server is now serving a bundle this tab is not running.
// No polling: the app already talks to the server constantly, so the signal rides traffic that
// happens anyway. That also means a tab sitting idle never asks — which is correct, because a
// tab nobody is using does not need to be told to reload.
//
// Dependency-free (no imports), so it compiles under both tsconfigs and is importable from
// client code. It IS emitted to dist-server as unused output; that is harmless, and its DOM-free
// implementation means the server build has nothing to trip over.

type Listener = (buildId: string) => void;

let baseline: string | null = null;
let stale = false;
const listeners = new Set<Listener>();

/**
 * Record the build id from a server response.
 *
 * LATCHES: once a mismatch is seen it stays seen. That stops the banner flapping during a
 * rolling deploy where requests land alternately on the old and new instance. It does NOT mean
 * one nag per user — a client that reloads onto the old instance can be told again, which is
 * the honest behaviour.
 *
 * Fail-safe in both directions: no header (null/empty) is a no-op, so an older server, a
 * proxy that strips the header, or a build with no id simply never nags.
 */
export function noteBuildId(buildId: string | null | undefined): void {
    if (!buildId) return;
    if (baseline === null) { baseline = buildId; return; }
    if (buildId === baseline || stale) return;
    stale = true;
    for (const l of listeners) {
        try { l(buildId); } catch { /* one bad subscriber must not block the others */ }
    }
}

/** Subscribe to the first detected update. Fires immediately if one was already seen (a view
 *  that mounts late must not miss the signal). Returns an unsubscribe function. */
export function onBuildUpdate(listener: Listener): () => void {
    listeners.add(listener);
    if (stale && baseline) {
        try { listener(baseline); } catch { /* ignore */ }
    }
    return () => { listeners.delete(listener); };
}

/** Test seam — the module holds process-wide state. */
export function __resetBuildUpdateForTest(): void {
    baseline = null;
    stale = false;
    listeners.clear();
}
