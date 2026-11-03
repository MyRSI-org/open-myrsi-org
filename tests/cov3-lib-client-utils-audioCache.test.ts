import { describe, it, expect, vi, afterEach } from 'vitest';

// lib/audioCache.ts — prefetch + replay cache for UI chimes and org-configured sounds.
// HTMLAudioElement is doubled; the module keeps a module-level Map and schedules a
// boot-time warm-up on import, so every test re-imports a fresh copy (vi.resetModules).
// Pinned:
//   * boot warm-up of exactly the three bundled chimes, via requestIdleCallback (1s timeout)
//     or a 0ms timeout — never synchronously, never playing (autoplay policy);
//   * prefetch: preload='auto' BEFORE src, load() AFTER src, idempotent per URL, a failure
//     is warned and NOT cached (so it is retried);
//   * play: always plays a CLONE (overlapping chimes don't cut each other off), never the
//     cached node; volume 0–100 is clamped to 0–1; a cold or uncacheable URL still plays;
//   * playback rejection (autoplay block) and synchronous errors are logged, never thrown.

const BUNDLED = ['/media/success-chime.mp3', '/media/error-chime.mp3', '/media/dialog-action-chime.mp3'];
const URL_A = 'https://cdn.example.org/sounds/alert.mp3';
const URL_B = 'https://cdn.example.org/sounds/eam.mp3';

class FakeAudio {
    static instances: FakeAudio[] = [];
    static clones: FakeAudio[] = [];
    static ctorError: Error | null = null;
    static loadError: Error | null = null;
    static playImpl: () => unknown = () => Promise.resolve();

    ctorArg: string | undefined;
    order: string[] = [];
    volume = 1;
    private _src = '';
    private _preload = '';
    load = vi.fn(() => {
        this.order.push('load');
        if (FakeAudio.loadError) throw FakeAudio.loadError;
    });
    play = vi.fn(() => FakeAudio.playImpl());
    cloneNode = vi.fn((deep?: boolean) => {
        void deep;
        const c = new FakeAudio(undefined, true);
        c._src = this._src;
        c._preload = this._preload;
        FakeAudio.clones.push(c);
        return c;
    });

    constructor(url?: string, isClone = false) {
        if (isClone) return;
        if (FakeAudio.ctorError) throw FakeAudio.ctorError;
        this.ctorArg = url;
        if (url) this._src = url;
        FakeAudio.instances.push(this);
    }

    get src() { return this._src; }
    set src(v: string) { this.order.push('src'); this._src = v; }
    get preload() { return this._preload; }
    set preload(v: string) { this.order.push('preload'); this._preload = v; }

    static reset() {
        FakeAudio.instances = [];
        FakeAudio.clones = [];
        FakeAudio.ctorError = null;
        FakeAudio.loadError = null;
        FakeAudio.playImpl = () => Promise.resolve();
    }
}

/** Fresh module copy. requestIdleCallback is captured (never invoked) unless `absent`. */
async function loadModule(ric: 'capture' | 'absent' = 'capture') {
    FakeAudio.reset();
    vi.resetModules();
    vi.stubGlobal('Audio', FakeAudio);
    const ricSpy = vi.fn();
    vi.stubGlobal('requestIdleCallback', ric === 'absent' ? undefined : ricSpy);
    const mod = await import('../lib/audioCache');
    return { mod, ricSpy };
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeAudio.reset();
});

