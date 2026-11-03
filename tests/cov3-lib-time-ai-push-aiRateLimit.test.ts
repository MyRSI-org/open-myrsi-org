// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkAiRateLimit, assertAiRateLimit, pruneAiRateLimitBuckets, _resetAiRateLimit } from '../lib/aiRateLimit';

// Per-user throttle on the paid Gemini actions: 5 per rolling-start minute, 50 per day,
// keyed on the server-derived user id. Windows are driven by the injected `now` or, when
// omitted, the (faked) system clock.

const MINUTE = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-04-10T00:00:00.000Z');

beforeEach(() => {
    _resetAiRateLimit();
});

afterEach(() => {
    vi.useRealTimers();
    _resetAiRateLimit();
});

describe('checkAiRateLimit — minute window', () => {
    it('admits 5 calls, then refuses with retryAfter = seconds left in the minute', () => {
        for (let i = 0; i < 5; i++) expect(checkAiRateLimit(1, T0)).toEqual({ ok: true, retryAfter: 0 });
        expect(checkAiRateLimit(1, T0)).toEqual({ ok: false, retryAfter: 60, scope: 'minute' });
        expect(checkAiRateLimit(1, T0 + 20_500)).toEqual({ ok: false, retryAfter: 40, scope: 'minute' });
        // Never reports 0s while still refusing.
        expect(checkAiRateLimit(1, T0 + MINUTE - 1)).toEqual({ ok: false, retryAfter: 1, scope: 'minute' });
    });

    it('reopens exactly when the minute has fully elapsed, starting a fresh window there', () => {
        for (let i = 0; i < 5; i++) checkAiRateLimit(1, T0);
        expect(checkAiRateLimit(1, T0 + MINUTE).ok).toBe(true);
        for (let i = 0; i < 4; i++) expect(checkAiRateLimit(1, T0 + MINUTE + 1).ok).toBe(true);
        // The new window started at T0 + MINUTE, so it is full until T0 + 2*MINUTE.
        expect(checkAiRateLimit(1, T0 + 2 * MINUTE - 1)).toEqual({ ok: false, retryAfter: 1, scope: 'minute' });
    });

    it('a refused call does not consume quota', () => {
        for (let i = 0; i < 5; i++) checkAiRateLimit(1, T0);
        for (let i = 0; i < 20; i++) expect(checkAiRateLimit(1, T0 + 1000).ok).toBe(false);
        // Only the 5 admitted calls count toward the day: 45 more fit across later minutes.
        let admitted = 0;
        for (let m = 1; m <= 20; m++) {
            for (let i = 0; i < 5; i++) if (checkAiRateLimit(1, T0 + m * MINUTE).ok) admitted++;
        }
        expect(admitted).toBe(45);
    });
});

describe('checkAiRateLimit — day window', () => {
    it('refuses past 50/day with scope "day" and retryAfter until the day window rolls over', () => {
        let t = T0;
        for (let i = 0; i < 50; i++) {
            expect(checkAiRateLimit('u', t).ok).toBe(true);
            if (i % 5 === 4) t += MINUTE;
        }
        // t is now T0 + 10 minutes.
        expect(checkAiRateLimit('u', t)).toEqual({ ok: false, retryAfter: (DAY - 10 * MINUTE) / 1000, scope: 'day' });
        // The day cap is reported even while the minute window is also open.
        expect(checkAiRateLimit('u', T0 + DAY - 500)).toEqual({ ok: false, retryAfter: 1, scope: 'day' });
    });

    it('the day cap takes precedence over a simultaneously-full minute window', () => {
        let t = T0;
        for (let i = 0; i < 45; i++) {
            checkAiRateLimit('u', t);
            if (i % 5 === 4) t += MINUTE;
        }
        for (let i = 0; i < 5; i++) checkAiRateLimit('u', t);
        // 50 used and the current minute is full — the longer wait wins.
        expect(checkAiRateLimit('u', t).scope).toBe('day');
    });

    it('resets the day count once a full day has elapsed', () => {
        let t = T0;
        for (let i = 0; i < 50; i++) {
            checkAiRateLimit('u', t);
            if (i % 5 === 4) t += MINUTE;
        }
        expect(checkAiRateLimit('u', T0 + DAY - 1).ok).toBe(false);
        expect(checkAiRateLimit('u', T0 + DAY)).toEqual({ ok: true, retryAfter: 0 });
    });
});

