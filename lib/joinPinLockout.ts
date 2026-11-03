// Brute-force lockout for the Special Operation join PIN.
//
// WHY. The PIN is the ONLY gate on joining a Special Operation: operation:join and
// operation:join_with_role pass { isJoinAttempt: true }, which skips the participation
// gate (a first-time joiner is by definition not yet a participant). With no failure
// counter, a member could simply walk the PIN space.
//
// POLICY. At most JOIN_PIN_MAX_FAILURES wrong PINs per user + operation inside a rolling
// JOIN_PIN_WINDOW_MS. The failure that reaches the cap TRIPS the lockout, and for a full
// window after that every attempt for that user + op is refused — the CORRECT PIN
// included. Letting a correct PIN through a lockout would make the lockout decorative:
// the guesser keeps going and the one guess that "works" identifies itself. A correct
// PIN outside a lockout clears the counter. The caller refuses a locked attempt with the
// SAME copy (and the same status) as a wrong PIN, so the lockout is not an oracle for
// "now switch accounts".
//
// Keyed on the dispatcher-forced actor id (userId is in ACTOR_ID_FIELDS), never on a
// client-supplied one, so a caller cannot spend somebody else's attempts. The operation
// half must likewise be the CANONICAL id as read back from the database, never the
// request string: a uuid has many accepted spellings, and keying on the raw input would
// give each spelling its own budget (lib/db/ops.ts joinOperation passes the row's id).
//
// PER-PROCESS LIMITATION. The state is an in-memory Map: it is lost on restart and not
// shared between instances, so N instances behind a balancer allow up to N x the
// attempts per window, and a restart hands everyone a fresh budget. Accepted for a
// single-org deployment, where that is normally one process and the budget it bounds is
// tiny against a 6+ character PIN (lib/joinPinPolicy.ts). If the platform ever runs
// several instances in earnest, this wants a DB-backed counter.
//
// BOUNDED. At most JOIN_PIN_LOCKOUT_MAX_KEYS entries. When full, expired entries are
// pruned first; if it is still full, the least-recently-touched UNLOCKED entry is
// evicted, and only if every entry is an active lockout does the oldest lockout go.
// Filling it takes that many distinct user + op pairs with a failure inside one window,
// and every op in a pair must exist and be visible to the caller.
//
// Dependency-free (no db, no logger) so it is trivially testable; the security-event
// emit on a trip lives with the caller in lib/db/ops.ts.

export const JOIN_PIN_MAX_FAILURES = 5;
export const JOIN_PIN_WINDOW_MS = 15 * 60_000;
export const JOIN_PIN_LOCKOUT_MAX_KEYS = 10_000;

interface LockoutEntry {
    /** Timestamps of the failures still inside the window (at most MAX_FAILURES). */
    failures: number[];
    /** Epoch ms the lockout ends; 0 = not locked. */
    lockedUntil: number;
}

// Map iteration is insertion order; entries are re-inserted on every failure, so the
// first keys are always the least recently touched.
const entries = new Map<string, LockoutEntry>();

const keyOf = (userId: number, operationId: string) => `${userId}:${operationId}`;

function isLocked(e: LockoutEntry, now: number): boolean {
    return e.lockedUntil > now;
}

/** An entry that no longer constrains anything: lock elapsed, or every failure stale. */
function isExpired(e: LockoutEntry, now: number): boolean {
    if (e.lockedUntil !== 0) return e.lockedUntil <= now;
    return e.failures.every((t) => now - t >= JOIN_PIN_WINDOW_MS);
}

function makeRoom(now: number): void {
    if (entries.size < JOIN_PIN_LOCKOUT_MAX_KEYS) return;
    for (const [k, e] of entries) {
        if (isExpired(e, now)) entries.delete(k);
    }
    if (entries.size < JOIN_PIN_LOCKOUT_MAX_KEYS) return;
    for (const [k, e] of entries) {
        if (!isLocked(e, now)) { entries.delete(k); return; }
    }
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
}

/**
 * Is this user locked out of this operation's PIN right now? An elapsed lockout is
 * dropped here, so the next attempt starts with a fresh budget.
 */
export function isJoinPinLocked(userId: number, operationId: string, now: number = Date.now()): boolean {
    const key = keyOf(userId, operationId);
    const e = entries.get(key);
    if (!e) return false;
    if (isLocked(e, now)) return true;
    if (e.lockedUntil !== 0) entries.delete(key);
    return false;
}

/**
 * Record one wrong PIN. `lockedNow` is true for exactly the failure that TRIPPED the
 * lockout, so the caller can audit the trip once rather than every refused attempt.
 * A failure recorded against an already-locked entry neither extends nor re-trips it.
 */
export function recordJoinPinFailure(userId: number, operationId: string, now: number = Date.now()): { lockedNow: boolean } {
    const key = keyOf(userId, operationId);
    let e = entries.get(key);
    if (e && isLocked(e, now)) return { lockedNow: false };
    if (e && isExpired(e, now)) {
        entries.delete(key);
        e = undefined;
    }
    if (e) {
        entries.delete(key); // re-inserted below: refreshes its recency
    } else {
        makeRoom(now);
        e = { failures: [], lockedUntil: 0 };
    }
    e.failures = e.failures.filter((t) => now - t < JOIN_PIN_WINDOW_MS);
    e.failures.push(now);
    let lockedNow = false;
    if (e.failures.length >= JOIN_PIN_MAX_FAILURES) {
        e.lockedUntil = now + JOIN_PIN_WINDOW_MS;
        e.failures = [];
        lockedNow = true;
    }
    entries.set(key, e);
    return { lockedNow };
}

/** A correct PIN (outside a lockout) wipes the slate for that user + op. */
export function clearJoinPinFailures(userId: number, operationId: string): void {
    entries.delete(keyOf(userId, operationId));
}

/** Test seams. */
export function _resetJoinPinLockoutForTests(): void {
    entries.clear();
}
export function _joinPinLockoutSizeForTests(): number {
    return entries.size;
}
