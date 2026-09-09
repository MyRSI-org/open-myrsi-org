import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression for the privilege-escalation finding: a non-Admin holder of
// admin:config:roles could grant admin:access to their own role and become
// Admin. These cover the guard's pre-DB branches (Admin escape, amplification,
// missing actor); the tier-ceiling branch is exercised against a live DB.
//
// The Admin escape is ROLE IDENTITY (actor.roleId === getSystemRoles().admin.id),
// not the role NAME. The name compare it replaces closed the escalation LOOP:
// mint a permissionless role called 'Commander' → assign it to yourself → the
// mapper resolves you to the Admin tier → skip both guards → grant that role every
// permission.

const h = vi.hoisted(() => ({
    systemRoles: {
        client: { id: 1, name: 'Client' },
        member: { id: 2, name: 'Member' },
        dispatcher: { id: 3, name: 'Dispatcher' },
        admin: { id: 4, name: 'Admin' },
    } as Record<string, { id: number; name: string } | undefined>,
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = () => b;
        }
        const settle = () => Promise.resolve({ data: null, error: null });
        b.single = settle;
        b.maybeSingle = settle;
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: () => builder(), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        getSystemRoles: async () => h.systemRoles,
    };
});

import { assertCanManageRolePermissions } from '../lib/db/users';

beforeEach(() => {
    h.systemRoles = {
        client: { id: 1, name: 'Client' },
        member: { id: 2, name: 'Member' },
        dispatcher: { id: 3, name: 'Dispatcher' },
        admin: { id: 4, name: 'Admin' },
    };
});

describe('assertCanManageRolePermissions — privilege ceiling', () => {
    it('allows the actor holding the system Admin ROLE ID (full control)', async () => {
        await expect(assertCanManageRolePermissions(
            { id: 1, roleId: 4, permissions: [] } as any,
            3, ['admin:access'],
        )).resolves.toBeUndefined();
    });

    // The escalation loop's first move. `role` is inferred from the role row's
    // free-text NAME, so a custom role called 'Commander' (or literally 'admin')
    // used to take the escape above with zero permissions.
    it('does NOT allow an actor whose Admin tier comes from the role NAME', async () => {
        await expect(assertCanManageRolePermissions(
            { id: 1, role: 'Admin', roleId: 9, permissions: [] } as any,
            9, ['admin:access'],
        )).rejects.toThrow(/cannot grant permissions you do not hold/i);
    });

    // Fail closed: if getSystemRoles cannot resolve the Admin slot, nobody gets the
    // escape — a withheld bypass, never a granted one.
    it('withholds the escape when the Admin slot is unresolved (fail closed)', async () => {
        h.systemRoles = { client: { id: 1, name: 'Client' } };
        await expect(assertCanManageRolePermissions(
            { id: 1, roleId: 4, permissions: [] } as any,
            3, ['admin:access'],
        )).rejects.toThrow(/cannot grant permissions you do not hold/i);
    });

    it('blocks a non-Admin from granting a permission they do not hold', async () => {
        await expect(assertCanManageRolePermissions(
            { id: 2, roleId: 3, permissions: ['warrant:view', 'admin:config:roles'] } as any,
            99, ['admin:access'],
        )).rejects.toThrow(/cannot grant permissions you do not hold/i);
    });

    it('rejects when actor identity is missing', async () => {
        await expect(assertCanManageRolePermissions(null, 3, []))
            .rejects.toThrow(/actor identity/i);
    });
});
