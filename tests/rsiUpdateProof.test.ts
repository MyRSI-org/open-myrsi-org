import { describe, it, expect, vi, beforeEach } from 'vitest';

// F1: the self-service RSI re-verify path (user:verify_rsi_update -> verifyRsiUpdate)
// must PROVE the caller controls the RSI profile before it stamps rsi_verified=true.
// Before the fix it flipped the flag unconditionally, so any account could bind any
// handle (incl. a victim's) and absorb that handle's ad-hoc service requests.
//
// Also: initiateRsiHandleUpdate must reject a value that is not shaped like a citizen
// handle BEFORE it lands in rsi_handle_pending, which verifyRsiUpdate promotes into
// rsi_handle and feeds to two .ilike() identity lookups on the way.

const h = vi.hoisted(() => ({
    pending: 'VictimHandle' as string | null,
    code: 'MYRSI-abcdefghij' as string | null,
    handleTaken: false,
    proofOk: true,
    updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

// Only the network proof and the CSPRNG code are stubbed — the REAL isValidRsiHandle
// stays in play, since the shape guard is part of what is under test here.
vi.mock('../lib/rsi', async () => ({
    ...(await vi.importActual<typeof import('../lib/rsi')>('../lib/rsi')),
    verifyRsiHandle: vi.fn(async () => h.proofOk),
    generateRsiVerificationCode: () => 'MYRSI-generated-code',
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { sel: '', op: 'select', values: null as Record<string, unknown> | null };
        const b: any = {};
        b.select = (s: unknown) => { state.sel = String(s || ''); return b; };
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; state.values = v; return b; };
        b.eq = () => b; b.is = () => b; b.in = () => b; b.neq = () => b; b.ilike = () => b; b.order = () => b; b.limit = () => b;
        const settle = () => {
            if (state.op === 'update') { h.updates.push({ table, values: state.values! }); return Promise.resolve({ data: null, error: null }); }
            if (table === 'users') {
                if (state.sel.includes('rsi_handle_pending')) {
                    return Promise.resolve({ data: { rsi_handle_pending: h.pending, rsi_verification_code: h.code }, error: null });
                }
                // The handle-uniqueness lookup (select 'id').
                return Promise.resolve({ data: h.handleTaken ? { id: 999 } : null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle(); b.maybeSingle = () => settle();
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});
vi.mock('../lib/db/system', () => ({ getAllSettings: async () => ({}) }));
vi.mock('../lib/discord', () => ({ getDiscordMember: async () => null, pushDiscordRolesForUser: async () => undefined, getDiscordUserById: async () => null, buildGlobalAvatarUrl: () => '' }));
vi.mock('../lib/push', () => ({ isAllowedPushEndpoint: () => true, MAX_PUSH_SUBSCRIPTIONS_PER_USER: 10 }));

import { verifyRsiUpdate, initiateRsiHandleUpdate } from '../lib/db/users';
import { verifyRsiHandle } from '../lib/rsi';

beforeEach(() => {
    h.pending = 'VictimHandle'; h.code = 'MYRSI-abcdefghij';
    h.handleTaken = false; h.proofOk = true; h.updates = [];
    vi.mocked(verifyRsiHandle).mockClear();
});

describe('verifyRsiUpdate ownership proof (F1)', () => {
    it('flips rsi_verified only after proving control of the RSI profile', async () => {
        await verifyRsiUpdate(7);
        expect(verifyRsiHandle).toHaveBeenCalledWith('VictimHandle', 'MYRSI-abcdefghij');
        const u = h.updates.find(u => u.table === 'users');
        expect(u?.values).toMatchObject({ rsi_verified: true, rsi_handle: 'VictimHandle' });
    });

    it('refuses (no verified flip) when the code is absent from the RSI profile', async () => {
        h.proofOk = false;
        await expect(verifyRsiUpdate(7)).rejects.toThrow(/could not find your verification code/i);
        expect(h.updates.find(u => u.table === 'users')).toBeUndefined();
    });

    it('refuses when the handle is already linked to another live account', async () => {
        h.handleTaken = true;
        await expect(verifyRsiUpdate(7)).rejects.toThrow(/already linked/i);
        expect(h.updates.find(u => u.table === 'users')).toBeUndefined();
    });

    it('refuses, without any network proof attempt, when there is no pending verification', async () => {
        h.pending = null;
        await expect(verifyRsiUpdate(7)).rejects.toThrow(/no pending verification/i);
        expect(verifyRsiHandle).not.toHaveBeenCalled();
    });
});

describe('initiateRsiHandleUpdate shape guard', () => {
    it('refuses a LIKE-metacharacter handle before it reaches rsi_handle_pending', async () => {
        // '%' would be a wildcard, not a name, in the .ilike() identity lookups
        // verifyRsiUpdate runs on promotion.
        await expect(initiateRsiHandleUpdate(7, '%')).rejects.toThrow(/valid RSI handle/i);
        expect(h.updates).toHaveLength(0);
    });

    it('refuses an over-long handle', async () => {
        await expect(initiateRsiHandleUpdate(7, 'a'.repeat(61))).rejects.toThrow(/valid RSI handle/i);
        expect(h.updates).toHaveLength(0);
    });

    it('stores a well-formed handle with a freshly minted code', async () => {
        await expect(initiateRsiHandleUpdate(7, 'Valid_Handle-1')).resolves.toEqual({ code: 'MYRSI-generated-code' });
        expect(h.updates[0]?.values).toMatchObject({
            rsi_handle_pending: 'Valid_Handle-1',
            rsi_verification_code: 'MYRSI-generated-code',
        });
    });
});
