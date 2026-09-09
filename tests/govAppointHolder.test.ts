import { describe, it, expect, vi, beforeEach } from 'vitest';

// appointPositionHolder: appointee-existence guard (s4-8b — a permission-granting
// write on a non-forced client userId) + atomic max_holders appointment (race-2,
// via the gov_appoint_holder FOR UPDATE RPC) with a soft-fallback when the RPC
// isn't deployed yet.

const h = vi.hoisted(() => ({
    appointeeExists: true,
    // Default target seat: an ordinary appointed office with no apex powers.
    position: { max_holders: 5, fill_method: 'Appointed', can_veto_legislation: false, can_call_elections: false } as Record<string, unknown>,
    // Powers of the seat behind a holder being removed (G2 removePositionHolder gate).
    holderPosition: null as null | { can_veto_legislation?: boolean; can_call_elections?: boolean },
    rpcResult: { data: null as unknown, error: null as unknown },
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    // Inject a read fault on one table, to prove the apex gate fails CLOSED.
    errorFor: null as null | string,
    // When true the holder row itself is missing.
    holderMissing: false,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = () => b;
        }
        const data = () => {
            if (table === 'users') return h.appointeeExists ? { id: 1 } : null;
            if (table === 'government_positions') return h.position;
            // Superset row: flat holder fields for the appointment fetch + a `position`
            // embed for the removePositionHolder apex check.
            if (table === 'government_position_holders' && h.holderMissing) return null;
            if (table === 'government_position_holders') return { id: 50, position_id: 3, user_id: 1, appointed_by_id: 2, election_id: null, started_at: 't', ended_at: null, position: h.holderPosition };
            return null;
        };
        const fault = () => (h.errorFor === table ? { message: 'boom' } : null);
        b.single = () => { const e = fault(); return Promise.resolve(e ? { data: null, error: e } : { data: data(), error: null }); };
        b.maybeSingle = () => { const e = fault(); return Promise.resolve(e ? { data: null, error: e } : { data: data(), error: null }); };
        b.then = (r: any) => Promise.resolve({ data: data(), error: null, count: 0 }).then(r);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: (fn: string, args: unknown) => { h.rpcCalls.push({ fn, args }); return Promise.resolve(h.rpcResult); } },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, safeFetch: async () => [], getSystemRoles: async () => ({}),
    };
});

import { appointPositionHolder, removePositionHolder } from '../lib/db/government/structure';

beforeEach(() => {
    h.appointeeExists = true;
    h.position = { max_holders: 5, fill_method: 'Appointed', can_veto_legislation: false, can_call_elections: false };
    h.holderPosition = null; h.errorFor = null; h.holderMissing = false;
    h.rpcResult = { data: 50, error: null };
    h.rpcCalls = [];
});

describe('appointPositionHolder appointee guard (s4-8b)', () => {
    it('rejects a non-finite appointee id', async () => {
        await expect(appointPositionHolder({ userId: 1.5 as number, positionId: 3 })).rejects.toThrow(/invalid appointee/i);
    });
    it('rejects a non-existent / deleted appointee', async () => {
        h.appointeeExists = false;
        await expect(appointPositionHolder({ userId: 999, positionId: 3 })).rejects.toThrow(/not a valid member/i);
        expect(h.rpcCalls.length).toBe(0); // never reaches the appointment
    });
});

describe('appointPositionHolder atomic appointment (race-2)', () => {
    it('appoints via the gov_appoint_holder RPC for a valid member', async () => {
        const res = await appointPositionHolder({ userId: 1, positionId: 3, appointedById: 2 });
        expect(h.rpcCalls.some((c) => c.fn === 'gov_appoint_holder')).toBe(true);
        expect(res).toBeTruthy();
    });
    it('maps position_full / already_holds RPC errors', async () => {
        h.rpcResult = { data: null, error: { message: 'position_full' } };
        await expect(appointPositionHolder({ userId: 1, positionId: 3 })).rejects.toThrow(/position is full/i);
        h.rpcResult = { data: null, error: { message: 'already_holds' } };
        await expect(appointPositionHolder({ userId: 1, positionId: 3 })).rejects.toThrow(/already holds/i);
    });
    it('falls back to the non-atomic path when the RPC is not deployed', async () => {
        h.rpcResult = { data: null, error: { code: 'PGRST202', message: 'missing' } };
        const res = await appointPositionHolder({ userId: 1, positionId: 3 });
        expect(res).toBeTruthy(); // fallback insert path returns the mapped holder
    });
});

