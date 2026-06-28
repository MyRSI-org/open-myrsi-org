import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Structural / parity guard for the op-board realtime RLS policy (schema.sql §6b).
//
// The op-board tactical-board channel is the ONE realtime path that ships CONTENT
// (broadcastBoardAdd emits the full `element` object, broadcastBoardUpdate the
// `changes` object — lib/db/ops.ts), so the rt_recv_op_board RLS policy is the sole
// authorization for receiving it: any authenticated supabase-js client can subscribe
// to op-board-<id> directly. The policy MUST mirror the special-op participation gate
// that every TS read path enforces (canUserSeeOpInList / assertOpVisibleToUser,
// lib/db/ops.ts): a special operation is visible through clearance ONLY to the owner,
// operations:manage holders, and ACTIVE participants (operation_participants rows with
// time_left IS NULL) — a clearance-0 special op must NOT be readable by every member.
//
// This is a pure-Postgres RLS policy, not exercisable against the vitest/jsdom mock
// suite, so we check its structure: parse the policy body out of schema.sql (comments
// stripped) and assert it references the special-op participation gate. The assertions
// require the policy to branch on is_special and operation_participants — not just the
// owner / operations:manage / clearance+marker branches — so the realtime authorization
// cannot silently drift away from the TS-side special-op read gate. (A live end-to-end
// RLS check belongs in the opt-in rlsCrossOrg-style suite against a real Supabase project.)

function readSchema(): string {
    return readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');
}

// Extract a CREATE POLICY <name> ... ); block as raw text (terminator is the first
// `);` after the CREATE POLICY keyword — nested EXISTS subqueries close with `)` and
// never `);`, so the first `);` is the policy terminator).
function extractPolicy(sql: string, name: string): string {
    const start = sql.indexOf(`CREATE POLICY ${name} `);
    expect(start, `CREATE POLICY ${name} not found in schema.sql`).toBeGreaterThan(-1);
    const after = sql.slice(start);
    const end = after.indexOf(');');
    expect(end, `unterminated CREATE POLICY ${name}`).toBeGreaterThan(-1);
    return after.slice(0, end + 2);
}

// Strip SQL line comments so assertions pin the actual policy LOGIC, not the
// surrounding documentation (which also names these tokens).
function stripSqlComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, '');
}

describe('rt_recv_op_board realtime RLS policy (special-op participation gate)', () => {
    const policy = stripSqlComments(extractPolicy(readSchema(), 'rt_recv_op_board'));

    it('replicates the special-op participation gate (is_special + operation_participants + time_left)', () => {
        // The exact tokens canUserSeeOpInList / assertOpVisibleToUser enforce server-side.
        expect(policy, 'policy must branch on o.is_special').toMatch(/is_special/);
        expect(policy, 'policy must check operation_participants membership').toMatch(/operation_participants/);
        // Active-participant discriminator: time_left IS NULL (mirrors ops.ts `.is('time_left', null)`).
        expect(policy.replace(/\s+/g, ' ')).toMatch(/time_left\s+IS\s+NULL/i);
    });

    it('keeps the owner and operations:manage bypasses', () => {
        expect(policy, 'owner bypass lost').toMatch(/owner_id\s*=\s*u\.id/);
        expect(policy, 'operations:manage bypass lost').toMatch(/operations:manage/);
    });

    it('still enforces clearance level + limiting markers on the clearance branch', () => {
        expect(policy, 'clearance-level check lost').toMatch(/clearance_level/);
        expect(policy, 'limiting-marker check lost').toMatch(/operation_limiting_markers/);
        expect(policy, 'per-user marker check lost').toMatch(/user_limiting_markers/);
    });

    it('remains scoped to op-board broadcast topics only (fails closed on malformed topics)', () => {
        expect(policy).toMatch(/extension\s*=\s*'broadcast'/);
        expect(policy).toMatch(/\^op-board-\[0-9a-fA-F-\]\{36\}\$/);
    });
});

describe('operation_participants schema supports the active-participant gate', () => {
    it('defines the time_left column the gate keys on', () => {
        const sql = readSchema();
        const tableStart = sql.indexOf('CREATE TABLE IF NOT EXISTS public.operation_participants');
        expect(tableStart, 'operation_participants table not found').toBeGreaterThan(-1);
        const tableDef = sql.slice(tableStart, sql.indexOf(');', tableStart) + 2);
        expect(tableDef, 'operation_participants.time_left column missing — RLS gate would fail to apply')
            .toMatch(/time_left\s+timestamptz/);
    });
});
