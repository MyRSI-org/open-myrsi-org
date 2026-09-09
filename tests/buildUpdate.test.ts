import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { noteBuildId, onBuildUpdate, __resetBuildUpdateForTest } from '../lib/buildUpdate';
import { getBuildId, __setIndexPathForTest } from '../lib/buildId';

// A redeploy used to reach users as a red "System Critical" screen: the open tab asked for a
// chunk whose hashed filename no longer existed, and every recovery path in the app was dead
// code (see the note in index.tsx). These pin the replacement — notice the new build from
// traffic the app already makes, and offer a reload instead of crashing.

beforeEach(() => __resetBuildUpdateForTest());

describe('buildUpdate — noticing a new deployment', () => {
    it('does not fire on the FIRST id seen — that is just the baseline', () => {
        const seen: string[] = [];
        onBuildUpdate(id => seen.push(id));
        noteBuildId('aaaa');
        expect(seen).toEqual([]);
    });

    it('fires once when the id changes', () => {
        const seen: string[] = [];
        onBuildUpdate(id => seen.push(id));
        noteBuildId('aaaa');
        noteBuildId('bbbb');
        expect(seen).toEqual(['bbbb']);
    });

    // A rolling deploy serves old and new instances simultaneously, so ids alternate. Without
    // the latch the banner would appear, vanish and reappear on every other request.
    it('latches — it does not flap while a rolling deploy alternates ids', () => {
        const seen: string[] = [];
        onBuildUpdate(id => seen.push(id));
        noteBuildId('aaaa');
        noteBuildId('bbbb');
        noteBuildId('aaaa');
        noteBuildId('bbbb');
        expect(seen).toEqual(['bbbb']);
    });

    // FAIL-SAFE, and the property that matters most: a missing header must never become a
    // permanent "please reload" nag. An older server, a proxy that strips the header, or a
    // build with no id all land here.
    it('is a no-op for a missing or empty build id', () => {
        const seen: string[] = [];
        onBuildUpdate(id => seen.push(id));
        noteBuildId(null);
        noteBuildId(undefined);
        noteBuildId('');
        noteBuildId('aaaa');
        noteBuildId(null);
        expect(seen).toEqual([]);
    });

    it('notifies a subscriber that mounts AFTER the update was detected', () => {
        noteBuildId('aaaa');
        noteBuildId('bbbb');
        const seen: string[] = [];
        onBuildUpdate(id => seen.push(id));
        expect(seen).toHaveLength(1);
    });

    it('a throwing subscriber does not block the others', () => {
        const seen: string[] = [];
        onBuildUpdate(() => { throw new Error('bad subscriber'); });
        onBuildUpdate(id => seen.push(id));
        noteBuildId('aaaa');
        noteBuildId('bbbb');
        expect(seen).toEqual(['bbbb']);
    });

    it('unsubscribes', () => {
        const seen: string[] = [];
        const off = onBuildUpdate(id => seen.push(id));
        off();
        noteBuildId('aaaa');
        noteBuildId('bbbb');
        expect(seen).toEqual([]);
    });
});

describe('buildId — derived from the built client shell', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildid-')); });
    afterEach(() => { __setIndexPathForTest(null); rmSync(dir, { recursive: true, force: true }); });

    it('is stable for identical content and different for changed content', () => {
        const p = join(dir, 'index.html');
        writeFileSync(p, '<script src="/assets/index-AAAA.js"></script>');
        __setIndexPathForTest(p);
        const first = getBuildId();
        expect(first).toBeTruthy();

        // Same bytes -> same id (memoised, and the hash agrees).
        __setIndexPathForTest(p);
        expect(getBuildId()).toBe(first);

        writeFileSync(p, '<script src="/assets/index-BBBB.js"></script>');
        __setIndexPathForTest(p);
        expect(getBuildId()).not.toBe(first);
    });

    // FAIL-SAFE: null means no header, which means the client never nags. A dev server or a
    // tree with no build must not produce a permanent reload prompt.
    it('returns null when the built shell is absent, and never throws', () => {
        __setIndexPathForTest(join(dir, 'does-not-exist.html'));
        expect(getBuildId()).toBeNull();
    });

    // It is called on every browser-bound API response, so it must not stat the filesystem
    // each time. Proven by changing the file underneath it without resetting the cache.
    it('memoises after the first read', () => {
        const p = join(dir, 'index.html');
        writeFileSync(p, 'first');
        __setIndexPathForTest(p);
        const first = getBuildId();
        writeFileSync(p, 'second — a different build entirely');
        expect(getBuildId()).toBe(first);
    });

    // Memoising the FAILURE matters just as much: a server that started before the build
    // finished must not re-read a missing file on every request for the life of the process.
    it('memoises the null result too', () => {
        __setIndexPathForTest(join(dir, 'missing.html'));
        expect(getBuildId()).toBeNull();
        writeFileSync(join(dir, 'missing.html'), 'appeared later');
        expect(getBuildId()).toBeNull();
    });
});

describe('index.tsx — the preventDefault that made every recovery path dead code', () => {
    const src = readFileSync(join(process.cwd(), 'index.tsx'), 'utf8');

    // Vite's helper is `window.dispatchEvent(e); if (!e.defaultPrevented) throw err;` — so
    // preventing the default made a failed dynamic import RESOLVE with undefined instead of
    // rejecting. Nothing downstream could see a failure: neither lazyWithRetry ladder fired,
    // pwa-init.js's unhandledrejection recovery never fired, and React then read `.default` off
    // undefined and threw a TypeError, which is the red screen the user actually saw.
    it('does not suppress vite:preloadError', () => {
        // Comments stripped FIRST. The code now carries a long note explaining this very
        // hazard, and that note names the call — so a naive `expect(src).not.toContain(...)`
        // matches its own explanation and can never go green. Same class of bug as a ratchet
        // that matches the comment above the code it is meant to pin.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .filter(line => !line.trim().startsWith('//'))
            .join('\n');
        expect(code).not.toContain('preventDefault');
        expect(code).not.toContain('vite:preloadError');
    });
});

describe('DashboardApp — the one-shot chunk reload guard is per view', () => {
    const src = readFileSync(join(process.cwd(), 'DashboardApp.tsx'), 'utf8');

    // There is no router — navigation is activeView state — so location.pathname is '/' for
    // every view. Keying the guard on it made a single force-reload disable the guard for all
    // 37 lazy views for the rest of the browser session.
    it('does not key the reload guard on location.pathname', () => {
        expect(src).not.toContain("'chunk-reload-' + location.pathname");
        expect(src).toContain("'chunk-reload-' + key");
    });
});
