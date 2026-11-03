// Constant-time string compare for secrets a caller submits to be checked against a
// stored value — the one-time admin setup code (api/actions/auth.ts) and the Special
// Operation join PIN (lib/db/ops.ts). A plain `===` returns as soon as a character
// differs, which leaks how much of a guess was right through response timing.
//
// Hashing first makes the compare length-independent: timingSafeEqual requires
// equal-length buffers and THROWS otherwise, and a length check before it would leak
// the stored value's length instead.
//
// Server-only (node:crypto). Lived in api/actions/auth.ts until the join PIN needed it
// from the db layer, which must not import from api/actions/**; auth.ts re-exports it so
// existing importers keep working.

import { timingSafeEqual, createHash } from 'node:crypto';

export function constantTimeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}
