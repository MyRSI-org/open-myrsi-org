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
// that every TS read path enforces (canUserSeeOpInList / operation:get_details / the
// read form of assertOpVisibleToUser, all via hasOpReadParticipation in lib/db/ops.ts):
// a special operation is visible through clearance ONLY to the owner, operations:manage
// holders, and participants — ANY operation_participants row, current or former
// (owner-approved 2026-11-02: a row whose time_left was stamped when the op concluded
// keeps READ access; leaving or being removed deletes the row). A clearance-0 special
// op must NOT be readable by every member.
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

// CRLF-normalised: the local tree is CRLF and CI checks out LF, so any assertion that
// spans a line break must see the same bytes in both places.
function readSchema(): string {
    return readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8').replace(/\r\n/g, '\n');
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

    it('replicates the special-op READ participation gate (is_special + ANY operation_participants row)', () => {
        // The exact tokens canUserSeeOpInList / hasOpReadParticipation enforce server-side.
        expect(predicate, 'predicate must branch on o.is_special').toMatch(/is_special/);
        expect(predicate, 'predicate must check operation_participants membership').toMatch(/operation_participants/);
        // CONVERTED (owner decision 2026-11-02): the board is a READ, so a FORMER
        // participant (time_left stamped at conclusion) is admitted exactly as the TS
        // list / slice / detail paths admit them. The participation EXISTS is pinned
        // WHOLE — keyed on (operation, user) and nothing else — so neither a re-added
        // time_left filter nor a dropped user term can slip in.
        const flat = predicate.replace(/\s+/g, ' ');
        expect(flat).toContain(
            'NOT COALESCE(o.is_special, false) OR EXISTS ( SELECT 1 FROM public.operation_participants opp WHERE opp.operation_id = o.id AND opp.user_id = u.id ) )',
        );
        expect(flat, 'the board predicate must not narrow READS to active participants').not.toMatch(/time_left/i);
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

    it('requires operations:view on the clearance branch — clearance alone is not a right to read ops', () => {
        // Without it, any live account whose clearance met the op's level could receive
        // the board's deltas — a self-registered Client sits at Level 1 by default and
        // holds a realtime token — while every in-app op read needs operations:view.
        // Pin the WHOLE disjunction so the term cannot drift into its own OR arm (which
        // would admit every operations:view holder regardless of clearance), onto the
        // owner/manage arms, or out of the clearance arm.
        const flat = predicate.replace(/\s+/g, ' ');
        const roleHas = (perm: string) =>
            `EXISTS \\( SELECT 1 FROM public\\.role_permissions rp JOIN public\\.permissions p ON p\\.id = rp\\.permission_id WHERE rp\\.role_id = u\\.role_id AND p\\.name = '${perm}' \\)`;
        expect(flat).toMatch(new RegExp(
            `AND \\( o\\.owner_id = u\\.id OR ${roleHas('operations:manage')} OR \\( ${roleHas('operations:view')} AND \\( NOT COALESCE\\(o\\.is_special, false\\) OR EXISTS \\(`,
        ));
        // Exactly one operations:view term — not also OR'd in somewhere else.
        expect(flat.match(/'operations:view'/g) ?? []).toHaveLength(1);
        // The rest of the clearance arm still follows it, ANDed.
        expect(flat).toMatch(/\) \) AND COALESCE\(o\.clearance_level, 0\) <= COALESCE\(sc\.level, 0\) AND NOT EXISTS \( SELECT 1 FROM public\.operation_limiting_markers olm/);
    });
});

