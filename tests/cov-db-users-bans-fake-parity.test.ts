import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fidelity guard for the users-bans Supabase double (tests/cov-db-users-bans-fake.ts).
//
// The users-bans suites mock lib/db/common and hand the code under test
// safeFetchFake in place of the real safeFetch. A double that disagrees with the
// real function makes those suites pin a contract production does not have (an
// earlier version rethrew on a DB fault, while the real safeFetch NEVER throws and
// resolves every read failure to the caller's fallback). So this file runs the REAL
// safeFetch (lib/db/common, unmocked, with the real lib/supabaseServer
// handleSupabaseError) and the fake over the same inputs and requires the same
// result, the same safeFetch log lines in the same order, and the same
// handleSupabaseError invocations.

type Entry = { level: string; msg: string; fields: unknown };

const h = vi.hoisted(() => {
    const seq: Record<string, Entry[]> = {};
    const loggerFor = (module: string): Record<string, unknown> => {
        const rec = (level: string) => (msg: string, fields?: unknown) => {
            (seq[module] ||= []).push({ level, msg, fields });
        };
        return {
            debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
            child: (more: { module?: string }) => loggerFor(more?.module ?? module),
        };
    };
    return { seq, loggerFor };
});

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    return { ...actual, log: { ...actual.log, child: (b: { module?: string }) => h.loggerFor(b?.module ?? 'root') } };
});

import { safeFetch } from '../lib/db/common';
import { safeFetchFake, sb, resetSb } from './cov-db-users-bans-fake';

type Err = { code?: string; message?: string; hint?: string; details?: string };
type Res = { data: string[] | null; error: Err | null };

const FALLBACK = ['fallback'];
const TOLERATED = ['PGRST205', 'PGRST204', 'PGRST200', 'PGRST201', '42P01'];
const boom = new Error('socket hang up');

// Lazy factories: each run gets a fresh promise (a shared rejected promise would
// surface as an unhandled rejection before it is awaited).
const scenarios: Array<[string, () => PromiseLike<Res>]> = [
    ['rows on success', () => Promise.resolve({ data: ['row'], error: null })],
    ['null data, no error', () => Promise.resolve({ data: null, error: null })],
    ...TOLERATED.map((code): [string, () => PromiseLike<Res>] => [
        `tolerated schema-drift code ${code}`,
        () => Promise.resolve({ data: null, error: { code, message: 'relation missing', hint: 'h', details: 'd' } }),
    ]),
    ['tolerated code without hint/details', () => Promise.resolve({ data: null, error: { code: '42P01', message: 'm' } })],
    ['real fault with partial data', () => Promise.resolve({ data: ['partial'], error: { code: '57014', message: 'statement timeout' } })],
    ['real fault with no code', () => Promise.resolve({ data: null, error: { message: 'no code' } })],
    ['empty error object', () => Promise.resolve({ data: null, error: {} })],
    ['rejecting query', () => Promise.reject(boom)],
];

async function runReal(make: () => PromiseLike<Res>) {
    for (const k of Object.keys(h.seq)) delete h.seq[k];
    const out = await safeFetch<string[] | null>(make(), FALLBACK, 'target.list');
    return {
        out,
        safeFetchLogs: [...(h.seq.db ?? [])],
        // lib/supabaseServer.ts handleSupabaseError logs (message, { err }) then throws.
        handled: (h.seq['lib.supabaseServer'] ?? []).map((e) => ({ message: e.msg, error: (e.fields as { err: unknown }).err })),
    };
}

async function runFake(make: () => PromiseLike<Res>) {
    resetSb();
    const out = await safeFetchFake<string[] | null>(make(), FALLBACK, 'target.list');
    return { out, safeFetchLogs: [...sb.safeFetchLogs], handled: [...sb.handledErrors] };
}

beforeEach(() => {
    for (const k of Object.keys(h.seq)) delete h.seq[k];
    resetSb();
});

describe('safeFetchFake matches the real lib/db/common safeFetch', () => {
    it.each(scenarios)('%s: same result, same log lines, same handleSupabaseError calls', async (_name, make) => {
        const real = await runReal(make);
        const fake = await runFake(make);
        expect(fake.out).toEqual(real.out);
        expect(fake.out === FALLBACK).toBe(real.out === FALLBACK);
        expect(fake.safeFetchLogs).toEqual(real.safeFetchLogs);
        expect(fake.handled).toEqual(real.handled);
    });

    // Anchor the contract itself, not just the agreement: the real function never
    // throws and never returns partial data alongside an error.
    it('the real safeFetch resolves every failure to the fallback — it never throws', async () => {
        for (const [name, make] of scenarios.slice(2)) {
            const { out } = await runReal(make);
            expect(out, name).toBe(FALLBACK);
        }
        const fault = await runReal(() => Promise.resolve({ data: ['partial'], error: { code: '57014', message: 't' } }));
        expect(fault.safeFetchLogs.map((e) => [e.level, e.msg])).toEqual([
            ['error', 'safeFetch DB error'],
            ['error', 'safeFetch fatal'],
        ]);
        expect(fault.handled).toEqual([{ message: 'target.list', error: { code: '57014', message: 't' } }]);
    });
});
