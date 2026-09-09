// The deployment's build id, derived from the built client shell.
//
// SERVER-ONLY. It reads from disk, so it must never reach the browser bundle — it is on
// eslint.config.js's no-restricted-imports list for client code alongside lib/abuseFilter.
//
// WHAT IT IS: a short hash of dist/index.html. That file references every entry chunk by its
// content hash, and Vite's hashes are deterministic, so its bytes change exactly when the client
// bundle changes. That is the right signal for "your open tab is running stale code, reload" —
// and it is deliberately NOT a process id: a crash-restart or a `docker restart` mints a new
// process but serves the same bundle, and nagging every user to reload after an unrelated
// restart is how a banner becomes noise.
//
// The corollary, stated so nobody reads it as a defect: a deploy that changes only `lib/`,
// `api/` or `server.ts` produces a byte-identical index.html and therefore an UNCHANGED build
// id. Correct — there is no stale client code for the user to reload away from.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null | undefined;
let indexPathOverride: string | null = null;

/** Test seam. The compiled server lives in dist-server/lib/, so the relative walk to dist/
 *  differs between the emitted tree and the source tree vitest loads — without this the
 *  success path is untestable and only the fail-safe null branch is ever exercised. */
export function __setIndexPathForTest(path: string | null): void {
    indexPathOverride = path;
    cached = undefined;
}

function resolveIndexPath(): string {
    if (indexPathOverride) return indexPathOverride;
    // dist-server/lib/buildId.js -> ../../dist/index.html
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.html');
}

/**
 * The current build id, or null when it cannot be determined (dev server, a build that has not
 * run, an unreadable file).
 *
 * LAZY and memoised on purpose. Computing it at module scope would run a filesystem read at
 * import time, which breaks any test that imports server.ts, and would crash the server outright
 * if dist/ were missing. Null is the fail-safe: no id means no header, which means the client
 * never nags. A missing build id must never become a permanent "please reload" banner.
 */
export function getBuildId(): string | null {
    if (cached !== undefined) return cached;
    try {
        const html = readFileSync(resolveIndexPath());
        cached = createHash('sha256').update(html).digest('hex').slice(0, 12);
    } catch {
        cached = null;
    }
    return cached;
}
