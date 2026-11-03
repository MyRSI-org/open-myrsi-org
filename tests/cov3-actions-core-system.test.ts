import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// =============================================================================
// api/actions/system.ts — handler-level behaviour suite (coverage phase 3,
// unit actions-core). Pins: the public push-config projection (public key
// ONLY), location-search input coercion, API-key actor attribution, the EAM
// broadcast arg contract (no caller-chosen mention target beyond pingTarget),
// the permission-set gate on the EAM body fetch (the REAL hasAnyStaffViewPerm
// runs), and the setup/preflight passthroughs.
// =============================================================================

const h = vi.hoisted(() => ({
    db: {
        searchPlatformLocations: vi.fn(),
        createApiKey: vi.fn(),
        deleteApiKey: vi.fn(),
        listApiKeys: vi.fn(),
        broadcastEAM: vi.fn(),
        broadcastSystemAlert: vi.fn(),
        getActiveEam: vi.fn(),
        getPreflightStatus: vi.fn(),
        setSetupCompleted: vi.fn(),
    } as Record<string, Mock<(...args: any[]) => any>>,
}));
vi.mock('../lib/db', () => ({ ...h.db }));

import { systemActions } from '../api/actions/system';

type AnyHandler = (p?: any) => any;
const act = (name: string) => (systemActions as unknown as Record<string, AnyHandler>)[name];

const ENV_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const fn of Object.values(h.db)) fn.mockReset();
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe('system:get_push_config (PUBLIC action)', () => {
    it('returns the VAPID public key and nothing else — the private key never crosses the wire', async () => {
        process.env.VAPID_PUBLIC_KEY = 'BPublicKey123';
        process.env.VAPID_PRIVATE_KEY = 'PRIVATE-NEVER-SHIPPED';
        const out = await act('system:get_push_config')();
        expect(out).toEqual({ publicKey: 'BPublicKey123' });
        expect(JSON.stringify(out)).not.toContain('PRIVATE-NEVER-SHIPPED');
    });

    it('reports an unconfigured key as undefined rather than inventing one', async () => {
        delete process.env.VAPID_PUBLIC_KEY;
        await expect(act('system:get_push_config')()).resolves.toEqual({ publicKey: undefined });
    });
});

describe('system:search_locations — input coercion before the db query', () => {
    it('passes a well-formed search through, with starSystemId coerced to a number', () => {
        h.db.searchPlatformLocations.mockReturnValue([{ id: 1 }]);
        expect(act('system:search_locations')({ query: 'Lorville', kind: 'city', starSystemId: '12', limit: 5 })).toEqual([{ id: 1 }]);
        expect(h.db.searchPlatformLocations).toHaveBeenCalledWith({ query: 'Lorville', kind: 'city', starSystemId: 12, limit: 5 });
    });

    it('stringifies a numeric query and drops empty / non-numeric-typed optional filters', () => {
        act('system:search_locations')({ query: 42, kind: '', starSystemId: 0, limit: '50' });
        expect(h.db.searchPlatformLocations).toHaveBeenCalledWith({ query: '42', kind: undefined, starSystemId: undefined, limit: undefined });
    });

    it('an empty payload searches for the empty string with no filters', () => {
        act('system:search_locations')({});
        expect(h.db.searchPlatformLocations).toHaveBeenCalledWith({ query: '', kind: undefined, starSystemId: undefined, limit: undefined });
    });
});

