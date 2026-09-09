import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// PHASE 3 ITEM 4, STEP 7 — the ROSTER PROJECTION split.
//
// `lib/db/users.ts` now carries THREE user select constants, and which one a call site
// names is a security decision:
//
//   USER_SELECT_QUERY        detail / session actor — the widest.
//   USER_LIST_SELECT_QUERY   getUserById / getUserByAuthId DEGRADED FALLBACK ONLY. It
//                            must stay WIDE: all four `isSessionRevokedByWatermark`
//                            call sites (api/services.ts, api/query.ts, api/orgUpload.ts,
//                            server.ts) read `tokensValidFrom` off a getUserById result,
//                            so narrowing this constant would silently disable per-user
//                            session revocation on exactly the half-migrated install the
//                            fallback exists for.
//   USER_ROSTER_SELECT_QUERY the bulk `main` roster AND the realtime users_slice patch —
//                            and it must be the SAME constant at both call sites, because
//                            lib/sliceMerge.ts mergeUsersSlice REPLACES whole rows.
//
// This file pins all three properties. Test 5 (the two call sites agree) is NOT enough on
// its own — the four dropped columns could be restored with test 5 still green — which is
// what tests 1 and 3 are for.
//
// NOTE: this file governs the three top-level `.from('users').select(CONST)` projections.
// Columns selected inside a `users` EMBED are a different hazard and are covered by
// tests/userEmbedColumnRatchet.test.ts.

