// The Special Operation join PIN policy — the ONE definition of what a PIN must look
// like, shared by the server (lib/db/ops.ts, the enforcing check) and the operation
// create / edit forms (CreateOperationWizard, OpAdministerTab), whose check is only
// there to save a round-trip. Dependency-free on purpose so it compiles under both
// tsconfigs and is safe in the client bundle (no secrets, no server imports).
//
// WHY A FLOOR. The PIN is the only gate on joining a Special Operation — the join
// actions skip the participation gate (a first-time joiner is not yet a participant) —
// and the wizard used to suggest "e.g. 1234". Six characters with the per-user/per-op
// lockout in lib/joinPinLockout.ts puts walking the space out of reach; the ceiling
// only bounds what an attacker-reachable write can store.
//
// Length only, no charset rule: the owner decision was a 6-character minimum, and
// letters / symbols ADD entropy, so refusing them would only push operators back
// towards digits.

export const JOIN_PIN_MIN_LENGTH = 6;
export const JOIN_PIN_MAX_LENGTH = 64;

export type JoinPinValidation = { ok: true; pin: string } | { ok: false; error: string };

/**
 * Validate a PIN being SET (create, or an edit that changes it). Trims first — the
 * stored value is the trimmed one, and the join compare trims too, so surrounding
 * whitespace is neither entropy nor a way to sneak under the floor.
 */
export function validateJoinPin(raw: unknown): JoinPinValidation {
    const pin = typeof raw === 'string' ? raw.trim() : '';
    if (pin.length < JOIN_PIN_MIN_LENGTH) {
        return { ok: false, error: `Special Operations require a join PIN of at least ${JOIN_PIN_MIN_LENGTH} characters.` };
    }
    if (pin.length > JOIN_PIN_MAX_LENGTH) {
        return { ok: false, error: `The join PIN must be at most ${JOIN_PIN_MAX_LENGTH} characters.` };
    }
    return { ok: true, pin };
}