describe('boot-time warm-up', () => {
    it('defers the bundled chimes to requestIdleCallback with a 1s timeout', async () => {
        const { ricSpy } = await loadModule();
        expect(ricSpy).toHaveBeenCalledTimes(1);
        expect(ricSpy.mock.calls[0][1]).toEqual({ timeout: 1000 });
        expect(FakeAudio.instances).toHaveLength(0); // nothing synchronous at import
        const warm = ricSpy.mock.calls[0][0] as () => void;
        warm();
        expect(FakeAudio.instances.map(a => a.src)).toEqual(BUNDLED);
        for (const a of FakeAudio.instances) {
            expect(a.preload).toBe('auto');
            expect(a.load).toHaveBeenCalledTimes(1);
            expect(a.play).not.toHaveBeenCalled();
        }
    });

    it('falls back to a 0ms timeout when requestIdleCallback is unavailable', async () => {
        vi.useFakeTimers();
        await loadModule('absent');
        expect(FakeAudio.instances).toHaveLength(0);
        vi.runOnlyPendingTimers();
        expect(FakeAudio.instances.map(a => a.src)).toEqual(BUNDLED);
        expect(FakeAudio.instances.every(a => a.play.mock.calls.length === 0)).toBe(true);
    });
});

describe('prefetchSound / prefetchSounds', () => {
    it('ignores empty, null and undefined URLs', async () => {
        const { mod } = await loadModule();
        mod.prefetchSound('');
        mod.prefetchSound(null);
        mod.prefetchSound(undefined);
        expect(FakeAudio.instances).toHaveLength(0);
    });

    it('sets preload before src and loads after src, without playing', async () => {
        const { mod } = await loadModule();
        mod.prefetchSound(URL_A);
        expect(FakeAudio.instances).toHaveLength(1);
        const a = FakeAudio.instances[0];
        expect(a.ctorArg).toBeUndefined();
        expect(a.order).toEqual(['preload', 'src', 'load']);
        expect(a.preload).toBe('auto');
        expect(a.src).toBe(URL_A);
        expect(a.play).not.toHaveBeenCalled();
    });

    it('is idempotent per URL', async () => {
        const { mod } = await loadModule();
        mod.prefetchSound(URL_A);
        mod.prefetchSound(URL_A);
        expect(FakeAudio.instances).toHaveLength(1);
        expect(FakeAudio.instances[0].load).toHaveBeenCalledTimes(1);
    });

    it('warns and does not cache when the Audio constructor throws, so it is retried', async () => {
        const { mod } = await loadModule();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const err = new Error('Audio unsupported');
        FakeAudio.ctorError = err;
        mod.prefetchSound(URL_A);
        expect(warn).toHaveBeenCalledWith('[audioCache] prefetch failed for', URL_A, err);
        FakeAudio.ctorError = null;
        mod.prefetchSound(URL_A);
        expect(FakeAudio.instances).toHaveLength(1);
        expect(FakeAudio.instances[0].src).toBe(URL_A);
    });

    it('does not cache an element whose load() throws', async () => {
        const { mod } = await loadModule();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeAudio.loadError = new Error('NotSupportedError');
        mod.prefetchSound(URL_A);
        expect(warn).toHaveBeenCalledWith('[audioCache] prefetch failed for', URL_A, FakeAudio.loadError);
        FakeAudio.loadError = null;
        mod.prefetchSound(URL_A);
        expect(FakeAudio.instances).toHaveLength(2); // retried, not served from cache
    });

    it('bulk-prefetches, skipping blanks and duplicates', async () => {
        const { mod } = await loadModule();
        mod.prefetchSounds([URL_A, null, URL_B, undefined, '', URL_A]);
        expect(FakeAudio.instances.map(a => a.src)).toEqual([URL_A, URL_B]);
    });
});

