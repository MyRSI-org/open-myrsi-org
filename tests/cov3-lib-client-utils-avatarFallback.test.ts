import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installAvatarFallback } from '../lib/avatarFallback';

// lib/avatarFallback.ts — one capture-phase window 'error' listener that swaps a broken
// Discord avatar <img> (stale avatar hash → 404) for Discord's default embed avatar.
// Pinned: only Discord avatar URLs (global and guild-scoped) are touched, the user id
// (never the guild id) picks the default index via (id >> 22) % 6, the swap happens at
// most once per element (so a failing default cannot loop), everything else is ignored,
// and installation is idempotent. The real listener is captured and removed after each
// test so no global state leaks.
//
// Expected indices computed independently: (BigInt(id) >> 22n) % 6n
//   80351110224678912 → 5, 175928847299117063 → 2, 123456789012345678 → 0.

let listeners: EventListenerOrEventListenerObject[] = [];

beforeEach(() => {
    const realAdd = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, l: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
        if (type === 'error') listeners.push(l);
        realAdd(type, l, opts);
    }) as typeof window.addEventListener);
});

afterEach(() => {
    for (const l of listeners) window.removeEventListener('error', l, true);
    listeners = [];
    delete (window as unknown as Record<string, unknown>).__avatarFallbackInstalled;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

function brokenImg(src: string): HTMLImageElement {
    const img = document.createElement('img');
    img.src = src;
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error')); // non-bubbling, like a real load failure
    return img;
}

describe('installAvatarFallback', () => {
    it('registers a single capture-phase error listener, once', () => {
        installAvatarFallback();
        installAvatarFallback();
        const errorCalls = vi.mocked(window.addEventListener).mock.calls.filter(c => c[0] === 'error');
        expect(errorCalls).toHaveLength(1);
        expect(errorCalls[0][2]).toBe(true);
        expect((window as unknown as Record<string, unknown>).__avatarFallbackInstalled).toBe(true);
    });

    it('swaps a broken global Discord avatar for the default derived from the user id', () => {
        installAvatarFallback();
        const img = brokenImg('https://cdn.discordapp.com/avatars/80351110224678912/a_deadbeef.png?size=64');
        expect(img.src).toBe('https://cdn.discordapp.com/embed/avatars/5.png');
        expect(img.dataset.avatarFallback).toBe('applied');
    });

    it('uses the user id, not the guild id, for a guild-scoped avatar', () => {
        installAvatarFallback();
        // guild 123456789012345678 → 0, user 175928847299117063 → 2
        const img = brokenImg('https://cdn.discordapp.com/guilds/123456789012345678/users/175928847299117063/avatars/abc.webp');
        expect(img.src).toBe('https://cdn.discordapp.com/embed/avatars/2.png');
    });

    it('swaps at most once per element, so a failing default cannot loop', () => {
        installAvatarFallback();
        const img = brokenImg('https://cdn.discordapp.com/avatars/80351110224678912/stale.png');
        expect(img.src).toBe('https://cdn.discordapp.com/embed/avatars/5.png');
        img.src = 'https://cdn.discordapp.com/avatars/123456789012345678/another.png';
        img.dispatchEvent(new Event('error'));
        expect(img.src).toBe('https://cdn.discordapp.com/avatars/123456789012345678/another.png');
    });

    it('leaves non-Discord, non-avatar and malformed-id images alone', () => {
        installAvatarFallback();
        for (const src of [
            'https://example.org/avatars/80351110224678912/x.png',
            'https://cdn.discordapp.com/icons/80351110224678912/x.png',
            'https://cdn.discordapp.com/avatars/12345678901234/x.png', // 14 digits — too short
            'https://cdn.discordapp.com/avatars/notanumber12345678/x.png',
        ]) {
            const img = brokenImg(src);
            expect(img.src, src).toBe(src);
            expect(img.dataset.avatarFallback, src).toBeUndefined();
        }
    });

    it('ignores an image with no source', () => {
        installAvatarFallback();
        const img = document.createElement('img');
        document.body.appendChild(img);
        img.dispatchEvent(new Event('error'));
        expect(img.getAttribute('src')).toBeNull();
        expect(img.dataset.avatarFallback).toBeUndefined();
    });

    it('ignores error events from non-image elements and from the window itself', () => {
        installAvatarFallback();
        const script = document.createElement('script');
        script.setAttribute('src', 'https://cdn.discordapp.com/avatars/80351110224678912/x.png');
        document.body.appendChild(script);
        script.dispatchEvent(new Event('error'));
        expect(script.getAttribute('src')).toBe('https://cdn.discordapp.com/avatars/80351110224678912/x.png');
        expect(script.dataset.avatarFallback).toBeUndefined();
        expect(() => window.dispatchEvent(new Event('error'))).not.toThrow();
    });

    it('does nothing until installed', () => {
        const img = brokenImg('https://cdn.discordapp.com/avatars/80351110224678912/x.png');
        expect(img.src).toBe('https://cdn.discordapp.com/avatars/80351110224678912/x.png');
    });
});
