import { describe, it, expect, beforeEach } from 'vitest';
import {
    checkUserRateLimit, pruneUserRateLimitBuckets, __resetUserRateLimitForTest, USER_PER_MINUTE, USER_PER_DAY,
} from '../lib/userRateLimit';
import {
    checkAuthRateLimit, pruneAuthRateLimitBuckets, _resetAuthRateLimit, _authRateLimitBucketCount,
} from '../lib/authRateLimit';
import {
    isJoinPinLocked, recordJoinPinFailure, clearJoinPinFailures, _resetJoinPinLockoutForTests,
    _joinPinLockoutSizeForTests, JOIN_PIN_MAX_FAILURES, JOIN_PIN_WINDOW_MS, JOIN_PIN_LOCKOUT_MAX_KEYS,
} from '../lib/joinPinLockout';

// The three in-memory abuse controls: the per-user dispatcher throttle, the per-IP
// auth:* shield, and the Special Operation join-PIN lockout. Pins window rollover,
// exact retry hints, the size bounds (shed vs evict), pruning, and keying.

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;
const USER_MAX_BUCKETS = 20_000;
const AUTH_MAX_BUCKETS = 10_000;

describe('checkUserRateLimit', () => {
    beforeEach(() => __resetUserRateLimitForTest());

    it('ignores a non-numeric or non-finite id (no bucket, never throttled)', () => {
        for (let i = 0; i < USER_PER_MINUTE + 5; i++) {
            expect(checkUserRateLimit(Number.NaN, NOW)).toEqual({ ok: true, retryAfter: 0 });
            expect(checkUserRateLimit(Infinity, NOW)).toEqual({ ok: true, retryAfter: 0 });
            expect(checkUserRateLimit('7' as unknown as number, NOW)).toEqual({ ok: true, retryAfter: 0 });
        }
    });

    it('returns the exact seconds left in the minute window, floored at 1', () => {
        for (let i = 0; i < USER_PER_MINUTE; i++) expect(checkUserRateLimit(1, NOW).ok).toBe(true);
        expect(checkUserRateLimit(1, NOW + 30_000)).toEqual({ ok: false, retryAfter: 30 });
        expect(checkUserRateLimit(1, NOW + 59_999)).toEqual({ ok: false, retryAfter: 1 });
        // the window boundary itself is a fresh window
        expect(checkUserRateLimit(1, NOW + MINUTE)).toEqual({ ok: true, retryAfter: 0 });
    });

    it('enforces the daily budget across minute windows, then resets after the day window', () => {
        let i = 0;
        for (; i < USER_PER_DAY; i++) {
            const at = NOW + Math.floor(i / USER_PER_MINUTE) * MINUTE;
            expect(checkUserRateLimit(2, at).ok).toBe(true);
        }
        const nextMinute = NOW + (Math.floor(i / USER_PER_MINUTE) + 1) * MINUTE;
        const verdict = checkUserRateLimit(2, nextMinute);
        expect(verdict.ok).toBe(false);
        expect(verdict.retryAfter).toBe(Math.ceil((NOW + DAY - nextMinute) / 1000));
        // a refused call does not consume budget, and the day window rolls over
        expect(checkUserRateLimit(2, NOW + DAY)).toEqual({ ok: true, retryAfter: 0 });
    });

    it('sheds (allows, untracked) a NEW id once the table is full, while tracked ids stay limited', () => {
        for (let id = 1; id <= USER_MAX_BUCKETS; id++) checkUserRateLimit(id, NOW);
        const newcomer = USER_MAX_BUCKETS + 1;
        for (let i = 0; i < USER_PER_MINUTE + 10; i++) {
            expect(checkUserRateLimit(newcomer, NOW).ok).toBe(true);
        }
        // id 1 has used 1 unit; it is still tracked and still capped
        for (let i = 1; i < USER_PER_MINUTE; i++) expect(checkUserRateLimit(1, NOW).ok).toBe(true);
        expect(checkUserRateLimit(1, NOW).ok).toBe(false);
    });

    it('prune frees capacity: after a day, a full table is emptied and new ids are tracked again', () => {
        for (let id = 1; id <= USER_MAX_BUCKETS; id++) checkUserRateLimit(id, NOW);
        pruneUserRateLimitBuckets(NOW + DAY);
        const newcomer = USER_MAX_BUCKETS + 1;
        for (let i = 0; i < USER_PER_MINUTE; i++) expect(checkUserRateLimit(newcomer, NOW + DAY).ok).toBe(true);
        expect(checkUserRateLimit(newcomer, NOW + DAY).ok).toBe(false);
    });

    it('prune keeps a bucket whose day window is still open (its minute cap still binds)', () => {
        const start = NOW + DAY - 10_000;
        for (let i = 0; i < USER_PER_MINUTE; i++) checkUserRateLimit(3, start);
        pruneUserRateLimitBuckets(NOW + DAY);
        expect(checkUserRateLimit(3, start + 5_000)).toEqual({ ok: false, retryAfter: 55 });
    });

    it('defaults now to the wall clock', () => {
        expect(checkUserRateLimit(4).ok).toBe(true);
        pruneUserRateLimitBuckets();
        for (let i = 1; i < USER_PER_MINUTE; i++) checkUserRateLimit(4);
        expect(checkUserRateLimit(4).ok).toBe(false);
    });
});

