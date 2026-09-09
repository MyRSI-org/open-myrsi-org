import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// PHASE 3 ITEM 4 — the two HR eligibility RPCs.
//
// getEligibleHRInterviewers / getEligibleHROfficers exist so the two HR pickers stop
// filtering the bulk roster by another member's `permissions[]`, which
// stripSensitiveUserFields no longer ships to anyone. They landed in wave 1 with no test
// at all; this file is the pin.
//
// The load-bearing properties, in order of how badly a regression would hurt:
//   1. the RETURN SHAPE is exactly { id, name, avatarUrl } — a bespoke handler result gets
//      NO user-field minimisation from /api/services, so a widened shape reintroduces the
//      very leak these RPCs closed, by a new door;
//   2. the two SCOPES are different questions and must not be collapsed;
//   3. the reads FAIL CLOSED — an empty picker is visible and recoverable, a full member
//      enumeration is a silent leak;
//   4. the permission each RPC is gated on must match the client condition that feeds it —
//      asserting the two strings in isolation is precisely how the original mismatch got
//      past its author.

const h = vi.hoisted(() => ({
    calls: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    resolveQuery: (() => ({ data: null as unknown, error: null as unknown })) as
        (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    warns: [] as unknown[][],
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {},
        warn: (...args: unknown[]) => { h.warns.push(args); },
        error: () => {}, child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        h.calls.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gt', 'gte',
            'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({}),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import { getEligibleHRInterviewers, getEligibleHROfficers } from '../lib/db/hr';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const usersQueries = () => h.calls.filter(c => c.table === 'users');
const permArg = () => {
    const rp = h.calls.find(c => c.table === 'role_permissions');
    return rp?.calls.find(c => c.method === 'in' && c.args[0] === 'permission.name')?.args[1];
};
const usersCall = (method: string) => usersQueries()[0]?.calls.find(c => c.method === method);

/** role_permissions → the given role ids; users → the given rows. */
function seed(roleIds: number[], rows: unknown[], opts: { rolesError?: boolean } = {}) {
    h.resolveQuery = ({ table }) => {
        if (table === 'role_permissions') {
            return opts.rolesError
                ? { data: null, error: { message: 'boom' } }
                : { data: roleIds.map(id => ({ role_id: id, permission: [{ name: 'hr:recruiter' }] })), error: null };
        }
        if (table === 'users') return { data: rows, error: null };
        return { data: null, error: null };
    };
}

beforeEach(() => { h.calls = []; h.warns = []; });

describe('HR eligibility RPCs', () => {
    it('14. the return shape is EXACTLY { id, name, avatarUrl } — no permissions, no ids from the row', async () => {
        seed([3], [{ id: 5, name: 'Ana', display_name: null, avatar_url: null, discord_id: 'D5', role_id: 3, permissions: ['hr:admin'] }]);
        const out = await getEligibleHRInterviewers();
        expect(out).toHaveLength(1);
        expect(Object.keys(out[0]).sort()).toEqual(['avatarUrl', 'id', 'name']);
        const json = JSON.stringify(out);
        for (const forbidden of ['hr:', 'admin:', 'discord_id', 'role_id', 'permissions']) {
            expect(json, `${forbidden} escaped into the picker payload`).not.toContain(forbidden);
        }
    });

    it('15. the two SCOPES are different questions and must not be collapsed', async () => {
        // An hr:manager-only role assigns case officers but does not run interviews.
        // Collapsing these to one constant is the obvious "cleanup" and it silently
        // widens the interviewer picker.
        seed([3], []);
        await getEligibleHRInterviewers();
        expect(permArg()).toEqual(['hr:recruiter', 'hr:admin']);

        h.calls = [];
        seed([3], []);
        await getEligibleHROfficers();
        expect(permArg()).toEqual(['hr:recruiter', 'hr:manager', 'hr:admin']);
    });

    it('16. FAIL-CLOSED: a role-lookup error yields [], never the roster', async () => {
        seed([], [{ id: 5, name: 'Ana', display_name: null, avatar_url: null }], { rolesError: true });
        await expect(getEligibleHROfficers()).resolves.toEqual([]);
        // …and the users query is never issued, so there is nothing to widen.
        expect(usersQueries()).toHaveLength(0);
    });

    it('16b. zero matching roles short-circuits before the users query', async () => {
        seed([], []);
        await expect(getEligibleHROfficers()).resolves.toEqual([]);
        expect(usersQueries()).toHaveLength(0);
    });

    it('17. the users query is soft-delete filtered, capped and ordered', async () => {
        seed([3], []);
        await getEligibleHRInterviewers();
        expect(usersCall('is')?.args).toEqual(['deleted_at', null]);
        expect(usersCall('limit')?.args).toEqual([1000]);
        expect(usersCall('order')?.args).toEqual(['name', { ascending: true }]);
        // Enumerated columns only — CLAUDE.md security rule 1.
        expect(usersCall('select')?.args[0]).toBe('id, name, display_name, avatar_url');
    });

    it('18. the effective display name matches toUser, and the avatar falls back', async () => {
        seed([3], [
            { id: 1, name: 'Raw', display_name: '  Zed  ', avatar_url: 'https://x/a.png' },
            { id: 2, name: 'Ana', display_name: null, avatar_url: null },
            { id: 3, name: null, display_name: null, avatar_url: null },
        ]);
        const out = await getEligibleHRInterviewers();
        expect(out.map(o => o.name)).toEqual(['Zed', 'Ana', 'Unknown']);
        expect(out[1].avatarUrl).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
        expect(out[0].avatarUrl).toBe('https://x/a.png');
    });

    it('19. TG10 — each RPC permission is tied to the CLIENT condition that feeds it', () => {
        // This is exactly how the original mismatch got past the author: the two strings
        // were pinned in isolation while the controls that feed them were enabled on a
        // looser condition. api/services.ts is read-only here.
        const services = read('api/services.ts');
        expect(services).toContain("'hr:get_eligible_officers': 'hr:manager'");
        expect(services).toContain("'hr:get_eligible_interviewers': 'hr:recruiter'");
        // components/views/hr/UnifiedCaseFileView.tsx — the case-OFFICER picker.
        expect(read('components/views/hr/UnifiedCaseFileView.tsx')).toContain("hasPermission('hr:manager')");
        // components/modals/hr/ScheduleInterviewModal.tsx — the INTERVIEWER picker.
        expect(read('components/modals/hr/ScheduleInterviewModal.tsx')).toContain("hasPermission('hr:recruiter')");
    });

    it('20. A2 ratchet — neither entry may be widened to hr:view', () => {
        // hr:view is in MEMBER_DEFAULT_PERMS. Widening either entry to it hands every
        // seeded member an enumeration of the org's HR staff — a narrower version of the
        // exact leak item 4 exists to close, and the first "fix" a future implementer
        // reaches for when a picker looks empty.
        const services = read('api/services.ts');
        expect(services).not.toContain("'hr:get_eligible_officers': 'hr:view'");
        expect(services).not.toContain("'hr:get_eligible_interviewers': 'hr:view'");
    });
});