describe('API keys', () => {
    it('api:create_key forwards label, scopes and expiry only', () => {
        h.db.createApiKey.mockReturnValue({ id: 'k1', key: 'shown-once' });
        expect(act('api:create_key')({ label: 'Feed', scopes: ['feed'], expiresAt: '2027-01-01T00:00:00.000Z', userId: 1 }))
            .toEqual({ id: 'k1', key: 'shown-once' });
        expect(h.db.createApiKey).toHaveBeenCalledWith('Feed', ['feed'], '2027-01-01T00:00:00.000Z');
    });

    it('api:delete_key attributes the revoke to the dispatcher-injected actor with the given reason', () => {
        act('api:delete_key')({ keyId: 'k1', reason: 'leaked', user: { id: 3 } });
        expect(h.db.deleteApiKey).toHaveBeenCalledWith('k1', 3, 'leaked');
    });

    it('api:delete_key defaults the reason to "operator" and the actor to null when absent', () => {
        act('api:delete_key')({ keyId: 'k2' });
        expect(h.db.deleteApiKey).toHaveBeenCalledWith('k2', null, 'operator');
        act('api:delete_key')({ keyId: 'k3', user: {} });
        expect(h.db.deleteApiKey).toHaveBeenLastCalledWith('k3', null, 'operator');
    });

    it('api:list_keys returns the db listing', () => {
        h.db.listApiKeys.mockReturnValue([{ id: 'k1', label: 'Feed' }]);
        expect(act('api:list_keys')({ userId: 1 })).toEqual([{ id: 'k1', label: 'Feed' }]);
        expect(h.db.listApiKeys).toHaveBeenCalledWith();
    });
});

describe('broadcasts', () => {
    it('broadcast:eam forwards the message and the loudness choice only', () => {
        act('broadcast:eam')({ message: 'All hands', pingTarget: 'here', roleId: '999', userId: 1 });
        expect(h.db.broadcastEAM).toHaveBeenCalledWith('All hands', 'here');
    });

    it('broadcast:eam without a pingTarget passes undefined (db layer defaults to none)', () => {
        act('broadcast:eam')({ message: 'Quiet' });
        expect(h.db.broadcastEAM.mock.calls[0]).toEqual(['Quiet', undefined]);
    });

    it('broadcast:alert forwards the message alone (no ping control on the alert path)', () => {
        act('broadcast:alert')({ message: 'Server restart', pingTarget: 'role' });
        expect(h.db.broadcastSystemAlert.mock.calls[0]).toEqual(['Server restart']);
    });
});

describe('broadcast:get_active_eam — the handler IS the gate (map entry is any-authenticated)', () => {
    it('serves a holder of user:receive:eam', () => {
        h.db.getActiveEam.mockReturnValue({ message: 'EAM body' });
        expect(act('broadcast:get_active_eam')({ user: { permissions: ['user:receive:eam'] } })).toEqual({ message: 'EAM body' });
    });

    it.each(['operations:view', 'user:view:roster', 'radio:manage', 'admin:access'])('serves a staff capability holder (%s)', (perm) => {
        act('broadcast:get_active_eam')({ user: { permissions: [perm] } });
        expect(h.db.getActiveEam).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a Client permission set', { permissions: ['request:create', 'request:cancel', 'request:rate'] }],
        ['an empty permission set', { permissions: [] }],
        ['a non-array permissions value', { permissions: 'user:receive:eam' }],
        ['no permissions field', {}],
        ['no user at all', undefined],
    ])('refuses %s and never reads the EAM body', (_label, user) => {
        expect(() => act('broadcast:get_active_eam')({ user }))
            .toThrow('Forbidden: EAM access requires a staff capability or user:receive:eam.');
        expect(h.db.getActiveEam).not.toHaveBeenCalled();
    });

    it('a permissionless custom role is refused regardless of its name', () => {
        expect(() => act('broadcast:get_active_eam')({ user: { role: 'Commander', permissions: [] } })).toThrow(/^Forbidden/);
    });
});

describe('first-run setup', () => {
    it('system:preflight returns the booleans-only preflight status', () => {
        h.db.getPreflightStatus.mockReturnValue({ discordConfigured: true, secretsKeySet: false });
        expect(act('system:preflight')()).toEqual({ discordConfigured: true, secretsKeySet: false });
        expect(h.db.getPreflightStatus).toHaveBeenCalledWith();
    });

    it('system:complete_setup marks onboarding complete', () => {
        h.db.setSetupCompleted.mockReturnValue({ success: true });
        expect(act('system:complete_setup')({ userId: 1 })).toEqual({ success: true });
        expect(h.db.setSetupCompleted).toHaveBeenCalledWith();
    });
});
