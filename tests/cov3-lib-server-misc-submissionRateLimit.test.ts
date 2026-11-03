// @vitest-environment node
//
// lib/submissionRateLimit.ts — per-user minute (5) + day (30) caps on member-driven
// HR / job applications, which otherwise fan a Web Push out to every recruiter on
// each row (storage + notification DoS). Complements tests/submissionRateLimit.test.ts
// (basic caps) with the exact retry-after maths, the throwing wrapper the handlers
// call, the bucket-cap shed, day-window reset and pruning.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    checkSubmissionRateLimit,
    assertSubmissionRateLimit,
    pruneSubmissionRateLimitBuckets,
    _resetSubmissionRateLimit,
} from '../lib/submissionRateLimit';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

beforeEach(() => _resetSubmissionRateLimit());
afterEach(() => {
    _resetSubmissionRateLimit();
    vi.useRealTimers();
});

function burn(userId: number | string, n: number, now: number) {
    for (let i = 0; i < n; i++) expect(checkSubmissionRateLimit(userId, now).ok).toBe(true);
}

describe('checkSubmissionRateLimit', () => {
    it('returns ok with retryAfter 0 and no scope while under the cap', () => {
        expect(checkSubmissionRateLimit(1, T0)).toEqual({ ok: true, retryAfter: 0 });
    });

    it('reports the minute scope with the seconds left in the window (ceil)', () => {
        burn(1, 5, T0);
        expect(checkSubmissionRateLimit(1, T0)).toEqual({ ok: false, retryAfter: 60, scope: 'minute' });
        expect(checkSubmissionRateLimit(1, T0 + 59_001)).toEqual({ ok: false, retryAfter: 1, scope: 'minute' });
        expect(checkSubmissionRateLimit(1, T0 + 30_500)).toEqual({ ok: false, retryAfter: 30, scope: 'minute' });
    });

    it('a refused attempt is not counted (the minute window reopens with a full allowance)', () => {
        burn(1, 5, T0);
        for (let i = 0; i < 10; i++) expect(checkSubmissionRateLimit(1, T0 + 1000).ok).toBe(false);
        burn(1, 5, T0 + MINUTE);
        expect(checkSubmissionRateLimit(1, T0 + MINUTE).ok).toBe(false);
    });

    it('reports the day scope (checked before the minute scope) with seconds to the day reset', () => {
        let t = T0;
        for (let i = 0; i < 6; i++) { burn(1, 5, t); t += MINUTE; }
        // 30 used, fresh minute window — the day cap is what refuses.
        expect(checkSubmissionRateLimit(1, t)).toEqual({ ok: false, retryAfter: Math.ceil((T0 + DAY - t) / 1000), scope: 'day' });
        expect(checkSubmissionRateLimit(1, T0 + DAY - 1)).toEqual({ ok: false, retryAfter: 1, scope: 'day' });
    });

    it('resets the day window after 24h', () => {
        let t = T0;
        for (let i = 0; i < 6; i++) { burn(1, 5, t); t += MINUTE; }
        expect(checkSubmissionRateLimit(1, t).ok).toBe(false);
        expect(checkSubmissionRateLimit(1, T0 + DAY)).toEqual({ ok: true, retryAfter: 0 });
    });

    it('keys numeric and string forms of the same id to ONE bucket', () => {
        burn(7, 3, T0);
        burn('7', 2, T0);
        expect(checkSubmissionRateLimit(7, T0).ok).toBe(false);
        expect(checkSubmissionRateLimit('7', T0).ok).toBe(false);
    });

    it.each([undefined, null, ''])('fails open for the missing id %j and never creates a bucket', (id) => {
        for (let i = 0; i < 50; i++) expect(checkSubmissionRateLimit(id, T0).ok).toBe(true);
        expect(pruneSubmissionRateLimitBuckets(T0 + 2 * DAY)).toBe(0);
    });

    it('sheds (admits without tracking) a NEW id once 20 000 buckets exist, while existing ids stay capped', () => {
        burn('tracked', 5, T0);
        for (let i = 1; i < 20_000; i++) checkSubmissionRateLimit(`spray-${i}`, T0);
        // The map is full: a brand-new id is admitted every time and never limited.
        for (let i = 0; i < 10; i++) expect(checkSubmissionRateLimit('newcomer', T0)).toEqual({ ok: true, retryAfter: 0 });
        // An id that already had a bucket is still enforced.
        expect(checkSubmissionRateLimit('tracked', T0)).toMatchObject({ ok: false, scope: 'minute' });
        expect(pruneSubmissionRateLimitBuckets(T0 + DAY)).toBe(20_000);
    });

    it('defaults `now` to Date.now()', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        burn(9, 5, T0);
        expect(checkSubmissionRateLimit(9)).toEqual({ ok: false, retryAfter: 60, scope: 'minute' });
        vi.setSystemTime(T0 + MINUTE);
        expect(checkSubmissionRateLimit(9).ok).toBe(true);
    });
});