const h = vi.hoisted(() => ({
    from: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    rows: {} as Record<string, unknown>,
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        h.from.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gt', 'gte',
            'lt', 'lte', 'contains', 'overlaps', 'range', 'ilike', 'like', 'filter',
            'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            // The duty existence probe is the only `users` read a non-staff caller
            // triggers; give it a row so anyStaffOnDuty is a real boolean.
            if (table === 'users' && calls.some(c => c.method === 'eq' && c.args[0] === 'is_duty')) {
                return Promise.resolve({ data: [{ id: 1 }], error: null });
            }
            return Promise.resolve({ data: h.rows[table] ?? [], error: null });
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => {
            calls.push({ method: 'maybeSingle', args: [] });
            return Promise.resolve({ data: h.rows[`${table}:single`] ?? null, error: null });
        };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({ client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' } }),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import { USER_ROSTER_SELECT_QUERY, USER_LIST_SELECT_QUERY, USER_SELECT_QUERY } from '../lib/db/users';
import { getMainState, getUsersByIdsLite } from '../lib/db';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** CRLF-SAFE function-body slice. `indexOf('\n}\n')` returns -1 in this checkout and
 *  `slice(start, -1)` then widens the body to nearly the whole file, so the assertions
 *  below it would pass for the wrong reason. Never omit the explicit end check. */
function fnBody(src: string, decl: string): string {
    const start = src.indexOf(decl);
    expect(start, `declaration not found: ${decl}`).toBeGreaterThan(-1);
    const end = src.slice(start).search(/\r?\n\}\r?\n/);
    expect(end, `closing brace not found for: ${decl}`).toBeGreaterThan(-1);
    return src.slice(start, start + end);
}

/** The first line of a select constant is its top-level column list. */
const columnTokens = (q: string) => (q.trim().split('\n')[0] || '')
    .split(',').map(s => s.trim()).filter(Boolean);

describe('roster select projection — the four dropped columns', () => {
    it('1. TG7 — the roster projection drops the RSI pair, tokens_valid_from and deleted_at', () => {
        // Step 7's entire value is these four removals. Test 5 only asserts that the two
        // call sites AGREE, so the drop could be reverted with test 5 still green.
        // `rsi_handle` (kept) is a PREFIX of `rsi_handle_pending` (dropped), so assert the
        // long form explicitly rather than inferring it from the short one.
        expect(USER_ROSTER_SELECT_QUERY).not.toContain('rsi_verification_code');
        expect(USER_ROSTER_SELECT_QUERY).not.toContain('rsi_handle_pending');
        expect(USER_ROSTER_SELECT_QUERY).not.toContain('tokens_valid_from');
        expect(USER_ROSTER_SELECT_QUERY).not.toContain('deleted_at');
        // …and the columns that stay are still there.
        expect(USER_ROSTER_SELECT_QUERY).toContain('rsi_handle,');
        expect(USER_ROSTER_SELECT_QUERY).toContain('rsi_verified');
    });

    it('2. TG6 — the roster projection KEEPS role_permissions, clearance_level and the notes columns', () => {
        // role_permissions feeds toUser's `permissions`, which feeds inferUserRoleTier's
        // fallback for CUSTOM role names. Dropping it re-tiers every member of a
        // custom-named role to UserRole.Client — an AUTHORIZATION change with nothing
        // else standing in its way.
        expect(USER_ROSTER_SELECT_QUERY).toContain('role_permissions(permission:permissions(name))');
        expect(USER_ROSTER_SELECT_QUERY).toContain('clearance_level:security_clearances');
        // AdminClientDetailView seeds its notes textarea straight off the roster row and
        // writes that local state back on Save — dropping the column is a SILENT WIPE, not
        // a blank textarea.
        expect(USER_ROSTER_SELECT_QUERY).toContain('admin_notes');
        expect(USER_ROSTER_SELECT_QUERY).toContain('personnel_notes');
        // SessionContext's hasChanged compares it; it carries admin remote radio control.
        expect(USER_ROSTER_SELECT_QUERY).toContain('voice_channel_name');
    });

    it('3. the DEGRADED FALLBACK constant stays wide — narrowing it disables session revocation', () => {
        // isSessionRevokedByWatermark reads tokensValidFrom off a getUserById result at
        // api/services.ts, api/query.ts, api/orgUpload.ts and server.ts. On a
        // half-migrated install where USER_SELECT_QUERY fails, this constant is what
        // resolves every session actor. A "let's just have one constant" simplification
        // is exactly what this catches.
        expect(USER_LIST_SELECT_QUERY).toContain('tokens_valid_from');
        expect(USER_LIST_SELECT_QUERY).toContain('rsi_handle_pending');
        expect(USER_LIST_SELECT_QUERY).toContain('rsi_verification_code');
        expect(USER_LIST_SELECT_QUERY).toContain('deleted_at');
        expect(USER_SELECT_QUERY).toContain('tokens_valid_from');
    });

    it('4. the roster projection is a STRICT SUBSET of the fallback', () => {
        expect(USER_ROSTER_SELECT_QUERY.length).toBeLessThan(USER_LIST_SELECT_QUERY.length);
        const fallback = columnTokens(USER_LIST_SELECT_QUERY);
        for (const col of columnTokens(USER_ROSTER_SELECT_QUERY)) {
            expect(fallback, `roster column ${col} is absent from the fallback constant`).toContain(col);
        }
    });

    it('5. BOTH roster call sites name the SAME constant (source-text, CRLF-safe)', () => {
        // mergeUsersSlice (lib/sliceMerge.ts) does a whole-row REPLACE, so a divergence
        // splices rows of a different shape into every connected client's allUsers array —
        // intermittent, reproduces only under realtime traffic, invisible in a page load.
        const sliceBody = fnBody(read('lib/db/users.ts'), 'export async function getUsersByIdsLite');
        expect(sliceBody).toContain('.select(USER_ROSTER_SELECT_QUERY)');
        expect(sliceBody).not.toContain('USER_LIST_SELECT_QUERY');

        const mainBody = fnBody(read('lib/db.ts'), 'async function getStaffMainState');
        expect(mainBody).toContain('.select(users.USER_ROSTER_SELECT_QUERY)');
        expect(mainBody).not.toContain('users.USER_LIST_SELECT_QUERY');
    });

    it('6. TG14 — a slice-merged row and a `main` row have the SAME KEY SET (the real invariant)', async () => {
        // The constant is only a PROXY for what mergeUsersSlice actually depends on. This
        // asserts the property itself, so a divergence introduced through toUser rather
        // than through the SELECT is caught too.
        const row = {
            id: 9, discord_id: 'd9', name: 'Ana', display_name: null, avatar_url: null,
            rsi_handle: 'ana', role_id: 2, reputation: 0, is_duty: false, is_affiliate: false,
            is_vip: false, created_at: '2026-01-01T00:00:00Z', admin_notes: null,
            personnel_notes: null, rsi_verified: true, job_title: null,
            voice_channel_name: null, timezone: null, date_format: null,
            probation_start: null, probation_end: null, tenure_start_date: null,
            role: { id: 2, name: 'Member', description: null, is_system: true, role_permissions: [] },
            rank: null, unit: null, position: null, secondaryPosition: null,
            clearance_level: null, specializations: [], certifications: [], commendations: [],
        };
        h.from = [];
        h.rows = { users: [row] };
        const main = await getMainState({ id: 1, isSystemAdmin: true, permissions: ['admin:access'] } as never);
        const slice = await getUsersByIdsLite([9]);
        const rosterRow = (main as { users?: unknown[] }).users?.[0] as Record<string, unknown>;
        expect(rosterRow, 'the staff bundle returned no roster row').toBeTruthy();
        expect(slice).toHaveLength(1);
        expect(Object.keys(rosterRow).sort()).toEqual(Object.keys(slice[0] as unknown as Record<string, unknown>).sort());
    });

    it('7. D4 — getUsersByIdsLite still THROWS on a query error (never safeFetch(…, []))', () => {
        // The two HR eligibility RPCs in the same cluster use safeFetch(…, []). The
        // inconsistency is deliberate: the client merge removes requested-but-absent ids,
        // so a silent [] here mass-evicts live users from every connected roster.
        const body = fnBody(read('lib/db/users.ts'), 'export async function getUsersByIdsLite');
        expect(body).toContain("handleSupabaseError({ error, message: 'Failed to get users slice' })");
        expect(body).not.toContain('safeFetch');
    });

    it('8. the CLIENT companions land with the narrowing (source-text)', () => {
        // Client files are outside the coverage gate, so a source scan is the right
        // instrument. Without these, a future "the roster does not carry these anyway"
        // cleanup deletes the preserve and silently reopens the RSI-gate escape: toUser
        // emits EVERY key, so the spread would overwrite the real value with `undefined`
        // and a mid-verification user would be handed the full app unverified.
        const src = read('contexts/SessionContext.tsx');
        expect(src).toContain('rsiHandlePending: prev.rsiHandlePending,');
        expect(src).toContain('rsiVerificationCode: prev.rsiVerificationCode,');
        // refresh=true is what re-engages the gate — hasChanged compares no RSI field.
        expect(src).toContain("simpleAction('user:initiate_rsi_update', { newHandle: handle }, true)");
        // and the two narratives name the constant that actually feeds the roster.
        expect(src).toContain('USER_ROSTER_SELECT_QUERY');
        expect(src).not.toContain('USER_LIST_SELECT_QUERY');
    });
});
