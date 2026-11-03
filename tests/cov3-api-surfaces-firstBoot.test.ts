import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/firstBoot.ts — the first-boot install hook.
//
// What is pinned here, and why it matters:
//   - adminExists() is the gate the setup-code redemption paths use to refuse
//     self-promotion once an Admin exists. It must FAIL CLOSED: a DB error reads as
//     "an admin exists", so a transient fault can never re-open the admin seat or spam
//     fresh codes onto a live install. Roles not seeded yet is the only "definitely no
//     admin" short-circuit, and it must not touch the users table.
//   - The one-time SETUP-XXXXXXXX code is a redeemable Admin credential. It goes to the
//     console banner and NOWHERE in the structured (JSON) log stream — the structured
//     line records only that a code exists. Every structured record emitted during a run
//     is captured here and searched for the code.
//   - A code is printed only once it is PERSISTED: a failed upsert must not print a code
//     that cannot be redeemed.
//   - An unredeemed code from a previous boot is reused, never clobbered.
//   - An instance that already has an Admin never seeds, never mints, and backfills
//     setup_completed so the onboarding wizard can never re-appear.
//   - runFirstBootCheck never rejects: any failure is logged and boot continues.

type Op = [string, unknown[]];
interface Q { table: string; ops: Op[] }
type Res = { data?: unknown; error?: unknown; count?: number | null };

const h = vi.hoisted(() => {
    const state = {
        queries: [] as Q[],
        // Per-table FIFO of responses (or throwers); empty queue resolves { data: null, error: null }.
        queue: {} as Record<string, Array<Res | (() => never)>>,
        roles: {} as Record<string, { id: number } | undefined>,
        rolesThrows: null as Error | null,
        seedCalls: 0,
        seedThrows: null as Error | null,
        rolesAfterSeed: null as Record<string, { id: number } | undefined> | null,
        logs: [] as Array<{ level: string; ctx: Record<string, unknown>; msg: string; fields?: Record<string, unknown> }>,
    };
    function from(table: string) {
        const q: Q = { table, ops: [] };
        state.queries.push(q);
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'upsert', 'maybeSingle']) {
            chain[m] = (...a: unknown[]) => { q.ops.push([m, structuredClone(a)]); return chain; };
        }
        chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
            const next = (state.queue[table] ?? []).shift();
            if (typeof next === 'function') {
                try { next(); } catch (e) { return Promise.reject(e).then(ok, bad); }
            }
            return Promise.resolve({ data: null, error: null, count: null, ...(next as Res | undefined) }).then(ok, bad);
        };
        return chain;
    }
    return { state, from };
});

vi.mock('../lib/db/common', () => ({
    supabase: { from: h.from },
    getSystemRoles: async () => {
        if (h.state.rolesThrows) throw h.state.rolesThrows;
        return h.state.roles;
    },
}));

vi.mock('../lib/db/seeder', () => ({
    seedInstall: async () => {
        h.state.seedCalls++;
        if (h.state.seedThrows) throw h.state.seedThrows;
        if (h.state.rolesAfterSeed) h.state.roles = h.state.rolesAfterSeed;
    },
}));

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    type L = typeof actual.log;
    const mk = (ctx: Record<string, unknown>): L => ({
        debug: (msg, fields) => { h.state.logs.push({ level: 'debug', ctx, msg, fields }); },
        info: (msg, fields) => { h.state.logs.push({ level: 'info', ctx, msg, fields }); },
        warn: (msg, fields) => { h.state.logs.push({ level: 'warn', ctx, msg, fields }); },
        error: (msg, fields) => { h.state.logs.push({ level: 'error', ctx, msg, fields }); },
        child: (more) => mk({ ...ctx, ...more }),
    });
    return { ...actual, log: mk({}) };
});

import { adminExists, runFirstBootCheck } from '../lib/firstBoot';

const ADMIN_ROLES = { admin: { id: 4 }, member: { id: 2 } };
const CODE_RE = /^SETUP-[0-9A-F]{8}$/;
const FIXED_NOW = new Date('2026-03-04T05:06:07.089Z');

let consoleLines: string[] = [];

function enqueue(table: string, ...res: Array<Res | (() => never)>) {
    (h.state.queue[table] ??= []).push(...res);
}
const q = (table: string) => h.state.queries.filter((x) => x.table === table);
const ops = (x: Q) => x.ops;
const logMsgs = (level?: string) => h.state.logs.filter((l) => !level || l.level === level).map((l) => l.msg);
const structuredText = () => JSON.stringify(h.state.logs, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));

