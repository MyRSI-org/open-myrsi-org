// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LocalAudioTrack } from 'livekit-client';

// SSR / non-browser guards for the client utilities. These modules can be pulled into a
// non-DOM context (SSR, a worker, the node test env); each must no-op rather than touch
// browser APIs. Browser globals are stubbed as spies here to prove they are never reached
// once `window` is absent.

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('non-browser guards', () => {
    it('runs under a real non-DOM environment', () => {
        expect(typeof window).toBe('undefined');
    });

    it('attachMicLevelMeter returns null without constructing an AudioContext', async () => {
        const ctor = vi.fn();
        vi.stubGlobal('AudioContext', ctor);
        const { attachMicLevelMeter } = await import('../lib/audio/micLevel');
        expect(attachMicLevelMeter({ mediaStreamTrack: { kind: 'audio' } } as unknown as LocalAudioTrack)).toBeNull();
        expect(ctor).not.toHaveBeenCalled();
    });

    it('installAvatarFallback is a no-op', async () => {
        const { installAvatarFallback } = await import('../lib/avatarFallback');
        expect(() => installAvatarFallback()).not.toThrow();
        expect((globalThis as Record<string, unknown>).__avatarFallbackInstalled).toBeUndefined();
    });

    it('audioCache schedules no warm-up at import and never creates Audio elements', async () => {
        vi.useFakeTimers();
        const AudioSpy = vi.fn();
        const ric = vi.fn();
        vi.stubGlobal('Audio', AudioSpy);
        vi.stubGlobal('requestIdleCallback', ric);
        const mod = await import('../lib/audioCache');
        expect(vi.getTimerCount()).toBe(0);
        expect(ric).not.toHaveBeenCalled();
        mod.prefetchSound('/media/success-chime.mp3');
        mod.prefetchSounds(['/a.mp3', '/b.mp3']);
        mod.playCachedSound('/media/error-chime.mp3', 50);
        vi.runAllTimers();
        expect(AudioSpy).not.toHaveBeenCalled();
    });
});