describe('checkAuthRateLimit', () => {
    beforeEach(() => _resetAuthRateLimit());

    it('fails open, untracked, for a missing or unknown IP', () => {
        for (let i = 0; i < 20; i++) {
            expect(checkAuthRateLimit('', NOW)).toEqual({ ok: true, retryAfter: 0 });
            expect(checkAuthRateLimit('unknown', NOW)).toEqual({ ok: true, retryAfter: 0 });
        }
        expect(_authRateLimitBucketCount()).toBe(0);
    });

    it('allows 10 per window and returns the exact seconds remaining on the 11th', () => {
        for (let i = 0; i < 10; i++) expect(checkAuthRateLimit('198.51.100.1', NOW).ok).toBe(true);
        expect(checkAuthRateLimit('198.51.100.1', NOW + 15_000)).toEqual({ ok: false, retryAfter: 45 });
        expect(checkAuthRateLimit('198.51.100.1', NOW + 59_900)).toEqual({ ok: false, retryAfter: 1 });
        expect(checkAuthRateLimit('198.51.100.1', NOW + MINUTE)).toEqual({ ok: true, retryAfter: 0 });
    });

    it('is keyed per IP', () => {
        for (let i = 0; i < 11; i++) checkAuthRateLimit('198.51.100.2', NOW);
        expect(checkAuthRateLimit('198.51.100.2', NOW).ok).toBe(false);
        expect(checkAuthRateLimit('198.51.100.3', NOW).ok).toBe(true);
    });

    it('sheds a brand-new IP once the table is full, but keeps limiting tracked IPs', () => {
        for (let i = 0; i < AUTH_MAX_BUCKETS; i++) checkAuthRateLimit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, NOW);
        expect(_authRateLimitBucketCount()).toBe(AUTH_MAX_BUCKETS);
        for (let i = 0; i < 25; i++) expect(checkAuthRateLimit('203.0.113.9', NOW).ok).toBe(true);
        expect(_authRateLimitBucketCount()).toBe(AUTH_MAX_BUCKETS);
        // 10.0.0.0 already has 1 attempt
        for (let i = 1; i < 10; i++) expect(checkAuthRateLimit('10.0.0.0', NOW).ok).toBe(true);
        expect(checkAuthRateLimit('10.0.0.0', NOW).ok).toBe(false);
    });

    it('renews an EXPIRED tracked bucket even while the table is full (no shed for known IPs)', () => {
        for (let i = 0; i < AUTH_MAX_BUCKETS; i++) checkAuthRateLimit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, NOW);
        for (let i = 0; i < 10; i++) expect(checkAuthRateLimit('10.0.0.1', NOW + MINUTE).ok).toBe(true);
        expect(checkAuthRateLimit('10.0.0.1', NOW + MINUTE).ok).toBe(false);
        expect(_authRateLimitBucketCount()).toBe(AUTH_MAX_BUCKETS);
    });

    it('prune removes only expired buckets and reports how many', () => {
        checkAuthRateLimit('198.51.100.10', NOW);
        checkAuthRateLimit('198.51.100.11', NOW + 30_000);
        expect(pruneAuthRateLimitBuckets(NOW + MINUTE)).toBe(1);
        expect(_authRateLimitBucketCount()).toBe(1);
        expect(pruneAuthRateLimitBuckets(NOW + MINUTE)).toBe(0);
        expect(pruneAuthRateLimitBuckets(NOW + 2 * MINUTE)).toBe(1);
        expect(_authRateLimitBucketCount()).toBe(0);
    });

    it('defaults now to the wall clock', () => {
        expect(checkAuthRateLimit('198.51.100.20').ok).toBe(true);
        expect(pruneAuthRateLimitBuckets()).toBe(0);
    });
});