/** The exact users-table count query adminExists must issue for an admin role id. */
function adminCountOps(roleId: number): Op[] {
    return [
        ['select', ['id', { count: 'exact', head: true }]],
        ['eq', ['role_id', roleId]],
        ['is', ['deleted_at', null]],
    ];
}

beforeEach(() => {
    h.state.queries = [];
    h.state.queue = {};
    h.state.roles = ADMIN_ROLES;
    h.state.rolesThrows = null;
    h.state.seedCalls = 0;
    h.state.seedThrows = null;
    h.state.rolesAfterSeed = null;
    h.state.logs = [];
    consoleLines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('adminExists — the first-admin-only gate', () => {
    it('roles not seeded (no admin role) → false, without querying users', async () => {
        h.state.roles = { member: { id: 2 } };
        expect(await adminExists()).toBe(false);
        expect(h.state.queries).toEqual([]);
    });

    it('counts live (non-deleted) users holding the admin role id, head-only', async () => {
        enqueue('users', { count: 1 });
        expect(await adminExists()).toBe(true);
        expect(q('users')).toHaveLength(1);
        expect(ops(q('users')[0])).toEqual(adminCountOps(4));
    });

    it('zero admins → false; a null count with no error → false', async () => {
        enqueue('users', { count: 0 }, { count: null });
        expect(await adminExists()).toBe(false);
        expect(await adminExists()).toBe(false);
    });

    it('several admins → true', async () => {
        enqueue('users', { count: 3 });
        expect(await adminExists()).toBe(true);
    });

    it('FAILS CLOSED: a read error reads as "an admin exists" and is logged', async () => {
        const err = { code: '57014', message: 'canceling statement due to statement timeout' };
        enqueue('users', { count: null, error: err });
        expect(await adminExists()).toBe(true);
        const rec = h.state.logs.find((l) => l.msg === 'admin existence check failed');
        expect(rec).toMatchObject({ level: 'error', ctx: { module: 'lib.firstBoot' }, fields: { err } });
    });

    it('a count of 0 alongside an error still fails closed (error wins)', async () => {
        enqueue('users', { count: 0, error: { message: 'boom' } });
        expect(await adminExists()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe('runFirstBootCheck — instance that already has an Admin', () => {
    it('never seeds, never mints, prints no banner, and backfills setup_completed when unset', async () => {
        enqueue('users', { count: 1 });
        enqueue('settings', { data: null }); // setup_completed row absent
        await runFirstBootCheck();

        expect(h.state.seedCalls).toBe(0);
        expect(consoleLines).toEqual([]);
        const settings = q('settings');
        expect(settings).toHaveLength(2);
        expect(ops(settings[0])).toEqual([
            ['select', ['value']],
            ['eq', ['key', 'setup_completed']],
            ['maybeSingle', []],
        ]);
        expect(ops(settings[1])).toEqual([
            ['upsert', [{ key: 'setup_completed', value: true }, { onConflict: 'key' }]],
        ]);
        // Nothing ever touched the setup code row.
        expect(JSON.stringify(h.state.queries)).not.toContain('admin_setup_code');
        expect(logMsgs('info')).toEqual([
            'first-boot check: admin present, skipping install seed',
            'backfilled setup_completed=true for existing-admin instance',
        ]);
    });

    it('backfills when setup_completed holds a non-true value (strict === true)', async () => {
        enqueue('users', { count: 1 });
        enqueue('settings', { data: { value: 'true' } });
        await runFirstBootCheck();
        expect(q('settings').map((x) => x.ops[0][0])).toEqual(['select', 'upsert']);
    });

    it('does not re-write setup_completed when it is already true', async () => {
        enqueue('users', { count: 1 });
        enqueue('settings', { data: { value: true } });
        await runFirstBootCheck();
        expect(q('settings')).toHaveLength(1);
        expect(logMsgs()).not.toContain('backfilled setup_completed=true for existing-admin instance');
    });

    it('a throwing backfill is non-fatal: warned, resolved, and still no seed / code', async () => {
        const boom = new Error('settings unavailable');
        enqueue('users', { count: 1 });
        enqueue('settings', () => { throw boom; });
        await expect(runFirstBootCheck()).resolves.toBeUndefined();
        const rec = h.state.logs.find((l) => l.msg === 'setup_completed backfill failed (non-fatal)');
        expect(rec).toMatchObject({ level: 'warn', fields: { err: boom } });
        expect(h.state.seedCalls).toBe(0);
        expect(consoleLines).toEqual([]);
        expect(logMsgs('error')).toEqual([]);
    });

    it('a users read error (fail-closed true) is treated as "admin present" — no seed, no code', async () => {
        enqueue('users', { error: { message: 'down' } });
        enqueue('settings', { data: { value: true } });
        await runFirstBootCheck();
        expect(h.state.seedCalls).toBe(0);
        expect(consoleLines).toEqual([]);
        expect(JSON.stringify(h.state.queries)).not.toContain('admin_setup_code');
    });
});

// ---------------------------------------------------------------------------
describe('runFirstBootCheck — fresh install mints a one-time code', () => {
    it('seeds, re-checks, mints a SETUP-XXXXXXXX code, persists it, then prints it ONLY to the console', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FIXED_NOW);
        enqueue('users', { count: 0 }, { count: 0 });
        enqueue('settings', { data: null }, { error: null }); // no existing code, then the upsert
        await runFirstBootCheck();

        expect(h.state.seedCalls).toBe(1);
        // adminExists ran twice — before and after the seed.
        expect(q('users').map(ops)).toEqual([adminCountOps(4), adminCountOps(4)]);

        const settings = q('settings');
        expect(settings).toHaveLength(2);
        expect(ops(settings[0])).toEqual([
            ['select', ['value']],
            ['eq', ['key', 'admin_setup_code']],
            ['maybeSingle', []],
        ]);
        expect(settings[1].ops).toHaveLength(1);
        const [method, [payload, opts]] = settings[1].ops[0] as [string, [{ key: string; value: { code: string; created_at: string; failed_attempts: number } }, unknown]];
        expect(method).toBe('upsert');
        expect(opts).toEqual({ onConflict: 'key' });
        expect(Object.keys(payload).sort()).toEqual(['key', 'value']);
        expect(payload.key).toBe('admin_setup_code');
        expect(Object.keys(payload.value).sort()).toEqual(['code', 'created_at', 'failed_attempts']);
        expect(payload.value.created_at).toBe('2026-03-04T05:06:07.089Z');
        expect(payload.value.failed_attempts).toBe(0);
        const code = payload.value.code;
        expect(code).toMatch(CODE_RE);

        // Console banner: the code appears exactly once, on its own marked line.
        expect(consoleLines.filter((l) => l.includes(code))).toEqual([`      >>>   ${code}   <<<`]);
        expect(consoleLines).toContain('='.repeat(66));
        expect(consoleLines).toContain('  YOUR ONE-TIME ADMIN CLAIM CODE:');

        // Structured log: records the EVENT, never the VALUE.
        expect(structuredText()).not.toContain(code);
        expect(structuredText()).not.toMatch(/SETUP-[0-9A-F]{8}/);
        expect(logMsgs('warn')).toEqual(['admin setup code generated (first boot) — see console banner for the one-time code']);
        expect(logMsgs('info')).toEqual(['first-boot check: no admin found, running install seed']);
    });

    it('two fresh installs mint different codes (random, not a constant)', async () => {
        const codes: string[] = [];
        for (let i = 0; i < 2; i++) {
            h.state.queries = [];
            enqueue('users', { count: 0 }, { count: 0 });
            enqueue('settings', { data: null }, { error: null });
            await runFirstBootCheck();
            const up = q('settings')[1].ops[0][1][0] as { value: { code: string } };
            codes.push(up.value.code);
        }
        expect(codes[0]).toMatch(CODE_RE);
        expect(codes[1]).toMatch(CODE_RE);
        expect(codes[0]).not.toBe(codes[1]);
    });

    it('roles not seeded before the seed, admin role present after: still mints (role id read fresh)', async () => {
        // First adminExists() sees no admin role (no users query); the seed creates roles; the
        // re-check queries users by the now-seeded admin id.
        h.state.roles = { member: { id: 2 } };
        h.state.rolesAfterSeed = { admin: { id: 9 }, member: { id: 2 } };
        enqueue('users', { count: 0 });
        enqueue('settings', { data: null }, { error: null });
        await runFirstBootCheck();
        expect(h.state.seedCalls).toBe(1);
        expect(q('users').map(ops)).toEqual([adminCountOps(9)]);
        expect(q('settings')).toHaveLength(2);
        const code = (q('settings')[1].ops[0][1][0] as { value: { code: string } }).value.code;
        expect(code).toMatch(CODE_RE);
        expect(consoleLines).toContain(`      >>>   ${code}   <<<`);
    });

    it('a persist failure prints NO code (an unredeemable code is never shown) and boot continues', async () => {
        const err = { code: '23505', message: 'write failed' };
        enqueue('users', { count: 0 }, { count: 0 });
        enqueue('settings', { data: null }, { error: err });
        await expect(runFirstBootCheck()).resolves.toBeUndefined();

        expect(consoleLines).toEqual([]);
        const persisted = h.state.logs.find((l) => l.msg === 'failed to persist admin setup code');
        expect(persisted).toMatchObject({ level: 'error', fields: { err } });
        const outer = h.state.logs.find((l) => l.msg === 'first-boot check failed (continuing startup)');
        expect(outer).toMatchObject({ level: 'error', fields: { err } });
        // The attempted code never reaches the structured log either.
        const attempted = (q('settings')[1].ops[0][1][0] as { value: { code: string } }).value.code;
        expect(structuredText()).not.toContain(attempted);
        expect(logMsgs('warn')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('runFirstBootCheck — races and reuse', () => {
    it('an admin that appears during the seed stops the mint: no code read, no upsert, no banner', async () => {
        enqueue('users', { count: 0 }, { count: 1 });
        await runFirstBootCheck();
        expect(h.state.seedCalls).toBe(1);
        expect(q('settings')).toEqual([]);
        expect(consoleLines).toEqual([]);
        expect(logMsgs('info')).toContain('admin appeared during seed; not minting setup code');
    });

    it('reuses an unredeemed object-shaped code: re-prints it, never upserts a new one', async () => {
        enqueue('users', { count: 0 }, { count: 0 });
        enqueue('settings', { data: { value: { code: 'SETUP-ABCDEF12', created_at: 'x', failed_attempts: 2 } } });
        await runFirstBootCheck();
        expect(q('settings')).toHaveLength(1);
        expect(JSON.stringify(q('settings'))).not.toContain('upsert');
        expect(consoleLines.filter((l) => l.includes('SETUP-'))).toEqual(['      >>>   SETUP-ABCDEF12   <<<']);
        expect(logMsgs('info')).toContain('reusing existing unredeemed admin setup code');
        expect(structuredText()).not.toContain('SETUP-ABCDEF12');
    });

    it('reuses a legacy string-shaped code', async () => {
        enqueue('users', { count: 0 }, { count: 0 });
        enqueue('settings', { data: { value: 'SETUP-0000FFFF' } });
        await runFirstBootCheck();
        expect(consoleLines.filter((l) => l.includes('SETUP-'))).toEqual(['      >>>   SETUP-0000FFFF   <<<']);
        expect(q('settings')).toHaveLength(1);
        expect(structuredText()).not.toContain('SETUP-0000FFFF');
    });

    it('an existing row with no code field is left alone: no banner, no clobbering upsert', async () => {
        enqueue('users', { count: 0 }, { count: 0 });
        enqueue('settings', { data: { value: { failed_attempts: 5 } } });
        await runFirstBootCheck();
        expect(consoleLines).toEqual([]);
        expect(q('settings')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('runFirstBootCheck — never aborts boot', () => {
    it('a throwing seed is logged and swallowed; no code is minted', async () => {
        const boom = new Error('seed failed');
        h.state.seedThrows = boom;
        enqueue('users', { count: 0 });
        await expect(runFirstBootCheck()).resolves.toBeUndefined();
        expect(h.state.logs.find((l) => l.msg === 'first-boot check failed (continuing startup)')).toMatchObject({ level: 'error', fields: { err: boom } });
        expect(q('settings')).toEqual([]);
        expect(consoleLines).toEqual([]);
    });

    it('a throwing role lookup is logged and swallowed', async () => {
        const boom = new Error('roles unavailable');
        h.state.rolesThrows = boom;
        await expect(runFirstBootCheck()).resolves.toBeUndefined();
        expect(h.state.logs.find((l) => l.msg === 'first-boot check failed (continuing startup)')).toMatchObject({ fields: { err: boom } });
        expect(h.state.seedCalls).toBe(0);
        expect(h.state.queries).toEqual([]);
    });
});
