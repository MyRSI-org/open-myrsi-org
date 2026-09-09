import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Structural / parity guard for the realtime authorization layer (schema.sql §4.9,
// §5, §6, §6a, §6b).
//
// The op-board tactical-board channel is the ONE realtime path that ships CONTENT
// (broadcastBoardAdd emits the `element` object, broadcastBoardUpdate the `changes`
// object — lib/db/ops.ts), so the rt_recv_op_board RLS policy is the sole
// authorization for receiving it: any authenticated supabase-js client can subscribe
// to op-board-<id> directly. The policy MUST mirror the special-op participation gate
// that every TS read path enforces (canUserSeeOpInList / assertOpVisibleToUser,
// lib/db/ops.ts): a special operation is visible through clearance ONLY to the owner,
// operations:manage holders, and ACTIVE participants (operation_participants rows with
// time_left IS NULL) — a clearance-0 special op must NOT be readable by every member.
//
// §4.9 moved that predicate OUT of the policy and into the SECURITY DEFINER helper
// private.rt_can_read_op_board(), because a policy expression is evaluated with the
// CALLER's table privileges and §5 no longer grants role `authenticated` SELECT on
// public.operations / users / role_permissions. The gate therefore lives in two
// places now, and both are pinned here: the policy must delegate to the helper, and
// the helper must carry the gate.
//
// The §5 grant assertions are the other half of the same story: the blanket
// `GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated` this file used to
// carry put settings.value (the AES-GCM-encrypted Discord/LiveKit/Gemini secrets and
// the SETUP- admin code), api_keys.key_hash and alliance_peers.*_enc one PostgREST
// call away from any holder of a server-minted realtime JWT. Re-adding any blanket
// grant must fail CI.
//
// These are pure-Postgres objects, not exercisable against the vitest/jsdom mock
// suite, so we check their structure: parse them out of schema.sql (comments
// stripped) and assert on the logic. (A live end-to-end RLS check belongs in the
// opt-in rlsCrossOrg-style suite against a real Supabase project.)

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

// Extract a CREATE OR REPLACE FUNCTION <qualified name> ... $$; block. The bodies are
// dollar-quoted with a bare `$$`, so the first `$$;` after the header is the
// terminator (the opening delimiter is `$$` followed by a newline, never `$$;`).
function extractFunctionBody(sql: string, qualifiedName: string): string {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${qualifiedName}`);
    expect(start, `${qualifiedName} not found in schema.sql`).toBeGreaterThan(-1);
    const after = sql.slice(start);
    const end = after.indexOf('$$;');
    expect(end, `unterminated function ${qualifiedName}`).toBeGreaterThan(-1);
    return after.slice(0, end + 3);
}

// Strip SQL line comments so assertions pin the actual LOGIC, not the surrounding
// documentation (which also names these tokens).
function stripSqlComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, '');
}

describe('rt_recv_op_board realtime RLS policy (special-op participation gate)', () => {
    const schema = readSchema();
    const policy = stripSqlComments(extractPolicy(schema, 'rt_recv_op_board'));
    const predicate = stripSqlComments(extractFunctionBody(schema, 'private.rt_can_read_op_board'));

    it('replicates the special-op participation gate (is_special + operation_participants + time_left)', () => {
        // The exact tokens canUserSeeOpInList / assertOpVisibleToUser enforce server-side.
        expect(predicate, 'predicate must branch on o.is_special').toMatch(/is_special/);
        expect(predicate, 'predicate must check operation_participants membership').toMatch(/operation_participants/);
        // Active-participant discriminator: time_left IS NULL (mirrors ops.ts `.is('time_left', null)`).
        expect(predicate.replace(/\s+/g, ' ')).toMatch(/time_left\s+IS\s+NULL/i);
    });

    it('keeps the owner and operations:manage bypasses', () => {
        expect(predicate, 'owner bypass lost').toMatch(/owner_id\s*=\s*u\.id/);
        expect(predicate, 'operations:manage bypass lost').toMatch(/operations:manage/);
    });

    it('still enforces clearance level + limiting markers on the clearance branch', () => {
        expect(predicate, 'clearance-level check lost').toMatch(/clearance_level/);
        expect(predicate, 'limiting-marker check lost').toMatch(/operation_limiting_markers/);
        expect(predicate, 'per-user marker check lost').toMatch(/user_limiting_markers/);
    });

    it('remains scoped to op-board broadcast topics only (fails closed on malformed topics)', () => {
        expect(policy).toMatch(/extension\s*=\s*'broadcast'/);
        expect(policy).toMatch(/\^op-board-\[0-9a-fA-F-\]\{36\}\$/);
    });

    it('delegates to the helper rather than re-inlining the predicate', () => {
        // Re-inlining would need SELECT on public.operations/users/role_permissions for
        // role `authenticated`, which §5 revokes — the policy would silently read false.
        expect(policy).toMatch(/private\.rt_can_read_op_board\(/);
        expect(policy, 'policy must not read application tables directly').not.toMatch(/public\.operations/);
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

describe('SECTION 5 grant layer — authenticated is allowlisted, never blanket-granted', () => {
    const sql = stripSqlComments(readSchema());

    it('carries no blanket table or sequence grant to anon/authenticated', () => {
        expect(
            sql,
            'a blanket GRANT hands settings.value / api_keys.key_hash / alliance_peers.*_enc to any realtime JWT holder via /rest/v1',
        ).not.toMatch(/GRANT\s+(?:SELECT|ALL)[^;]*ON\s+ALL\s+(?:TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+public\s+TO[^;]*\b(?:anon|authenticated)\b/i);
        expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES[^;]*GRANT[^;]*ON\s+(?:TABLES|SEQUENCES)\s+TO[^;]*\b(?:anon|authenticated)\b/is);
    });

    it('sweeps the privileges existing installs already hold', () => {
        // Deleting a GRANT from a re-runnable script revokes nothing; only these do.
        expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+FROM\s+PUBLIC,\s*anon,\s*authenticated;/i);
        expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+ALL\s+SEQUENCES\s+IN\s+SCHEMA\s+public\s+FROM\s+PUBLIC,\s*anon,\s*authenticated;/i);
        expect(sql).toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+REVOKE\s+ALL\s+ON\s+TABLES\s+FROM\s+anon,\s*authenticated;/i);
        expect(sql).toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+REVOKE\s+ALL\s+ON\s+SEQUENCES\s+FROM\s+anon,\s*authenticated;/i);
    });

    it('revokes before it re-grants (a re-grant above the sweep would be wiped)', () => {
        expect(sql.indexOf('REVOKE ALL ON ALL TABLES'))
            .toBeLessThan(sql.indexOf('GRANT SELECT ON public.%I TO authenticated'));
        expect(sql.indexOf('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private'))
            .toBeLessThan(sql.indexOf('GRANT EXECUTE ON FUNCTION private.rt_is_live_member()'));
        expect(sql.indexOf('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private'))
            .toBeLessThan(sql.indexOf('GRANT EXECUTE ON FUNCTION private.rt_is_staff()'));
    });

    it('grants authenticated exactly: schema usage, the allowlisted table SELECT, the three policy helpers', () => {
        // The assertion that catches a future "just grant it one more table" edit.
        const grants = (sql.match(/GRANT[^;]*\bTO\b[^;]*authenticated[^;]*;/gi) || [])
            .map((g) => g.replace(/\s+/g, ' ').trim());
        expect(grants).toEqual([
            'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;',
            'GRANT SELECT ON public.%I TO authenticated;',
            'GRANT USAGE ON SCHEMA private TO authenticated;',
            'GRANT EXECUTE ON FUNCTION private.rt_is_live_member() TO authenticated;',
            'GRANT EXECUTE ON FUNCTION private.rt_can_read_op_board(text) TO authenticated;',
            'GRANT EXECUTE ON FUNCTION private.rt_is_staff() TO authenticated;',
        ]);
    });
});

describe('private.rt_client_tables() is the single source of truth for the realtime table set', () => {
    const schema = readSchema();
    const sql = stripSqlComments(schema);
    const body = stripSqlComments(extractFunctionBody(schema, 'private.rt_client_tables'));
    const tables = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    it('lists exactly the twelve low-sensitivity reference tables', () => {
        expect(tables).toEqual([
            'certifications', 'commendations', 'locations', 'personnel_positions',
            'radio_channels', 'ranks', 'roles', 'security_clearances',
            'security_limiting_markers', 'service_types', 'specialization_tags', 'units',
        ]);
    });

    it('excludes every table carrying a per-viewer access boundary', () => {
        // postgres_changes ships the FULL changed row, so anything the server filters
        // per viewer must never be in here. unit_posts and service_requests are named
        // explicitly because both have live client subscriptions that are already inert
        // (not in the publication) and are the tables a future reader is most likely to
        // "fix" by adding them here.
        for (const t of [
            'users', 'settings', 'api_keys', 'alliance_peers', 'hr_applications',
            'hr_interviews', 'hr_job_postings', 'hr_transfer_requests', 'intel_reports',
            'intel_bulletins', 'warrants', 'service_requests', 'operations',
            'notifications', 'push_subscriptions', 'external_tools', 'announcements',
            'synced_discord_roles', 'rank_mappings', 'unit_posts',
        ]) {
            expect(tables, `${t} must never be realtime-readable by role authenticated`).not.toContain(t);
        }
    });

    it('drives the §5 grant, both §6 loops and the §6a publication', () => {
        expect(sql).toContain('FOREACH t IN ARRAY private.rt_client_tables()');
        expect(sql).toContain('allowlist text[] := private.rt_client_tables();');
        expect(sql).toContain('FROM unnest(private.rt_client_tables()) AS t');
        expect(sql, 'publication membership must not be a fourth hand-maintained copy')
            .not.toMatch(/CREATE PUBLICATION supabase_realtime FOR TABLE\s+public\./);
    });
});

describe('realtime RLS policies do not read application tables as role authenticated', () => {
    const schema = readSchema();
    const sql = stripSqlComments(schema);

    it('the org-channel and reference-table policies delegate to the live-member helper', () => {
        expect(stripSqlComments(extractPolicy(schema, 'rt_recv_org_channels')))
            .toContain('private.rt_is_live_member()');
        // Pin WHICH predicate sits in WHICH arm. Split the branch and assert each arm
        // separately rather than windowing over the file: the two arms sit only ~300
        // stripped characters apart, so any window wide enough to reach the IF arm also
        // reaches the ELSE arm and matches whichever one satisfies it. A window-based
        // version of this stayed GREEN when the two policy literals were swapped.
        const branchAt = sql.indexOf('IF t = ANY (private.rt_customer_visible_tables())');
        expect(branchAt, 'the customer-visible/staff policy branch is gone').toBeGreaterThan(-1);
        const branch = sql.slice(branchAt, sql.indexOf('END IF;', branchAt));
        const elseAt = branch.indexOf('ELSE');
        expect(elseAt, 'the policy branch has no ELSE arm').toBeGreaterThan(-1);
        const ifArm = branch.slice(0, elseAt);
        const elseArm = branch.slice(elseAt);
        expect(ifArm, 'the customer-visible arm must stay live-member-only')
            .toContain('USING (private.rt_is_live_member());');
        expect(ifArm, 'the customer-visible arm must not require staff')
            .not.toContain('rt_is_staff');
        expect(elseArm, 'the DEFAULT arm must carry the staff conjunct — an unlisted table falls here')
            .toContain('USING (private.rt_is_live_member() AND private.rt_is_staff());');
        expect(sql, 'an inline read of public.users evaluates false once §5 revokes the grant')
            .not.toMatch(/CREATE POLICY authenticated_select[^;]*public\.users/);
    });

    it('all three helpers are SECURITY DEFINER with a pinned search_path', () => {
        for (const fn of ['private.rt_is_live_member', 'private.rt_can_read_op_board', 'private.rt_is_staff']) {
            const body = extractFunctionBody(schema, fn);
            expect(body, `${fn} must be SECURITY DEFINER or it cannot see past the deny-all policies`)
                .toMatch(/SECURITY DEFINER/);
            expect(body, `${fn} must pin its search_path`).toMatch(/SET search_path = public, pg_temp/);
        }
    });
});