describe('treasury rejection reasons live in an APPROVER-ONLY column, never in notes', () => {
    const schema = readSchema();
    const sql = stripSqlComments(schema);
    const MARKER_SQL = "E'\\n[rejected] '";

    it('adds the column with a re-runnable ALTER, after the table and before anything reads it', () => {
        const alter = 'ALTER TABLE public.treasury_ledger_entries ADD COLUMN IF NOT EXISTS rejection_reason text;';
        expect(sql).toContain(alter);
        expect(sql.indexOf('CREATE TABLE IF NOT EXISTS public.treasury_ledger_entries'))
            .toBeLessThan(sql.indexOf(alter));
        expect(sql.indexOf(alter)).toBeLessThan(sql.indexOf('UPDATE public.treasury_ledger_entries\n   SET rejection_reason'));
        expect(sql.indexOf(alter)).toBeLessThan(sql.indexOf('CREATE OR REPLACE FUNCTION public.finance_reject_entry'));
    });

    it('finance_reject_entry writes the reason to rejection_reason and leaves notes alone', () => {
        const body = stripSqlComments(extractFunctionBody(schema, 'public.finance_reject_entry'));
        expect(body).toMatch(/rejection_reason = NULLIF\(p_reason, ''\)/);
        expect(body, 'the reason must not be appended to notes — finance:view holders read notes').not.toMatch(/\bnotes\b/);
        expect(body).not.toContain('[rejected]');
        // Unchanged idempotency gate.
        expect(body).toMatch(/WHERE id = p_entry_id AND status = 'pending'/);
    });

    it('moves legacy notes tails into the column, idempotently, touching only the rows the old function produced', () => {
        const at = sql.indexOf('UPDATE public.treasury_ledger_entries\n   SET rejection_reason');
        expect(at, 'the legacy-notes migration is missing').toBeGreaterThan(-1);
        const stmt = sql.slice(at, sql.indexOf(';', at) + 1).replace(/\s+/g, ' ');
        // The offset is the marker's length: substr starts right after it.
        expect('\n[rejected] '.length).toBe(12);
        expect(stmt).toContain(`SET rejection_reason = substr(notes, strpos(notes, ${MARKER_SQL}) + 12)`);
        expect(stmt).toContain(`notes = NULLIF(left(notes, strpos(notes, ${MARKER_SQL}) - 1), '')`);
        // Re-run safety: every row it rewrites stops matching (marker gone, column set).
        expect(stmt).toContain(`WHERE status = 'rejected' AND rejection_reason IS NULL AND strpos(notes, ${MARKER_SQL}) > 0;`);
    });
});

describe('push_subscriptions scrub drops the injected user record from stored subscriptions', () => {
    const sql = stripSqlComments(readSchema());

    it('rebuilds subscription from endpoint + keys only, and only for rows carrying anything else', () => {
        const at = sql.indexOf('UPDATE public.push_subscriptions');
        expect(at, 'the push_subscriptions scrub is missing').toBeGreaterThan(-1);
        expect(at, 'the scrub must run after the table exists')
            .toBeGreaterThan(sql.indexOf('CREATE TABLE IF NOT EXISTS public.push_subscriptions'));
        const stmt = sql.slice(at, sql.indexOf(';', at) + 1).replace(/\s+/g, ' ');
        // The rebuilt value: exactly endpoint + keys{p256dh, auth}, preferring the vetted columns.
        expect(stmt).toContain(
            "SET subscription = jsonb_build_object( 'endpoint', COALESCE(endpoint, subscription->>'endpoint'), "
            + "'keys', jsonb_build_object( 'p256dh', COALESCE(p256dh, subscription->'keys'->>'p256dh'), "
            + "'auth', COALESCE(auth, subscription->'keys'->>'auth')))",
        );
        // Matches any object holding a key outside the allowlist — the `user` record
        // included — and nothing the rebuild produces, so a second run is a no-op.
        expect(stmt).toContain("WHEN jsonb_typeof(subscription) = 'object' THEN (subscription - ARRAY['endpoint', 'keys', 'expirationTime']) <> '{}'::jsonb");
        expect(stmt).not.toMatch(/'user'/);
    });
});