describe('assertSubmissionRateLimit', () => {
    it('does not throw while under the cap, and consumes an attempt', () => {
        for (let i = 0; i < 5; i++) expect(() => assertSubmissionRateLimit(3, T0)).not.toThrow();
        expect(checkSubmissionRateLimit(3, T0).ok).toBe(false);
    });

    it('throws a SUBMISSION_RATE_LIMITED error naming the minute scope and retry delay', () => {
        burn(3, 5, T0);
        let caught: (Error & { code?: string }) | undefined;
        try { assertSubmissionRateLimit(3, T0 + 15_000); } catch (e) { caught = e as Error & { code?: string }; }
        expect(caught).toBeInstanceOf(Error);
        expect(caught!.message).toBe('Too many submissions (per minute). Try again in 45s.');
        expect(caught!.code).toBe('SUBMISSION_RATE_LIMITED');
    });

    it('names the day scope once the daily cap is spent', () => {
        let t = T0;
        for (let i = 0; i < 6; i++) { burn(3, 5, t); t += MINUTE; }
        expect(() => assertSubmissionRateLimit(3, T0 + DAY - 2000)).toThrow('Too many submissions (per day). Try again in 2s.');
    });

    it('defaults `now` to Date.now()', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        burn(4, 5, T0);
        expect(() => assertSubmissionRateLimit(4)).toThrow(/per minute\)\. Try again in 60s/);
    });
});

describe('pruneSubmissionRateLimitBuckets', () => {
    it('removes only buckets whose day AND minute windows have both elapsed', () => {
        burn('old', 1, T0);
        burn('recent', 1, T0 + DAY - 1);
        expect(pruneSubmissionRateLimitBuckets(T0 + DAY)).toBe(1);
        // 'recent' kept its state: four more fill its minute window.
        burn('recent', 4, T0 + DAY - 1);
        expect(checkSubmissionRateLimit('recent', T0 + DAY - 1).ok).toBe(false);
    });

    it('keeps a bucket whose day window elapsed but whose minute window was just reopened', () => {
        burn('u', 1, T0);
        // Use it again just inside the 24h mark (fresh minute window, same day window).
        burn('u', 1, T0 + DAY - 10);
        expect(pruneSubmissionRateLimitBuckets(T0 + DAY)).toBe(0);
        expect(pruneSubmissionRateLimitBuckets(T0 + DAY - 10 + MINUTE)).toBe(1);
    });

    it('a pruned user starts over with a full allowance', () => {
        let t = T0;
        for (let i = 0; i < 6; i++) { burn('p', 5, t); t += MINUTE; }
        expect(checkSubmissionRateLimit('p', t).ok).toBe(false);
        expect(pruneSubmissionRateLimitBuckets(T0 + 2 * DAY)).toBe(1);
        burn('p', 5, T0 + 2 * DAY);
    });

    it('defaults `now` to Date.now()', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        burn('d', 1, T0);
        expect(pruneSubmissionRateLimitBuckets()).toBe(0);
        vi.setSystemTime(T0 + DAY);
        expect(pruneSubmissionRateLimitBuckets()).toBe(1);
    });
});
