// @vitest-environment node
//
// lib/cache.ts — the in-process TTL cache in front of platform_settings,
// system_roles and the op-access lookup. The access-relevant property is the
// staleness bound: an entry must stop being served the instant its TTL passes, and
// invalidate/invalidatePrefix must drop exactly the keys they name (a role or ally
// change calls them so a revoked grant is not served from cache).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cache, TTL } from '../lib/cache';

const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    cache.clear();
});

afterEach(() => {
    cache.clear();
    vi.useRealTimers();
});

describe('get / set', () => {
    it('returns undefined for a key that was never set', () => {
        expect(cache.get('nope')).toBeUndefined();
    });

    it('returns the stored value (same reference) inside the TTL', () => {
        const value = { roles: ['a'] };
        cache.set('k', value, 1000);
        expect(cache.get('k')).toBe(value);
    });

    it.each([0, '', false, null])('stores and returns the falsy value %j (not mistaken for a miss)', (v) => {
        cache.set('falsy', v, 1000);
        expect(cache.get('falsy')).toBe(v);
    });

    it('still serves the entry at exactly its expiry instant and drops it 1ms later', () => {
        cache.set('k', 'v', 1000);
        vi.setSystemTime(T0 + 1000);
        expect(cache.get('k')).toBe('v');
        vi.setSystemTime(T0 + 1001);
        expect(cache.get('k')).toBeUndefined();
    });

    it('DELETES an expired entry on read (rewinding the clock does not resurrect it)', () => {
        cache.set('k', 'v', 1000);
        vi.setSystemTime(T0 + 5000);
        expect(cache.get('k')).toBeUndefined();
        vi.setSystemTime(T0);
        expect(cache.get('k')).toBeUndefined();
    });

    it('an un-read expired entry is still refused (expiry is checked, not just evicted)', () => {
        cache.set('k', 'v', 10);
        vi.setSystemTime(T0 + 11);
        expect(cache.get('k')).toBeUndefined();
    });

    it('re-setting a key replaces the value and restarts its TTL', () => {
        cache.set('k', 'old', 1000);
        vi.setSystemTime(T0 + 900);
        cache.set('k', 'new', 1000);
        vi.setSystemTime(T0 + 1500);
        expect(cache.get('k')).toBe('new');
        vi.setSystemTime(T0 + 1901);
        expect(cache.get('k')).toBeUndefined();
    });
});

describe('invalidation', () => {
    it('invalidate() drops only the named key', () => {
        cache.set('a', 1, 1000);
        cache.set('b', 2, 1000);
        cache.invalidate('a');
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
    });

    it('invalidate() of an absent key is a no-op', () => {
        cache.set('a', 1, 1000);
        expect(() => cache.invalidate('missing')).not.toThrow();
        expect(cache.get('a')).toBe(1);
    });

    it('invalidatePrefix() drops every key starting with the prefix and nothing else', () => {
        cache.set('system_roles:1', 'r1', 1000);
        cache.set('system_roles:2', 'r2', 1000);
        cache.set('system_roles', 'bare', 1000);          // no colon: not under the prefix
        cache.set('op_access:system_roles:1', 'x', 1000); // contains, but does not START with
        cache.invalidatePrefix('system_roles:');
        expect(cache.get('system_roles:1')).toBeUndefined();
        expect(cache.get('system_roles:2')).toBeUndefined();
        expect(cache.get('system_roles')).toBe('bare');
        expect(cache.get('op_access:system_roles:1')).toBe('x');
    });

    it('clear() drops everything', () => {
        cache.set('a', 1, 1000);
        cache.set('b', 2, 1000);
        cache.clear();
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBeUndefined();
    });
});

describe('TTL constants', () => {
    it('bounds settings / op-access staleness at 30s and system roles at 5 minutes', () => {
        expect(TTL).toEqual({ PLATFORM_SETTINGS: 30_000, SYSTEM_ROLES: 300_000, OP_ACCESS: 30_000 });
    });

    it('an op-access entry is gone once OP_ACCESS has elapsed', () => {
        cache.set('op_access:op1:5', true, TTL.OP_ACCESS);
        vi.setSystemTime(T0 + TTL.OP_ACCESS);
        expect(cache.get('op_access:op1:5')).toBe(true);
        vi.setSystemTime(T0 + TTL.OP_ACCESS + 1);
        expect(cache.get('op_access:op1:5')).toBeUndefined();
    });
});