describe('checkAiRateLimit — identity and bounds', () => {
    it('keys on the stringified id, so 42 and "42" share one bucket', () => {
        for (let i = 0; i < 3; i++) checkAiRateLimit(42, T0);
        for (let i = 0; i < 2; i++) checkAiRateLimit('42', T0);
        expect(checkAiRateLimit(42, T0).ok).toBe(false);
        expect(checkAiRateLimit('42', T0).ok).toBe(false);
        expect(checkAiRateLimit(43, T0).ok).toBe(true);
    });

    it('fails open (and records nothing) for a missing user id', () => {
        for (const id of [undefined, null, '']) {
            for (let i = 0; i < 10; i++) expect(checkAiRateLimit(id, T0)).toEqual({ ok: true, retryAfter: 0 });
        }
        expect(pruneAiRateLimitBuckets(T0 + 2 * DAY)).toBe(0);
    });

    it('stops creating buckets at 10,000 users (memory bound) but keeps enforcing existing ones', () => {
        for (let i = 0; i < 10_000; i++) checkAiRateLimit(i, T0);
        // A new user past the cap is admitted without a bucket — repeatedly.
        for (let i = 0; i < 10; i++) expect(checkAiRateLimit('late-user', T0)).toEqual({ ok: true, retryAfter: 0 });
        // Existing users are still metered: user 0 has 1 call, 4 more then refused.
        for (let i = 0; i < 4; i++) expect(checkAiRateLimit(0, T0).ok).toBe(true);
        expect(checkAiRateLimit(0, T0).ok).toBe(false);
        // Only the 10,000 real buckets exist to be pruned.
        expect(pruneAiRateLimitBuckets(T0 + DAY)).toBe(10_000);
        // With room again, the late user now gets a real bucket.
        for (let i = 0; i < 5; i++) checkAiRateLimit('late-user', T0 + DAY);
        expect(checkAiRateLimit('late-user', T0 + DAY).ok).toBe(false);
    });

    it('defaults `now` to the system clock', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        for (let i = 0; i < 5; i++) expect(checkAiRateLimit(7).ok).toBe(true);
        expect(checkAiRateLimit(7)).toEqual({ ok: false, retryAfter: 60, scope: 'minute' });
        vi.setSystemTime(T0 + 30_000);
        expect(checkAiRateLimit(7)).toEqual({ ok: false, retryAfter: 30, scope: 'minute' });
        vi.setSystemTime(T0 + MINUTE);
        expect(checkAiRateLimit(7).ok).toBe(true);
    });
});

describe('assertAiRateLimit', () => {
    it('passes silently while under the limit', () => {
        for (let i = 0; i < 5; i++) expect(() => assertAiRateLimit(9, T0)).not.toThrow();
    });

    it('throws a coded, user-facing error naming the window and the wait', () => {
        for (let i = 0; i < 5; i++) assertAiRateLimit(9, T0);
        let caught: (Error & { code?: string }) | undefined;
        try { assertAiRateLimit(9, T0 + 15_000); } catch (e) { caught = e as Error & { code?: string }; }
        expect(caught).toBeInstanceOf(Error);
        expect(caught!.message).toBe('AI request limit reached (per minute). Try again in 45s.');
        expect(caught!.code).toBe('AI_RATE_LIMITED');
    });

    it('reports the day scope once the daily cap is hit', () => {
        let t = T0;
        for (let i = 0; i < 50; i++) {
            assertAiRateLimit(9, t);
            if (i % 5 === 4) t += MINUTE;
        }
        expect(() => assertAiRateLimit(9, T0 + DAY - 2_000)).toThrow('AI request limit reached (per day). Try again in 2s.');
    });

    it('defaults `now` to the system clock', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        for (let i = 0; i < 5; i++) assertAiRateLimit(11);
        vi.setSystemTime(T0 + 59_000);
        expect(() => assertAiRateLimit(11)).toThrow('Try again in 1s.');
    });
});

describe('pruneAiRateLimitBuckets', () => {
    it('removes only buckets whose minute AND day windows have both expired', () => {
        checkAiRateLimit('old', T0);
        checkAiRateLimit('fresh', T0 + DAY - MINUTE);
        // At T0 + DAY: 'old' day window over; 'fresh' still inside its day.
        expect(pruneAiRateLimitBuckets(T0 + DAY)).toBe(1);
        // 'old' is gone (fresh bucket, full quota) and 'fresh' is the only survivor.
        for (let i = 0; i < 5; i++) expect(checkAiRateLimit('old', T0 + DAY).ok).toBe(true);
        expect(pruneAiRateLimitBuckets(T0 + DAY)).toBe(0);
        expect(pruneAiRateLimitBuckets(T0 + 2 * DAY)).toBe(2);
    });

    it('keeps a bucket whose day window expired but whose minute window was just restarted', () => {
        // Day started at T0; a call at T0 + DAY - 1s restarts only the minute window.
        checkAiRateLimit('x', T0);
        checkAiRateLimit('x', T0 + DAY - 1_000);
        expect(pruneAiRateLimitBuckets(T0 + DAY)).toBe(0);
        expect(pruneAiRateLimitBuckets(T0 + DAY - 1_000 + MINUTE)).toBe(1);
    });

    it('defaults `now` to the system clock and returns 0 when nothing is stale', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        checkAiRateLimit('a');
        expect(pruneAiRateLimitBuckets()).toBe(0);
        vi.setSystemTime(T0 + DAY);
        expect(pruneAiRateLimitBuckets()).toBe(1);
    });
});
