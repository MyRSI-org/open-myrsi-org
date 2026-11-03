import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// lib/supabaseClient.ts — the browser's Supabase client (realtime only; all data goes
// through /api). Pinned:
//   * nothing is constructed at import; the client is built exactly once, from the url/key
//     the caller passes, with the realtime/auth options below;
//   * it is a boot-time singleton — a later call cannot re-point it at other credentials;
//   * the key comes ONLY from the server's browser-safe config (target=config's
//     supabaseAnonKey, vetted by lib/supabaseKeyGuard.ts) — the module itself reads no
//     VITE_* / import.meta.env / process.env and imports nothing but supabase-js. The ESLint
//     client boundary does not cover lib/**, so this file pins it.

const h = vi.hoisted(() => {
    let n = 0;
    return { createClient: vi.fn((url: string, key: string) => ({ client: ++n, url, key })) };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));

const ROOT = resolve(__dirname, '..');
const URL_ = 'https://abcdefghijklmnop.supabase.co';
const ANON = 'sb_publishable_TESTONLY_abcdefghijklmnop';

async function freshModule() {
    vi.resetModules();
    h.createClient.mockClear();
    return import('../lib/supabaseClient');
}

afterEach(() => {
    h.createClient.mockClear();
});

describe('initializeSupabase / getSupabase', () => {
    it('constructs nothing at import time', async () => {
        const mod = await freshModule();
        expect(h.createClient).not.toHaveBeenCalled();
        expect(mod.getSupabase()).toBeUndefined();
        expect(mod.supabase).toBeUndefined();
    });

    it('builds the client once from the passed url/key with the pinned options', async () => {
        const mod = await freshModule();
        const client = mod.initializeSupabase(URL_, ANON);
        expect(h.createClient).toHaveBeenCalledTimes(1);
        expect(h.createClient).toHaveBeenCalledWith(URL_, ANON, {
            realtime: { params: { eventsPerSecond: 10 } },
            auth: { persistSession: true, autoRefreshToken: true },
        });
        expect(client).toBe(h.createClient.mock.results[0].value);
        expect(mod.getSupabase()).toBe(client);
        expect(mod.supabase).toBe(client); // live ESM binding updates after init
    });

    it('is a singleton: a later call cannot re-point it at other credentials', async () => {
        const mod = await freshModule();
        const first = mod.initializeSupabase(URL_, ANON);
        const second = mod.initializeSupabase('https://attacker.example.org', 'sb_secret_TESTONLY_zzz');
        expect(second).toBe(first);
        expect(h.createClient).toHaveBeenCalledTimes(1);
        expect(mod.getSupabase()).toBe(first);
    });
});

describe('browser-safe construction contract (source)', () => {
    const src = readFileSync(join(ROOT, 'lib/supabaseClient.ts'), 'utf8').replace(/\r\n/g, '\n');

    it('reads no build-time or process env', () => {
        expect(src).not.toMatch(/import\.meta\.env/);
        expect(src).not.toMatch(/VITE_/);
        expect(src).not.toMatch(/process\.env/);
    });

    it('imports nothing but supabase-js (no server-only modules)', () => {
        const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
        expect(imports).toEqual(['@supabase/supabase-js']);
        expect(src).not.toMatch(/require\(/);
    });

    it('is only ever initialised from the server-provided config url + anon key', () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (/\.(ts|tsx)$/.test(name)) files.push(p);
            }
        };
        for (const dir of ['components', 'contexts', 'hooks', 'services']) walk(join(ROOT, dir));
        for (const f of ['App.tsx', 'DashboardApp.tsx', 'index.tsx']) files.push(join(ROOT, f));

        const calls: string[] = [];
        for (const f of files) {
            const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
            for (const m of text.matchAll(/initializeSupabase\(([^)]*)\)/g)) calls.push(m[1].replace(/\s+/g, ' ').trim());
        }
        expect(calls.length).toBeGreaterThan(0);
        for (const args of calls) expect(args).toBe('config.supabaseUrl, config.supabaseAnonKey');
    });
});
