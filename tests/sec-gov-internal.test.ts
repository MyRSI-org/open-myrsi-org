import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

// The secret-ballot voter hash must be a KEYED HMAC using a server-held secret,
// not a bare SHA-256 of `${id}:${userId}`. With small, enumerable integer inputs
// an unkeyed digest is trivially brute-forced from a DB-only leak of voter_hash,
// de-anonymizing every "secret" ballot. These tests check: (1) determinism per
// secret (one-vote guards still work), (2) divergence from plain SHA-256,
// (3) secret-dependence, and (4) fail-closed when no server secret is configured.

// internal.ts imports lib/db/common (→ supabaseServer). computeVoterHash never
// touches the DB, so stub the data layer out of the import graph.
vi.mock('../lib/db/common', () => ({
    supabase: { from: () => ({}), rpc: () => Promise.resolve({ data: null, error: null }) },
    handleSupabaseError: () => {},
    broadcastToOrg: () => {},
    broadcastToChannel: () => {},
    safeFetch: async () => null,
}));

import { computeVoterHash } from '../lib/db/government/internal';

const ELECTION_ID = 7;
const USER_ID = 42;

// Save/restore the secret env vars so these tests cannot leak state into others.
let savedSecretsKey: string | undefined;
let savedJwtSecret: string | undefined;

beforeEach(() => {
    savedSecretsKey = process.env.SECRETS_ENCRYPTION_KEY;
    savedJwtSecret = process.env.JWT_SECRET;
});

afterEach(() => {
    if (savedSecretsKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedSecretsKey;
    if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwtSecret;
});

describe('computeVoterHash (secret-ballot anonymization)', () => {
    it('is deterministic per secret so the one-vote guards still trip', () => {
        process.env.SECRETS_ENCRYPTION_KEY = 'pepper-A';
        const a = computeVoterHash(ELECTION_ID, USER_ID);
        const b = computeVoterHash(ELECTION_ID, USER_ID);
        expect(a).toBe(b);
        // Distinct (id, user) pairs still produce distinct hashes.
        expect(computeVoterHash(ELECTION_ID, USER_ID)).not.toBe(computeVoterHash(ELECTION_ID, USER_ID + 1));
        expect(computeVoterHash(ELECTION_ID, USER_ID)).not.toBe(computeVoterHash(ELECTION_ID + 1, USER_ID));
    });

    it('does NOT equal an unkeyed SHA-256 of the message', () => {
        process.env.SECRETS_ENCRYPTION_KEY = 'pepper-A';
        const plain = createHash('sha256').update(`${ELECTION_ID}:${USER_ID}`).digest('hex');
        // A bare digest of the message would equal `plain`; the keyed HMAC must not.
        expect(computeVoterHash(ELECTION_ID, USER_ID)).not.toBe(plain);
    });

    it('equals HMAC-SHA256 keyed by the server secret', () => {
        process.env.SECRETS_ENCRYPTION_KEY = 'pepper-A';
        const expected = createHmac('sha256', 'pepper-A').update(`${ELECTION_ID}:${USER_ID}`).digest('hex');
        expect(computeVoterHash(ELECTION_ID, USER_ID)).toBe(expected);
    });

    it('is secret-dependent: changing the server secret changes every ballot hash', () => {
        process.env.SECRETS_ENCRYPTION_KEY = 'pepper-A';
        const withA = computeVoterHash(ELECTION_ID, USER_ID);
        process.env.SECRETS_ENCRYPTION_KEY = 'pepper-B';
        const withB = computeVoterHash(ELECTION_ID, USER_ID);
        expect(withA).not.toBe(withB);
    });

    it('prefers SECRETS_ENCRYPTION_KEY over JWT_SECRET, falling back to JWT_SECRET', () => {
        // Fallback path: only JWT_SECRET present.
        delete process.env.SECRETS_ENCRYPTION_KEY;
        process.env.JWT_SECRET = 'jwt-key';
        expect(computeVoterHash(ELECTION_ID, USER_ID)).toBe(
            createHmac('sha256', 'jwt-key').update(`${ELECTION_ID}:${USER_ID}`).digest('hex'),
        );
        // Preference path: SECRETS_ENCRYPTION_KEY wins when both are set.
        process.env.SECRETS_ENCRYPTION_KEY = 'pepper-A';
        expect(computeVoterHash(ELECTION_ID, USER_ID)).toBe(
            createHmac('sha256', 'pepper-A').update(`${ELECTION_ID}:${USER_ID}`).digest('hex'),
        );
    });

    it('fails closed when no server secret is configured (never an unkeyed digest)', () => {
        delete process.env.SECRETS_ENCRYPTION_KEY;
        delete process.env.JWT_SECRET;
        expect(() => computeVoterHash(ELECTION_ID, USER_ID)).toThrow(/SECRETS_ENCRYPTION_KEY|JWT_SECRET/);
    });
});
