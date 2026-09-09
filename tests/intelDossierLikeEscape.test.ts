import { describe, it, expect, vi, beforeEach } from 'vitest';

// like-escape (intel raw sites): getDossier's ORGANIZATION branch was the one
// target lookup in the function that skipped `safeTarget` and handed the raw
// client payload to `.ilike('target_id', …)`. PostgREST rewrites `*` to `%` in a
// like/ilike operand, so a dossier request for '*' merged EVERY intel report in
// the instance into the response; and even with `*` escaped, a `_` (legal inside
// an org name) stayed live as a single-character wildcard on that line only.
//
// Purpose-built harness rather than an extension of tests/intelInputValidation's
// mock: reaching the org branch requires the subject_type probe to answer, and
// that file's settle() is shared with an unrelated insert path.

const h = vi.hoisted(() => ({
    ilikeArgs: [] as Array<[string, unknown]>,
    subjectType: 'Organization' as string,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        b.ilike = (col: string, val: unknown) => { h.ilikeArgs.push([col, val]); return b; };
        const settle = () => {
            const sel = String(calls.find((c) => c.method === 'select')?.args[0] ?? '');
            // No user row → no ops/participation fan-out; the branch under test
            // only needs the subject_type probe to say "Organization".
            if (table === 'users') return Promise.resolve({ data: null, error: null });
            if (table === 'intel_reports' && sel === 'subject_type') {
                return Promise.resolve({ data: { subject_type: h.subjectType }, error: null });
            }
            return Promise.resolve({ data: [], error: null, count: 0 });
        };
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});
vi.mock('../lib/push', () => ({ sendPushToStaff: () => {}, sendPushToUsers: async () => {} }));

import { getDossier } from '../lib/db/intel';

const viewer = { id: 6, role: 'Member', permissions: ['intel:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

beforeEach(() => { h.ilikeArgs = []; h.subjectType = 'Organization'; });

describe('getDossier escapes the ORG-branch report lookup', () => {
    // Asserted against the literal escaped form, not against escapeLikePattern's
    // own output — comparing the helper to itself passes whatever the helper does.
    it.each([
        ['*', '\\*'],   // PostgREST's alias for % — live before the class was widened
        ['%', '\\%'],
        ['MY_ORG', 'MY\\_ORG'], // `_` is legal in an org name and stayed live here
    ])('targetId %j reaches every target_id .ilike as %j', async (targetId, escaped) => {
        await getDossier(targetId, viewer);
        const targetCalls = h.ilikeArgs.filter(([col]) => col === 'target_id').map(([, v]) => v);
        // The subject_type probe (already escaped) plus the org-branch report
        // query (the site that was raw) — more than one, or the branch never ran.
        expect(targetCalls.length).toBeGreaterThan(1);
        for (const v of targetCalls) expect(v).toBe(escaped);
    });

    it('escapes the affiliated_org member lookup on the same branch', async () => {
        await getDossier('*', viewer);
        const affiliated = h.ilikeArgs.filter(([col]) => col === 'affiliated_org').map(([, v]) => v);
        expect(affiliated.length).toBeGreaterThan(0);
        for (const v of affiliated) expect(v).toBe('\\*');
    });
});