describe('appointPositionHolder authority ceiling (G2)', () => {
    it('refuses to hand-appoint an elected seat (must come through an election)', async () => {
        h.position = { max_holders: 1, fill_method: 'Elected', can_veto_legislation: true, can_call_elections: true };
        await expect(appointPositionHolder({ userId: 1, positionId: 3 }, { permissions: ['gov:manage'] }))
            .rejects.toThrow(/filled by elected, not by direct appointment/i);
        expect(h.rpcCalls.length).toBe(0);
    });

    it('refuses a non-admin appointing into an apex (veto/call-elections) appointed seat', async () => {
        h.position = { max_holders: 1, fill_method: 'Appointed', can_veto_legislation: false, can_call_elections: true };
        await expect(appointPositionHolder({ userId: 1, positionId: 3 }, { permissions: ['gov:manage'] }))
            .rejects.toThrow(/requires an administrator/i);
        expect(h.rpcCalls.length).toBe(0);
    });

    it('refuses the seeded Dispatcher (gov:manage + admin:access) — the apex carve-out is the Admin ROLE IDENTITY, not admin:access', async () => {
        h.position = { max_holders: 1, fill_method: 'Appointed', can_veto_legislation: true, can_call_elections: true };
        await expect(appointPositionHolder({ userId: 1, positionId: 3 }, { permissions: ['gov:manage', 'admin:access'] }))
            .rejects.toThrow(/requires an administrator/i);
        expect(h.rpcCalls.length).toBe(0);
    });

    // ROLE NAME IS NOT AUTHORITY. `role` is inferred from the role row's free-text
    // name (lib/db/mappers.ts), so a permissionless custom role called 'Commander'
    // arrived here as the Admin tier and could seat itself in a veto office.
    it('refuses an actor whose Admin tier comes from the role NAME (forged), with no stamped identity', async () => {
        h.position = { max_holders: 1, fill_method: 'Appointed', can_veto_legislation: true, can_call_elections: true };
        await expect(appointPositionHolder({ userId: 1, positionId: 3 }, { role: 'Admin', permissions: [] } as unknown as Parameters<typeof appointPositionHolder>[1]))
            .rejects.toThrow(/requires an administrator/i);
        expect(h.rpcCalls.length).toBe(0);
    });

    it('allows the stamped system Admin (role identity) to appoint into an apex appointed seat', async () => {
        h.position = { max_holders: 1, fill_method: 'Appointed', can_veto_legislation: true, can_call_elections: true };
        const res = await appointPositionHolder({ userId: 1, positionId: 3 }, { isSystemAdmin: true, permissions: [] });
        expect(h.rpcCalls.some((c) => c.fn === 'gov_appoint_holder')).toBe(true);
        expect(res).toBeTruthy();
    });

    it('exempts the election-conclusion path (electionId set) from the ceiling', async () => {
        // An elected apex seat being filled by its own concluded election must succeed
        // even though a manual appointment of the same seat would be refused.
        h.position = { max_holders: 1, fill_method: 'Elected', can_veto_legislation: true, can_call_elections: true };
        const res = await appointPositionHolder({ userId: 1, positionId: 3, electionId: 99 });
        expect(h.rpcCalls.some((c) => c.fn === 'gov_appoint_holder')).toBe(true);
        expect(res).toBeTruthy();
    });
});

describe('removePositionHolder apex gate (G2)', () => {
    it('refuses a non-admin removing the holder of an apex office', async () => {
        h.holderPosition = { can_veto_legislation: true, can_call_elections: false };
        await expect(removePositionHolder(50, 'removed', { permissions: ['gov:manage'] }))
            .rejects.toThrow(/requires an administrator/i);
    });

    it('refuses the seeded Dispatcher (gov:manage + admin:access) from removing an apex holder', async () => {
        h.holderPosition = { can_veto_legislation: false, can_call_elections: true };
        await expect(removePositionHolder(50, 'removed', { permissions: ['gov:manage', 'admin:access'] }))
            .rejects.toThrow(/requires an administrator/i);
    });

    it('refuses a forged Admin role NAME from removing an apex holder', async () => {
        h.holderPosition = { can_veto_legislation: true, can_call_elections: false };
        await expect(removePositionHolder(50, 'removed', { role: 'Admin', permissions: [] } as unknown as Parameters<typeof removePositionHolder>[2]))
            .rejects.toThrow(/requires an administrator/i);
    });

    it('allows removing the holder of an ordinary office', async () => {
        h.holderPosition = { can_veto_legislation: false, can_call_elections: false };
        await expect(removePositionHolder(50, 'removed', { permissions: ['gov:manage'] }))
            .resolves.toBeUndefined();
    });

    it('allows the stamped system Admin to remove an apex holder', async () => {
        h.holderPosition = { can_veto_legislation: true, can_call_elections: true };
        await expect(removePositionHolder(50, 'removed', { isSystemAdmin: true, permissions: [] }))
            .resolves.toBeUndefined();
    });
});

describe('the apex-office eviction guard FAILS CLOSED', () => {
    // The guard exists so a gov:manage holder cannot clear opposition out of the seats
    // that can veto legislation or call elections. It discarded its lookup error, so
    // any read fault produced holder = null -> pos = undefined -> the guard was skipped
    // entirely, and the eviction went through as an ordinary one. A check that switches
    // itself off on the blip that made it unverifiable is not a check.
    const NON_ADMIN = { id: 2, permissions: ['gov:manage'] } as never;

    it('refuses when the holder lookup errors, instead of skipping the check', async () => {
        h.errorFor = 'government_position_holders';
        await expect(removePositionHolder(50, 'reason', NON_ADMIN)).rejects.toThrow(/Failed to load position holder/i);
    });

    it('refuses when the holder row is missing', async () => {
        h.holderMissing = true;
        await expect(removePositionHolder(50, 'reason', NON_ADMIN)).rejects.toThrow(/not found/i);
    });

    it('refuses when the office behind the holder cannot be resolved', async () => {
        // A null position embed means "I could not tell whether this is an apex office",
        // which must never read as "it is not".
        h.holderPosition = null;
        await expect(removePositionHolder(50, 'reason', NON_ADMIN)).rejects.toThrow(/cannot verify which office/i);
    });

    it('still allows the ordinary case, so the guard is not just a wall', async () => {
        h.holderPosition = { can_veto_legislation: false, can_call_elections: false };
        await expect(removePositionHolder(50, 'reason', NON_ADMIN)).resolves.not.toThrow();
    });
});
