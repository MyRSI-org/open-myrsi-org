import { describe, it, expect, beforeEach, vi } from 'vitest';

// The radio action handlers invoke the per-user throttle (keyed on the
// server-injected user id) before proxying to the metered LiveKit API, and a
// throttle rejection blocks the proxy call. The limiter logic itself is in
// tests/radioRateLimit.test.ts; here we mock the token generators and the
// throttle to verify the wiring and ordering.

const spies = vi.hoisted(() => ({
    generateRadioToken: vi.fn(),
    generateOpRadioToken: vi.fn(),
    getRadioStatus: vi.fn(),
    assertRadioRateLimit: vi.fn(),
}));

vi.mock('../lib/radio', () => ({
    generateRadioToken: spies.generateRadioToken,
    generateOpRadioToken: spies.generateOpRadioToken,
    getRadioStatus: spies.getRadioStatus,
    assertRadioRateLimit: spies.assertRadioRateLimit,
}));
// auth.ts pulls these in at module scope; none are touched by the radio handlers.
vi.mock('../lib/db', () => ({ supabase: {}, findUserByDiscordId: vi.fn(), createUser: vi.fn() }));
vi.mock('../lib/discord', () => ({}));
vi.mock('../lib/auth', () => ({ signToken: vi.fn(), signAdminSetupGrant: vi.fn(), verifyAdminSetupGrant: vi.fn() }));
// Spread the real module so the action layer's isValidRsiHandle import resolves; only
// the outbound proof is stubbed (nothing here reaches it).
vi.mock('../lib/rsi', async () => ({
    ...(await vi.importActual<typeof import('../lib/rsi')>('../lib/rsi')),
    verifyRsiHandle: vi.fn(),
}));
vi.mock('../lib/db/userFilters', () => ({ stripSensitiveUserFields: vi.fn() }));
vi.mock('../lib/firstBoot', () => ({ adminExists: vi.fn() }));

import { authActions } from '../api/actions/auth';

type Handler = (p: unknown) => unknown;
// async wrapper so a synchronous throw inside a handler (the throttle / auth check
// throw before the proxy promise exists) surfaces as a rejected promise.
const call = async (name: string, p: unknown) => (authActions as Record<string, Handler>)[name](p);
const user = { id: 7, role: 'Member', permissions: [] as string[] };

describe('radio handlers throttle per-user before proxying to LiveKit', () => {
    beforeEach(() => {
        spies.generateRadioToken.mockReset().mockResolvedValue({ token: 't', url: 'wss://x' });
        spies.generateOpRadioToken.mockReset().mockResolvedValue({ token: 't', url: 'wss://x', roomName: 'r' });
        spies.getRadioStatus.mockReset().mockResolvedValue({ activeChannels: [] });
        spies.assertRadioRateLimit.mockReset();
    });

    it('radio:auth calls assertRadioRateLimit with the server-injected user id', async () => {
        await call('radio:auth', { roomName: 'radio-1', user });
        expect(spies.assertRadioRateLimit).toHaveBeenCalledWith(7);
        expect(spies.generateRadioToken).toHaveBeenCalled();
    });

    it('radio:op_auth calls assertRadioRateLimit with the server-injected user id', async () => {
        await call('radio:op_auth', { operationId: 'op-1', user });
        expect(spies.assertRadioRateLimit).toHaveBeenCalledWith(7);
        expect(spies.generateOpRadioToken).toHaveBeenCalled();
    });

    it('radio:status calls assertRadioRateLimit with the user id', async () => {
        await call('radio:status', { user });
        expect(spies.assertRadioRateLimit).toHaveBeenCalledWith(7);
        expect(spies.getRadioStatus).toHaveBeenCalled();
    });

    it('a throttle rejection blocks the LiveKit proxy call (fails closed)', async () => {
        spies.assertRadioRateLimit.mockImplementation(() => { throw new Error('Radio request limit reached'); });
        await expect(call('radio:auth', { roomName: 'radio-1', user })).rejects.toThrow(/limit reached/i);
        expect(spies.generateRadioToken).not.toHaveBeenCalled();

        await expect(call('radio:op_auth', { operationId: 'op-1', user })).rejects.toThrow(/limit reached/i);
        expect(spies.generateOpRadioToken).not.toHaveBeenCalled();

        await expect(call('radio:status', { user })).rejects.toThrow(/limit reached/i);
        expect(spies.getRadioStatus).not.toHaveBeenCalled();
    });

    it('still rejects an unauthenticated radio:auth / radio:op_auth caller (auth check intact)', async () => {
        await expect(call('radio:auth', { roomName: 'radio-1' })).rejects.toThrow(/Unauthorized/);
        await expect(call('radio:op_auth', { operationId: 'op-1' })).rejects.toThrow(/Unauthorized/);
        // The throttle is not consulted before auth fails — no bucket churn for anon spray.
        expect(spies.assertRadioRateLimit).not.toHaveBeenCalled();
    });
});