describe('join PIN lockout', () => {
    beforeEach(() => _resetJoinPinLockoutForTests());

    const OP = 'op-uuid-1';

    function lockOut(userId: number, op: string, at: number) {
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES; i++) recordJoinPinFailure(userId, op, at);
    }

    it('trips on exactly the 5th failure, reporting lockedNow once', () => {
        const trips: boolean[] = [];
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES; i++) trips.push(recordJoinPinFailure(1, OP, NOW + i).lockedNow);
        expect(trips).toEqual([false, false, false, false, true]);
        expect(isJoinPinLocked(1, OP, NOW + 10)).toBe(true);
    });

    it('a failure DURING a lockout neither re-trips nor extends it', () => {
        lockOut(1, OP, NOW);
        expect(recordJoinPinFailure(1, OP, NOW + 10 * MINUTE)).toEqual({ lockedNow: false });
        expect(isJoinPinLocked(1, OP, NOW + JOIN_PIN_WINDOW_MS - 1)).toBe(true);
        expect(isJoinPinLocked(1, OP, NOW + JOIN_PIN_WINDOW_MS)).toBe(false);
    });

    it('drops an elapsed lockout on read, so the next attempt has a fresh budget', () => {
        lockOut(1, OP, NOW);
        expect(_joinPinLockoutSizeForTests()).toBe(1);
        expect(isJoinPinLocked(1, OP, NOW + JOIN_PIN_WINDOW_MS)).toBe(false);
        expect(_joinPinLockoutSizeForTests()).toBe(0);
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES - 1; i++) {
            expect(recordJoinPinFailure(1, OP, NOW + JOIN_PIN_WINDOW_MS + i).lockedNow).toBe(false);
        }
    });

    it('an unlocked entry with failures is not "locked" and is kept on read', () => {
        recordJoinPinFailure(1, OP, NOW);
        expect(isJoinPinLocked(1, OP, NOW + 1)).toBe(false);
        expect(_joinPinLockoutSizeForTests()).toBe(1);
        expect(isJoinPinLocked(99, OP, NOW)).toBe(false);
    });

    it('starts over when every recorded failure has aged out of the window', () => {
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES - 1; i++) recordJoinPinFailure(1, OP, NOW);
        // 4 stale failures do not count toward the next 5
        const later = NOW + JOIN_PIN_WINDOW_MS;
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES - 1; i++) expect(recordJoinPinFailure(1, OP, later + i).lockedNow).toBe(false);
        expect(recordJoinPinFailure(1, OP, later + 10).lockedNow).toBe(true);
    });

    it('is a rolling window: only failures inside the last 15 minutes count', () => {
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES - 1; i++) recordJoinPinFailure(1, OP, NOW + i * MINUTE);
        // at NOW+15m30s the first failure (NOW) has aged out; the other three remain
        expect(recordJoinPinFailure(1, OP, NOW + JOIN_PIN_WINDOW_MS + 30_000).lockedNow).toBe(false);
        expect(recordJoinPinFailure(1, OP, NOW + JOIN_PIN_WINDOW_MS + 31_000).lockedNow).toBe(true);
    });

    it('is keyed per user AND per operation, and a correct PIN clears only that pair', () => {
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES - 1; i++) {
            recordJoinPinFailure(1, OP, NOW);
            recordJoinPinFailure(1, 'op-2', NOW);
            recordJoinPinFailure(2, OP, NOW);
        }
        clearJoinPinFailures(1, OP);
        expect(recordJoinPinFailure(1, OP, NOW).lockedNow).toBe(false);
        expect(recordJoinPinFailure(1, 'op-2', NOW).lockedNow).toBe(true);
        expect(recordJoinPinFailure(2, OP, NOW).lockedNow).toBe(true);
    });

    describe('bounded table', () => {
        it('prunes expired entries first when full', () => {
            for (let u = 0; u < JOIN_PIN_LOCKOUT_MAX_KEYS; u++) recordJoinPinFailure(u, OP, NOW);
            expect(_joinPinLockoutSizeForTests()).toBe(JOIN_PIN_LOCKOUT_MAX_KEYS);
            recordJoinPinFailure(JOIN_PIN_LOCKOUT_MAX_KEYS, OP, NOW + JOIN_PIN_WINDOW_MS);
            expect(_joinPinLockoutSizeForTests()).toBe(1);
        });

        it('evicts the least-recently-touched UNLOCKED entry, never an active lockout, when nothing has expired', () => {
            lockOut(0, OP, NOW);
            for (let u = 1; u < JOIN_PIN_LOCKOUT_MAX_KEYS; u++) recordJoinPinFailure(u, OP, NOW);
            expect(_joinPinLockoutSizeForTests()).toBe(JOIN_PIN_LOCKOUT_MAX_KEYS);

            recordJoinPinFailure(JOIN_PIN_LOCKOUT_MAX_KEYS, OP, NOW + 1);
            expect(_joinPinLockoutSizeForTests()).toBe(JOIN_PIN_LOCKOUT_MAX_KEYS);
            // the lockout (oldest key) survives…
            expect(isJoinPinLocked(0, OP, NOW + 2)).toBe(true);
            // …user 1 (oldest unlocked) was evicted: four more failures do NOT trip it
            for (let i = 0; i < JOIN_PIN_MAX_FAILURES - 1; i++) expect(recordJoinPinFailure(1, OP, NOW + 3).lockedNow).toBe(false);
        });

        it('evicts the OLDEST lockout only when every entry is an active lockout', () => {
            for (let u = 0; u < JOIN_PIN_LOCKOUT_MAX_KEYS; u++) lockOut(u, OP, NOW);
            expect(_joinPinLockoutSizeForTests()).toBe(JOIN_PIN_LOCKOUT_MAX_KEYS);

            recordJoinPinFailure(JOIN_PIN_LOCKOUT_MAX_KEYS, OP, NOW + 1);
            expect(_joinPinLockoutSizeForTests()).toBe(JOIN_PIN_LOCKOUT_MAX_KEYS);
            expect(isJoinPinLocked(0, OP, NOW + 2)).toBe(false);
            expect(isJoinPinLocked(1, OP, NOW + 2)).toBe(true);
            expect(isJoinPinLocked(JOIN_PIN_LOCKOUT_MAX_KEYS - 1, OP, NOW + 2)).toBe(true);
        });

        it('a repeat failure refreshes recency, so the refreshed entry is not the one evicted', () => {
            for (let u = 0; u < JOIN_PIN_LOCKOUT_MAX_KEYS; u++) recordJoinPinFailure(u, OP, NOW);
            recordJoinPinFailure(0, OP, NOW + 1); // user 0 now most recent
            recordJoinPinFailure(JOIN_PIN_LOCKOUT_MAX_KEYS, OP, NOW + 2); // evicts user 1
            // user 0 has 2 failures retained: 3 more trip it
            expect(recordJoinPinFailure(0, OP, NOW + 3).lockedNow).toBe(false);
            expect(recordJoinPinFailure(0, OP, NOW + 3).lockedNow).toBe(false);
            expect(recordJoinPinFailure(0, OP, NOW + 3).lockedNow).toBe(true);
        });
    });

    it('defaults now to the wall clock', () => {
        lockOut(5, OP, Date.now());
        expect(isJoinPinLocked(5, OP)).toBe(true);
        expect(recordJoinPinFailure(5, OP)).toEqual({ lockedNow: false });
    });
});