describe('operation_participants schema supports the active-participant WRITE gate', () => {
    it('defines the time_left column the server-side write gate keys on', () => {
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

describe('§4.2d atomic replace-set writers (op limiting markers, role permissions)', () => {
    const schema = readSchema();
    const sql = stripSqlComments(schema);
    const flat = (s: string) => s.replace(/\s+/g, ' ');

    const WRITERS = [
        {
            fn: 'public.op_replace_limiting_markers', sig: 'uuid, integer[]', code: 'OP_MARKERS',
            parent: 'operations', child: 'operation_limiting_markers', key: 'operation_id', col: 'marker_id',
            idTable: 'security_limiting_markers', pParent: 'p_operation_id', pIds: 'p_marker_ids',
        },
        {
            fn: 'public.set_role_permissions', sig: 'integer, integer[]', code: 'ROLE_PERMS',
            parent: 'roles', child: 'role_permissions', key: 'role_id', col: 'permission_id',
            idTable: 'permissions', pParent: 'p_role_id', pIds: 'p_permission_ids',
        },
    ];

    it.each(WRITERS)('$fn is re-run safe, invoker-rights with a pinned search_path, and granted to service_role ONLY', ({ fn, sig }) => {
        const body = extractFunctionBody(schema, fn);
        // CREATE OR REPLACE with a stable signature is what makes a hand re-run safe.
        expect(body.startsWith(`CREATE OR REPLACE FUNCTION ${fn}(`)).toBe(true);
        expect(flat(body)).toContain(') RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$');
        // Invoker rights, like every other §4 writer: the server's service-role key is the caller.
        expect(body).not.toMatch(/SECURITY DEFINER/);
        // Exactly ONE grant names it, to service_role: without its own line a partial paste
        // is a 42501 at runtime, and a grant to anon/authenticated would expose it over
        // PostgREST to any browser token.
        const mine = (sql.match(/GRANT[^;]*;/g) ?? []).filter((g) => g.includes(`${fn}(`));
        expect(mine).toEqual([`GRANT EXECUTE ON FUNCTION ${fn}(${sig}) TO service_role;`]);
    });

    it.each(WRITERS)('$fn validates BEFORE it writes, then deletes + inserts in the SAME call', ({ fn, code, parent, child, key, col, idTable, pParent, pIds }) => {
        const body = flat(stripSqlComments(extractFunctionBody(schema, fn)));
        const at = (needle: string) => {
            const i = body.indexOf(needle);
            expect(i, `${fn} is missing: ${needle}`).toBeGreaterThan(-1);
            return i;
        };
        const nullArray = at(`IF ${pIds} IS NULL THEN RAISE EXCEPTION '${code}_INVALID`);
        const nullElem = at(`IF array_position(${pIds}, NULL) IS NOT NULL THEN RAISE EXCEPTION '${code}_INVALID`);
        const dupes = at(`<> v_count THEN RAISE EXCEPTION '${code}_INVALID: duplicate`);
        const lock = at(`PERFORM 1 FROM public.${parent} WHERE id = ${pParent} FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '${code}_NO_`);
        const known = at(`SELECT count(*) INTO v_known FROM public.${idTable} WHERE id = ANY (${pIds}); IF v_known <> v_count THEN RAISE EXCEPTION '${code}_UNKNOWN`);
        const del = at(`DELETE FROM public.${child} WHERE ${key} = ${pParent};`);
        const ins = at(`INSERT INTO public.${child} (${key}, ${col}) SELECT ${pParent},`);
        // Every refusal precedes the first write, and the delete precedes the insert —
        // a RAISE anywhere rolls the whole call back, so there is no partial write.
        expect(Math.max(nullArray, nullElem, dupes, lock, known)).toBeLessThan(del);
        expect(del).toBeLessThan(ins);
        // Exactly one delete and one insert, on the one child table: nothing else is touched.
        expect(body.match(/\bDELETE FROM\b/g)).toHaveLength(1);
        expect(body.match(/\bINSERT INTO\b/g)).toHaveLength(1);
        expect(body).not.toMatch(/\bUPDATE\s+public\./);
    });

    it('the Client-role lock is NOT duplicated into SQL (lib/db/clientRoleLock.ts is its one definition)', () => {
        const body = stripSqlComments(extractFunctionBody(schema, 'public.set_role_permissions'));
        expect(body).not.toMatch(/client/i);
        expect(body).not.toMatch(/is_system/);
    });
});

describe('§6b records the op-board content exception to "realtime carries ids only"', () => {
    const schema = readSchema();

    it('the comment sits with the policy and names both content-bearing senders', () => {
        const at = schema.indexOf('THE ONE DELIBERATE EXCEPTION TO "REALTIME CARRIES IDS, NEVER CONTENT"');
        expect(at, 'the rule-4 exception note is missing from §6b').toBeGreaterThan(-1);
        expect(at).toBeGreaterThan(schema.indexOf('SECTION 6b — Realtime Authorization'));
        expect(at).toBeLessThan(schema.indexOf('CREATE POLICY rt_recv_op_board '));
        const note = schema.slice(at, schema.indexOf('CREATE POLICY rt_recv_op_board '));
        expect(note).toContain('broadcastBoardAdd');
        expect(note).toContain('broadcastBoardUpdate');
        expect(note).toContain('tests/opBoardDeltaException.test.ts');
    });
});