describe('playCachedSound', () => {
    it('does nothing without a URL', async () => {
        const { mod } = await loadModule();
        mod.playCachedSound(undefined, 50);
        mod.playCachedSound('', 50);
        expect(FakeAudio.instances).toHaveLength(0);
        expect(FakeAudio.clones).toHaveLength(0);
    });

    it('warms a cold URL, then plays a deep clone — never the cached node', async () => {
        const { mod } = await loadModule();
        mod.playCachedSound(URL_A, 50);
        expect(FakeAudio.instances).toHaveLength(1);
        const cached = FakeAudio.instances[0];
        expect(cached.cloneNode).toHaveBeenCalledWith(true);
        expect(FakeAudio.clones).toHaveLength(1);
        const clone = FakeAudio.clones[0];
        expect(clone.src).toBe(URL_A);
        expect(clone.play).toHaveBeenCalledTimes(1);
        expect(clone.volume).toBe(0.5);
        expect(cached.play).not.toHaveBeenCalled();
    });

    it('reuses an already-warm element instead of creating a new one', async () => {
        const { mod } = await loadModule();
        mod.prefetchSound(URL_A);
        mod.playCachedSound(URL_A, 100);
        expect(FakeAudio.instances).toHaveLength(1);
        expect(FakeAudio.clones).toHaveLength(1);
    });

    it('gives overlapping plays their own clone each', async () => {
        const { mod } = await loadModule();
        mod.playCachedSound(URL_A, 40);
        mod.playCachedSound(URL_A, 60);
        expect(FakeAudio.instances).toHaveLength(1);
        expect(FakeAudio.clones).toHaveLength(2);
        expect(FakeAudio.clones[0]).not.toBe(FakeAudio.clones[1]);
        expect(FakeAudio.clones.map(c => c.play.mock.calls.length)).toEqual([1, 1]);
        expect(FakeAudio.clones.map(c => c.volume)).toEqual([0.4, 0.6]);
    });

    it('clamps the 0–100 volume slider into 0–1', async () => {
        const { mod } = await loadModule();
        for (const [input, expected] of [[150, 1], [100, 1], [37, 0.37], [0, 0], [-20, 0]] as const) {
            mod.playCachedSound(URL_A, input);
            expect(FakeAudio.clones[FakeAudio.clones.length - 1].volume, String(input)).toBe(expected);
        }
    });

    it('still plays a fresh Audio(url) when the URL could not be cached', async () => {
        const { mod } = await loadModule();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeAudio.loadError = new Error('NotSupportedError');
        mod.playCachedSound(URL_B, 80);
        expect(FakeAudio.instances).toHaveLength(2);
        const fresh = FakeAudio.instances[1];
        expect(fresh.ctorArg).toBe(URL_B);
        expect(fresh.play).toHaveBeenCalledTimes(1);
        expect(fresh.volume).toBe(0.8);
        expect(FakeAudio.clones).toHaveLength(0);
    });

    it('logs (never throws) when playback is rejected by the autoplay policy', async () => {
        const { mod } = await loadModule();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeAudio.playImpl = () => Promise.reject(new Error('NotAllowedError: play() requires a user gesture'));
        expect(() => mod.playCachedSound(URL_A, 50)).not.toThrow();
        await flushMicrotasks();
        expect(warn).toHaveBeenCalledWith('[audioCache] playback failed for', URL_A, 'NotAllowedError: play() requires a user gesture');
    });

    it('logs a non-Error rejection reason as-is', async () => {
        const { mod } = await loadModule();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeAudio.playImpl = () => Promise.reject('blocked');
        mod.playCachedSound(URL_A, 50);
        await flushMicrotasks();
        expect(warn).toHaveBeenCalledWith('[audioCache] playback failed for', URL_A, 'blocked');
    });

    it('tolerates a play() that returns no promise (legacy browsers)', async () => {
        const { mod } = await loadModule();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const ret of [undefined, {}]) {
            FakeAudio.playImpl = () => ret;
            expect(() => mod.playCachedSound(URL_A, 50)).not.toThrow();
        }
        await flushMicrotasks();
        expect(FakeAudio.clones.map(c => c.play.mock.calls.length)).toEqual([1, 1]);
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it('logs a synchronous playback error instead of throwing', async () => {
        const { mod } = await loadModule();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const err = new Error('InvalidStateError');
        FakeAudio.playImpl = () => { throw err; };
        expect(() => mod.playCachedSound(URL_A, 50)).not.toThrow();
        expect(error).toHaveBeenCalledWith('[audioCache] error playing', URL_A, err);
    });
});
