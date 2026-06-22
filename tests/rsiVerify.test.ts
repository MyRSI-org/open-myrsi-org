import { describe, it, expect } from 'vitest';
import { verifyRsiHandle, generateRsiVerificationCode } from '../lib/rsi';

// RSI handle verification hardening: the code is server-issued and high-entropy, and
// a too-short code is rejected before any network call so a short substring of a
// victim's public profile can't satisfy the check.
describe('RSI verification hardening', () => {
    it('generateRsiVerificationCode is prefixed, long, and non-repeating', () => {
        const a = generateRsiVerificationCode();
        const b = generateRsiVerificationCode();
        expect(a).toMatch(/^MYRSI-/);
        expect(a.length).toBeGreaterThanOrEqual(14);
        expect(a).not.toBe(b);
    });

    it('verifyRsiHandle rejects a too-short / empty code without making a network call', async () => {
        // No fetch stub is installed: if the length guard did not fire first, this
        // would attempt a real network request. A short code returns false at once.
        await expect(verifyRsiHandle('SomeHandle', 'a')).resolves.toBe(false);
        await expect(verifyRsiHandle('SomeHandle', '')).resolves.toBe(false);
        await expect(verifyRsiHandle('SomeHandle', 'short')).resolves.toBe(false);
    });
});
