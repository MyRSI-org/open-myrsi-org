import { describe, it, expect } from 'vitest';
import { adminActions } from '../api/actions/admin';
import { fullPermissionMap } from '../api/services';

// Danger-Zone DB destruction (red-team dbtools-1/2/3). Authorization is THREE
// independent server-side gates: the dispatcher perm (admin:db:destroy, not
// seeded to Dispatcher), the genuine Admin role, and a server-validated typed
// confirmation phrase. The typed phrase must never be a browser-only gate.

type Handler = (p: unknown) => Promise<unknown>;
const wipe = (adminActions as Record<string, Handler>)['admin:db:full_wipe'];
const reset = (adminActions as Record<string, Handler>)['admin:db:full_reset'];

describe('danger-zone permission gating', () => {
    it('full reset/wipe require the dedicated admin:db:destroy perm (not bare admin:access)', () => {
        expect(fullPermissionMap['admin:db:full_reset']).toBe('admin:db:destroy');
        expect(fullPermissionMap['admin:db:full_wipe']).toBe('admin:db:destroy');
    });
    // The map value is the FAMILY's high bar; the domain perm is re-asserted in the
    // handler (assertDomainResetPerm) so both bars apply. 'admin:' is not an
    // OPTIONAL_FEATURE_NAMESPACES prefix, so a domain perm alone was the only gate.
    it('domain resets sit on the family high bar in the map, with the domain perm in the handler', () => {
        expect(fullPermissionMap['admin:db:reset_finances']).toBe('admin:db:destroy');
        expect(fullPermissionMap['admin:db:reset_quartermaster']).toBe('admin:db:destroy');
    });
});

describe('danger-zone server-side role + phrase enforcement', () => {
    // The handler validates synchronously (before any DB await), so it throws
    // synchronously — never reaching the destructive RPC. assertDangerZone stays SYNC
    // for exactly that reason: it reads the stamped identity flag, never a query.
    it('rejects a non-Admin even with the correct phrase', () => {
        expect(() => wipe({ user: { role: 'Dispatcher' }, confirmPhrase: 'WIPE EVERYTHING' })).toThrow(/only an admin/i);
        expect(() => reset({ userId: 1, user: { role: 'Dispatcher' }, confirmPhrase: 'RESET' })).toThrow(/only an admin/i);
    });

    // ROLE NAME IS NOT AUTHORITY. `role` is inferred from the role row's free-text
    // name (lib/db/mappers.ts) and addRole had no reserved-name check, so a
    // permissionless custom role called 'Commander' — or literally 'admin' — passed
    // this gate and reached fullWipeOrg with the right phrase.
    it('rejects a forged Admin role NAME with the correct phrase, before the phrase check', () => {
        expect(() => wipe({ user: { role: 'Admin' }, confirmPhrase: 'WIPE EVERYTHING' })).toThrow(/only an admin/i);
        expect(() => reset({ userId: 1, user: { role: 'Admin' }, confirmPhrase: 'RESET' })).toThrow(/only an admin/i);
    });

    it('rejects a missing/undefined actor (fail closed)', () => {
        expect(() => wipe({ confirmPhrase: 'WIPE EVERYTHING' })).toThrow(/only an admin/i);
        expect(() => reset({ userId: 1, user: {}, confirmPhrase: 'RESET' })).toThrow(/only an admin/i);
    });

    it('rejects the stamped system Admin with the wrong/blank phrase (browser gate is not trusted)', () => {
        expect(() => wipe({ user: { isSystemAdmin: true }, confirmPhrase: 'wipe everything' })).toThrow(/confirmation phrase/i);
        expect(() => wipe({ user: { isSystemAdmin: true }, confirmPhrase: '' })).toThrow(/confirmation phrase/i);
        expect(() => reset({ userId: 1, user: { isSystemAdmin: true }, confirmPhrase: 'reset' })).toThrow(/confirmation phrase/i);
        expect(() => reset({ userId: 1, user: { isSystemAdmin: true } })).toThrow(/confirmation phrase/i);
    });
});
