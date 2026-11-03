// @vitest-environment node
//
// Two tiny modules whose behaviour is fixed at IMPORT time from process.env, so each
// case stubs the env, resets the module registry and re-imports:
//
//   lib/publicId.ts  opaqueId() — the salted hash behind public org-page ids. There
//                    is deliberately NO baked-in salt: with neither PUBLIC_SALT nor
//                    JWT_SECRET it must throw rather than derive guessable ids.
//   lib/debugLog.ts  debugLog() — PII-bearing realtime payload logging that must be a
//                    no-op in production and console.log otherwise.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

const expected = (id: string | number, salt: string) =>
    createHash('sha256').update(`${id}::${salt}`).digest('hex').slice(0, 12);

async function loadOpaqueId(env: { PUBLIC_SALT?: string; JWT_SECRET?: string }) {
    vi.stubEnv('PUBLIC_SALT', env.PUBLIC_SALT ?? '');
    vi.stubEnv('JWT_SECRET', env.JWT_SECRET ?? '');
    vi.resetModules();
    return (await import('../lib/publicId')).opaqueId;
}

describe('opaqueId salt selection', () => {
    it('salts with PUBLIC_SALT when set, in preference to JWT_SECRET', async () => {
        const opaqueId = await loadOpaqueId({ PUBLIC_SALT: 'pub-salt', JWT_SECRET: 'jwt-secret' });
        expect(opaqueId(42)).toBe(expected(42, 'pub-salt'));
        expect(opaqueId(42)).not.toBe(expected(42, 'jwt-secret'));
    });

    it('falls back to JWT_SECRET when PUBLIC_SALT is unset or empty', async () => {
        const opaqueId = await loadOpaqueId({ JWT_SECRET: 'jwt-secret' });
        expect(opaqueId('abc')).toBe(expected('abc', 'jwt-secret'));
    });

    it('returns 12 lowercase hex chars and never echoes the internal id or the salt', async () => {
        const opaqueId = await loadOpaqueId({ PUBLIC_SALT: 'pub-salt' });
        const id = opaqueId(123456);
        expect(id).toMatch(/^[0-9a-f]{12}$/);
        expect(id).not.toContain('123456');
        expect(id).not.toContain('pub-salt');
    });

    it('maps a numeric id and its string form to the same opaque id', async () => {
        const opaqueId = await loadOpaqueId({ PUBLIC_SALT: 'pub-salt' });
        expect(opaqueId(7)).toBe(opaqueId('7'));
    });

    it('a different salt yields a different id for the same input (ids are deployment-specific)', async () => {
        const a = (await loadOpaqueId({ PUBLIC_SALT: 'salt-a' }))(1);
        const b = (await loadOpaqueId({ PUBLIC_SALT: 'salt-b' }))(1);
        expect(a).not.toBe(b);
    });

    it('fails closed with no salt at all — throws instead of deriving a guessable id', async () => {
        const opaqueId = await loadOpaqueId({});
        expect(() => opaqueId(1)).toThrow('PUBLIC_SALT or JWT_SECRET must be set to derive opaque public IDs.');
    });
});

describe('debugLog', () => {
    async function loadDebugLog(nodeEnv: string) {
        vi.stubEnv('NODE_ENV', nodeEnv);
        vi.resetModules();
        return (await import('../lib/debugLog')).debugLog;
    }

    it('is a silent no-op in a production build', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const debugLog = await loadDebugLog('production');
        expect(debugLog('realtime payload', { name: 'PII' })).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });

    it.each(['development', 'test'])('forwards every argument verbatim to console.log when NODE_ENV=%s', async (env) => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const debugLog = await loadDebugLog(env);
        const payload = { id: 1 };
        debugLog('event', payload, 3);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('event', payload, 3);
    });
});
