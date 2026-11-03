// @vitest-environment node
//
// lib/supabaseServer.ts — the service-role Supabase client every server read/write
// goes through, plus handleSupabaseError.
//
//   - Boot guard: with SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing the module
//     must refuse to load (no half-configured client).
//   - Dispatch: requests go through undici's OWN fetch with the pinned pooled Agent
//     (mixing the npm undici Agent with Node's global fetch throws at request time),
//     with HTTP/2 disabled.
//   - handleSupabaseError: schema detail (PG codes, column / constraint names) is
//     LOGGED, and only the caller's high-level message is thrown toward the client.
//
// undici is mocked so no socket is ever opened; each case re-imports the module
// under a stubbed env.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const u = vi.hoisted(() => ({
    agentOptions: [] as unknown[],
    agents: [] as unknown[],
    fetchCalls: [] as Array<{ url: string; init: Record<string, any> }>,
    respond: (() => new Response('[]')) as () => Response,
}));

const okResponse = () => new Response(JSON.stringify([{ id: 7 }]), { status: 200, headers: { 'content-type': 'application/json' } });

vi.mock('undici', () => {
    class Agent {
        constructor(opts: unknown) {
            u.agentOptions.push(opts);
            u.agents.push(this);
        }
    }
    return {
        Agent,
        fetch: async (input: unknown, init: Record<string, any>) => {
            const url = input instanceof URL ? input.href : typeof input === 'string' ? input : (input as Request).url;
            u.fetchCalls.push({ url, init });
            return u.respond();
        },
    };
});

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    u.agentOptions.length = 0;
    u.agents.length = 0;
    u.fetchCalls.length = 0;
    u.respond = okResponse;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
});

async function load(env: { url?: string; key?: string; logLevel?: string } = {}) {
    vi.stubEnv('SUPABASE_URL', env.url ?? 'http://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', env.key ?? 'service-role-test-key');
    vi.stubEnv('LOG_LEVEL', env.logLevel ?? 'silent');
    vi.resetModules();
    return import('../lib/supabaseServer');
}

describe('boot guard', () => {
    it('refuses to load without SUPABASE_URL', async () => {
        await expect(load({ url: '' })).rejects.toThrow(
            'Supabase environment variables SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.',
        );
        expect(u.agents).toHaveLength(0);
    });

    it('refuses to load without SUPABASE_SERVICE_ROLE_KEY', async () => {
        await expect(load({ key: '' })).rejects.toThrow(
            'Supabase environment variables SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.',
        );
        expect(u.agents).toHaveLength(0);
    });
});

describe('pooled undici dispatch', () => {
    it('builds exactly one Agent with the pinned pool settings and HTTP/2 off', async () => {
        await load();
        expect(u.agentOptions).toEqual([{
            keepAliveTimeout: 30_000,
            keepAliveMaxTimeout: 60_000,
            connections: 50,
            pipelining: 1,
            allowH2: false,
        }]);
    });

    it('routes a query through undici fetch with that Agent as dispatcher and the service-role credentials', async () => {
        const { supabase } = await load();
        const { data, error } = await supabase.from('units').select('id, name').eq('id', 7);

        expect(error).toBeNull();
        expect(data).toEqual([{ id: 7 }]);
        expect(u.fetchCalls).toHaveLength(1);
        const { url, init } = u.fetchCalls[0];
        const parsed = new URL(url);
        expect(parsed.origin).toBe('http://supabase.test');
        expect(parsed.pathname).toBe('/rest/v1/units');
        expect(parsed.searchParams.get('select')).toBe('id,name');
        expect(parsed.searchParams.get('id')).toBe('eq.7');
        expect(init.method).toBe('GET');
        expect(init.dispatcher).toBe(u.agents[0]);
        const headers = new Headers(init.headers);
        expect(headers.get('apikey')).toBe('service-role-test-key');
        expect(headers.get('authorization')).toBe('Bearer service-role-test-key');
    });

    it('surfaces an upstream error response as { error } rather than data', async () => {
        u.respond = () => new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), {
            status: 403, headers: { 'content-type': 'application/json' },
        });
        const { supabase } = await load();
        const { data, error } = await supabase.from('units').select('id');
        expect(data).toBeNull();
        expect(error).toMatchObject({ code: '42501', message: 'permission denied' });
    });
});

describe('handleSupabaseError', () => {
    it('is a no-op (returns undefined, logs nothing) when there is no error', async () => {
        const { handleSupabaseError } = await load({ logLevel: 'debug' });
        expect(handleSupabaseError({ error: null, message: 'Failed to load units' })).toBeUndefined();
        expect(handleSupabaseError({ error: undefined, message: 'x' })).toBeUndefined();
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('throws ONLY the caller message; the PG detail goes to the error log under the module logger', async () => {
        const { handleSupabaseError } = await load({ logLevel: 'debug' });
        const pgError = {
            code: '23505',
            message: 'duplicate key value violates unique constraint "units_name_key"',
            details: 'Key (name)=(Alpha) already exists.',
        };

        let thrown: unknown;
        try { handleSupabaseError({ error: pgError, message: 'Failed to create unit' }); } catch (e) { thrown = e; }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('Failed to create unit');
        expect(JSON.stringify({ ...(thrown as object), message: (thrown as Error).message })).not.toContain('units_name_key');

        expect(stderrSpy).toHaveBeenCalledTimes(1);
        const rec = JSON.parse(String(stderrSpy.mock.calls[0][0]));
        expect(rec).toMatchObject({ level: 'error', module: 'lib.supabaseServer', msg: 'Failed to create unit', err: pgError });
    });

    it('serialises an Error-instance cause and redacts a credential carried in it', async () => {
        const { handleSupabaseError } = await load({ logLevel: 'error' });
        expect(() => handleSupabaseError({ error: new Error('fetch failed: Bearer sb-leak'), message: 'Query failed' }))
            .toThrow('Query failed');
        const line = String(stderrSpy.mock.calls[0][0]);
        expect(JSON.parse(line).err).toMatchObject({ name: 'Error', message: 'fetch failed: [REDACTED]' });
        expect(line).not.toContain('sb-leak');
    });
});
