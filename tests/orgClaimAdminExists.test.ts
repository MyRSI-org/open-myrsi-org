import { describe, it, expect, vi, beforeEach } from 'vitest';

// L4 pinning: once an Admin exists, the setup-code paths (org:claim,
// auth:redeem_setup_code) must refuse self-promotion BEFORE validating/consuming
// the code — closing the "any authed user redeems a lingering setup code to
// become Admin" escalation. Pins the adminExists() short-circuit wiring.

const spies = vi.hoisted(() => ({ adminExists: vi.fn(), validateNote: vi.fn() }));
vi.mock('../lib/firstBoot', () => ({ adminExists: spies.adminExists }));
vi.mock('../lib/db', () => ({
    // org:claim looks up the acting user first; settings table is only touched by
    // validateClaimCode, which must NOT run once adminExists() short-circuits.
    supabase: {
        from: (t: string) => ({
            select: () => ({ eq: () => ({ single: async () => ({ data: { id: 6 }, error: null }), maybeSingle: async () => { spies.validateNote(t); return { data: null, error: null }; } }) }),
        }),
    },
    getSystemRoles: async () => ({ admin: { id: 4 } }),
}));
vi.mock('../lib/discord', () => ({}));
vi.mock('../lib/radio', () => ({}));

import { authActions } from '../api/actions/auth';

const call = (action: string, p: unknown) => (authActions as Record<string, (x: unknown) => Promise<unknown>>)[action](p);

beforeEach(() => { spies.adminExists.mockReset(); spies.validateNote.mockReset(); });

describe('setup-code self-promotion block (L4)', () => {
    it('org:claim refuses once an admin exists (before consuming the code)', async () => {
        spies.adminExists.mockResolvedValue(true);
        await expect(call('org:claim', { code: 'SETUP-x', userId: 6 })).rejects.toThrow(/administrator already exists/i);
        expect(spies.validateNote).not.toHaveBeenCalled(); // never reached the settings/code lookup
    });
    it('auth:redeem_setup_code refuses once an admin exists', async () => {
        spies.adminExists.mockResolvedValue(true);
        await expect(call('auth:redeem_setup_code', { discordId: 'd1', code: 'SETUP-x' })).rejects.toThrow(/administrator already exists/i);
    });
    it('auth:redeem_setup_code requires a proven OAuth identity token', async () => {
        // No admin yet, but no/invalid identityToken → no admin-setup grant is minted
        // for an unproven Discord id, and the setup code is never consumed.
        spies.adminExists.mockResolvedValue(false);
        await expect(call('auth:redeem_setup_code', { discordId: 'd1', code: 'SETUP-x' })).rejects.toThrow(/sign-in session has expired/i);
        expect(spies.validateNote).not.toHaveBeenCalled();
    });
});
