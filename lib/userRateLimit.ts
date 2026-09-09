// Per-identity request throttle for the RPC dispatcher.
//
// A FIFTH sibling of the house pattern, deliberately not a consolidation of the four that exist
// (lib/aiRateLimit.ts 5/min·50/day, lib/submissionRateLimit.ts 5/min·30/day, lib/radio.ts
// 20/min·500/day, api/orgUpload.ts 30/min). Those four are COST controls on specific expensive
// actions; this is an abuse floor across every mutation, so it is looser than all of them and
// must not be conflated with any.
//
// It keys on the authenticated user id, which the dispatcher injects — never on anything the
// client supplies. That is what makes the shed-on-full branch safe: an attacker cannot spray
// synthetic identities to fill the map and disable the throttle for everyone else, because they
// cannot mint a user id.

interface Bucket { minuteCount: number; minuteStart: number; dayCount: number; dayStart: number }

/** Loose on purpose — an abuse floor, not a cost control. A busy dispatcher on a board view can
 *  legitimately burst; the number that matters is the one an automated abuser exceeds. */
export const USER_PER_MINUTE = 120;
export const USER_PER_DAY = 10_000;
const MAX_BUCKETS = 20_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const buckets = new Map<number, Bucket>();

export interface RateLimitVerdict { ok: boolean; retryAfter: number }

/** Check and consume one unit of a user's budget. */
export function checkUserRateLimit(userId: number, now: number = Date.now()): RateLimitVerdict {
    if (typeof userId !== 'number' || !Number.isFinite(userId)) return { ok: true, retryAfter: 0 };

    let b = buckets.get(userId);
    if (!b) {
        // Shed rather than evict when full. Safe here precisely because the key is a
        // server-issued user id: the map can only be filled by real accounts, so a full map
        // means a genuinely enormous org rather than an attack, and refusing to track a new
        // member is better than throttling one at random.
        if (buckets.size >= MAX_BUCKETS) return { ok: true, retryAfter: 0 };
        b = { minuteCount: 0, minuteStart: now, dayCount: 0, dayStart: now };
        buckets.set(userId, b);
    }

    if (now - b.minuteStart >= MINUTE_MS) { b.minuteCount = 0; b.minuteStart = now; }
    if (now - b.dayStart >= DAY_MS) { b.dayCount = 0; b.dayStart = now; }

    if (b.minuteCount >= USER_PER_MINUTE) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((b.minuteStart + MINUTE_MS - now) / 1000)) };
    }
    if (b.dayCount >= USER_PER_DAY) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((b.dayStart + DAY_MS - now) / 1000)) };
    }

    b.minuteCount += 1;
    b.dayCount += 1;
    return { ok: true, retryAfter: 0 };
}

/**
 * Drop buckets whose day window has fully elapsed.
 *
 * MUST be wired into the periodic sweep in server.ts. Two of the existing limiters
 * (submissions, radio) export a prune that production never calls — so their maps only grow, and
 * once full the shed-on-full branch permits everything for any untracked key. That is a broken
 * contract, and it is why this one is wired in the same change that adds it.
 */
export function pruneUserRateLimitBuckets(now: number = Date.now()): void {
    for (const [id, b] of buckets) {
        if (now - b.dayStart >= DAY_MS) buckets.delete(id);
    }
}

/** Test seam — the map is module state. */
export function __resetUserRateLimitForTest(): void {
    buckets.clear();
}
