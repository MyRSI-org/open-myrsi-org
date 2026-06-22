import { describe, it, expect, vi, beforeEach } from 'vitest';

// The auth:discord_callback admin-claim branch (state.startsWith('admin_setup:'))
// enforces the same adminExists() short-circuit as its sibling claim paths, so a
// lingering OAuth-state setup code cannot self-promote a second admin once one
// exists. The guard runs before validateClaimCode (the code is never consumed)
// and fails closed (a DB error there also denies the claim).

const spies = vi.hoisted(() => ({
    adminExists: vi.fn(),
    validateNote: vi.fn(),       // fires only if validateClaimCode reaches the settings lookup
    signAdminSetupGrant: vi.fn(() => 'GRANT'),
}));

vi.mock('../lib/firstBoot', () => ({ adminExists: spies.adminExists }));
vi.mock('../lib/auth', () => ({
    signToken: () => 'tok',
    // If this is ever called for the admin-claim path, an admin grant leaked.
    signAdminSetupGrant: spies.signAdminSetupGrant,
    verifyAdminSetupGrant: () => null,
    signIdentityGrant: () => 'IDENTITY',
    verifyIdentityGrant: () => null,
}));
vi.mock('../lib/rsi', () => ({ verifyRsiHandle: async () => true, generateRsiVerificationCode: () => 'MYRSI-test' }));
vi.mock('../lib/db/userFilters', () => ({ stripSensitiveUserFields: (u: unknown) => u }));
const DISCORD_ID = '123456789012345678'; // valid numeric snowflake
vi.mock('../lib/discord', () => ({
    exchangeCodeForToken: async () => ({ access_token: 'at' }),
    getDiscordUser: async () => ({ id: '123456789012345678', username: 'newbie', global_name: 'Newbie' }),
    buildGlobalAvatarUrl: () => 'https://cdn/avatar.png',
}));
vi.mock('../lib/radio', () => ({}));
vi.mock('../lib/db', () => ({
    // settings table is only touched by validateClaimCode; validateNote fires when
    // its select reaches the settings lookup, proving the adminExists()
    // short-circuit ran before the code was validated.
    supabase: {
        from: (t: string) => ({
            select: () => ({
                eq: () => ({
                    // valid, non-rate-limited code so the first-admin happy path can proceed
                    maybeSingle: async () => { spies.validateNote(t); return { data: { value: { code: 'SETUP-x', failed_attempts: 0 } }, error: null }; },
                }),
            }),
            // Atomic consume: delete().eq().select() returns the consumed row to
            // the winning caller (validateClaimCode treats 0 rows as already-claimed).
            delete: () => ({ eq: () => ({ select: async () => ({ data: [{ key: 'admin_setup_code' }], error: null }) }) }),
        }),
    },
    // A new user — proceeds to mint the adminSetupToken only if the guard passed.
    findUserByDiscordId: async () => null,
}));

import { authActions } from '../api/actions/auth';

const call = (action: string, p: unknown) => (authActions as Record<string, (x: unknown) => Promise<unknown>>)[action](p);

beforeEach(() => {
    spies.adminExists.mockReset();
    spies.validateNote.mockReset();
    spies.signAdminSetupGrant.mockReset();
    spies.signAdminSetupGrant.mockReturnValue('GRANT');
});

describe('auth:discord_callback admin-claim adminExists short-circuit', () => {
    it('refuses the admin claim once an admin exists, before consuming the setup code', async () => {
        spies.adminExists.mockResolvedValue(true);
        await expect(
            call('auth:discord_callback', { code: 'oauth-code', state: 'admin_setup:SETUP-x', redirectUri: 'https://app/cb' }),
        ).rejects.toThrow(/administrator already exists/i);
        // The guard runs before validateClaimCode: the code is never validated/consumed
        expect(spies.validateNote).not.toHaveBeenCalled();
        // and no admin setup grant is ever minted.
        expect(spies.signAdminSetupGrant).not.toHaveBeenCalled();
    });

    it('still mints the admin grant for the first admin (no admin yet)', async () => {
        spies.adminExists.mockResolvedValue(false);
        const res = await call('auth:discord_callback', {
            code: 'oauth-code', state: 'admin_setup:SETUP-x', redirectUri: 'https://app/cb',
        }) as { isNewUser: boolean; user: { isAdminSetup: boolean }; adminSetupToken?: string };
        expect(res.isNewUser).toBe(true);
        expect(res.user.isAdminSetup).toBe(true);
        expect(res.adminSetupToken).toBe('GRANT');
        expect(spies.signAdminSetupGrant).toHaveBeenCalledWith(DISCORD_ID);
    });
});

describe('auth:discord_callback rejects a malformed Discord id (filter-injection guard)', () => {
    it('throws when Discord returns a non-numeric id (would otherwise hit a string-built .or() filter)', async () => {
        spies.adminExists.mockResolvedValue(false);
        const discord = await import('../lib/discord');
        const spy = vi.spyOn(discord, 'getDiscordUser').mockResolvedValue({ id: 'evil.id,auth_user_id.neq.1', username: 'x' } as never);
        await expect(
            call('auth:discord_callback', { code: 'oauth-code', state: '', redirectUri: 'https://app/cb' }),
        ).rejects.toThrow(/unexpected account id/i);
        spy.mockRestore();
    });
});
