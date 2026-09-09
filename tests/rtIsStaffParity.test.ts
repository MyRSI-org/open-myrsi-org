import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hasAnyStaffViewPerm } from '../lib/staffPerms';
import { CLIENT_DEFAULT_PERMS, CUSTOMER_GRANTABLE_PERMS } from '../lib/clientRolePermissions';
import { ROSTER_AUTHORITY_PERMS } from '../lib/rosterGate';
import { CLEARANCE_VISIBLE_PERMS } from '../lib/db/userFilters';

// The SQL <-> TypeScript parity gate for private.rt_is_staff() (schema.sql §4.9).
//
// rt_is_staff() is defined as the COMPLEMENT of the customer-grantable permission set,
// not as a mirror of the TypeScript staff allowlists — because an allowlist mirror
// would misclassify 72 of the 110 seeded permissions as customer and cut real staff on
// custom roles off from their own org's live reference-table updates.
//
// The whole safety of that shape rests on ONE fact: private.rt_customer_perms() is the
// COMPLETE set of things an org may grant an external customer. If it is short by even
// one string, a customer holding that string falls outside the customer set, satisfies
// rt_is_staff(), and keeps the entire PostgREST read the item exists to close — the
// role table, the unit tree and the classification taxonomy, INCLUDING
// security_limiting_markers.sync_restricted, the flag marking compartments that must
// never leave the org. That is not hypothetical: the first draft mirrored
// CLIENT_DEFAULT_PERMS (three strings) and left academy:view, units:view_all and
// marketplace:view — all three seeded, all three documented in lib/staffPerms.ts as
// grantable to customers — on the STAFF side of the boundary.
//
// So this file pins the set from three directions: SQL == TypeScript (exact), every
// member is non-staff (behavioural), and the lib/staffPerms.ts docstring names nothing
// the machine set is missing (the tripwire that catches the FOURTH one).

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const schema = () => read('schema.sql');

// Anchored on the '(' so a future private.rt_is_staff_v2 cannot be picked up in place
// of private.rt_is_staff. Proven by the harness self-test at the bottom of this file.
function functionBody(sql: string, qualifiedName: string): string {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${qualifiedName}(`);
    expect(start, `${qualifiedName} not found in schema.sql`).toBeGreaterThan(-1);
    const after = sql.slice(start);
    const end = after.indexOf('$$;');
    expect(end, `unterminated ${qualifiedName}`).toBeGreaterThan(-1);
    return after.slice(0, end + 3);
}

// Quoted string literals from a function body, comments stripped first so a permission
// named in a `--` line cannot be scraped as if it were in the array.
function sqlArray(sql: string, qualifiedName: string): string[] {
    const body = functionBody(sql, qualifiedName).replace(/--[^\n]*/g, '');
    return [...body.matchAll(/'([a-z_][a-z_:]*)'/g)].map((m) => m[1]);
}

describe('private.rt_customer_perms() mirrors CUSTOMER_GRANTABLE_PERMS exactly', () => {
    it('is exactly the same strings as the TypeScript set', () => {
        expect(sqlArray(schema(), 'private.rt_customer_perms').sort())
            .toEqual([...CUSTOMER_GRANTABLE_PERMS].sort());
    });

    it('is a SUPERSET of CLIENT_DEFAULT_PERMS (the seeded Client role must read as a customer)', () => {
        for (const p of CLIENT_DEFAULT_PERMS) {
            expect(CUSTOMER_GRANTABLE_PERMS, `${p} is seeded on the Client role`).toContain(p);
        }
    });

    it('is NEVER EMPTY — an empty array silently inverts the whole predicate', () => {
        // `x <> ALL (empty array)` is vacuously TRUE in Postgres, so emptying
        // rt_customer_perms() would make arm (B) fire for every account holding any
        // permission at all: every customer becomes staff, fail-OPEN, with no other
        // assertion in this file able to notice (an exact-equality check between two
        // empty sets passes).
        expect(sqlArray(schema(), 'private.rt_customer_perms').length).toBeGreaterThan(0);
        expect(CUSTOMER_GRANTABLE_PERMS.length).toBeGreaterThan(0);
    });

    it('contains the pseudo-permission user:manage:self', () => {
        // api/services.ts short-circuits this one to mean "any authenticated user", so
        // it says nothing about being staff — but it is a real, tickable catalog row and
        // a Member/Dispatcher default. Omitting it classified any customer on a bespoke
        // role that happened to carry it as STAFF in SQL while TypeScript still called
        // them a customer, which handed back the entire read this boundary closes.
        expect(CUSTOMER_GRANTABLE_PERMS).toContain('user:manage:self');
    });

    it('is disjoint from the roster-authority lists arm (B) claims to subsume', () => {
        // schema.sql §4.9 asserts every entry of these is outside the customer set. That
        // claim was previously documented as "pinned by tests/rtIsStaffParity.test.ts"
        // while this file never referenced them — a comment describing a test that did
        // not exist. These two are exported and therefore rename-safe to import.
        for (const p of [...ROSTER_AUTHORITY_PERMS, ...CLEARANCE_VISIBLE_PERMS]) {
            expect(
                CUSTOMER_GRANTABLE_PERMS,
                `${p} is a roster/clearance authority permission and must not be customer-grantable`,
            ).not.toContain(p);
        }
    });

    it('every member is NON-STAFF by the TypeScript gate', () => {
        // The assertion that can actually go red for the reason the boundary can be
        // wrong: a string that is staff here but customer in SQL means the two gates
        // disagree about the same account.
        for (const p of CUSTOMER_GRANTABLE_PERMS) {
            expect(
                hasAnyStaffViewPerm([p]),
                `${p} is in the SQL customer set but reads as STAFF in TypeScript`,
            ).toBe(false);
        }
    });

    it('neither constant helper is granted to authenticated', () => {
        // Both are called only from inside a SECURITY DEFINER body or the §6 DO block,
        // which run as the owner and the applying superuser respectively.
        expect(schema()).not.toMatch(/GRANT EXECUTE ON FUNCTION private\.rt_customer_perms/);
        expect(schema()).not.toMatch(/GRANT EXECUTE ON FUNCTION private\.rt_customer_visible_tables/);
    });
});

describe('the lib/staffPerms.ts docstring and the machine set agree', () => {
    it('every permission documented as customer-grantable is in CUSTOMER_GRANTABLE_PERMS', () => {
        // The tripwire for the NEXT one. academy:view / units:view_all / marketplace:view
        // escaped into the staff half precisely because the docstring recorded them and
        // no machine-readable set did. Red the moment a FOURTH is documented without
        // being hoisted into CUSTOMER_GRANTABLE_PERMS.
        const doc = read('lib/staffPerms.ts');
        const i = doc.indexOf('grantable to customers');
        expect(i, 'the lib/staffPerms.ts customer-grantable docstring has moved or been deleted')
            .toBeGreaterThan(-1);
        const sentence = doc.slice(Math.max(0, i - 400), i + 200);
        const named = [...sentence.matchAll(/`([a-z_]+:[a-z_:]+)`/g)].map((m) => m[1]);
        expect(named.length, 'the docstring scrape matched nothing — the wording moved')
            .toBeGreaterThanOrEqual(3);
        for (const p of named) {
            expect(
                CUSTOMER_GRANTABLE_PERMS,
                `${p} is documented customer-grantable but is not in the SQL customer set`,
            ).toContain(p);
        }
    });
});

describe('private.rt_customer_visible_tables() is an EMPTY allowlist over rt_client_tables()', () => {
    it('is empty — all twelve reference tables are staff-only', () => {
        // The phase-headline assertion for Route A. Adding a table here is a deliberate
        // decision to publish it to the org's external customers, and this goes red so
        // that it cannot be made silently.
        expect(sqlArray(schema(), 'private.rt_customer_visible_tables')).toEqual([]);
    });

    it('every entry would also have to be in rt_client_tables() (a name outside it is inert)', () => {
        const client = sqlArray(schema(), 'private.rt_client_tables');
        for (const t of sqlArray(schema(), 'private.rt_customer_visible_tables')) {
            expect(client, `${t} is customer-visible but gets no policy at all`).toContain(t);
        }
    });

    it('the three tables the phase headline names are NOT customer-visible', () => {
        const visible = sqlArray(schema(), 'private.rt_customer_visible_tables');
        for (const t of ['roles', 'security_clearances', 'security_limiting_markers']) {
            expect(visible, `${t} must not be readable by an external customer`).not.toContain(t);
        }
    });
});

// Strip comments FIRST, always. The §6 loop's own rationale block contains the words
// "IF" and "ELSE" and both predicate names in prose, so a regex run against raw schema
// text can match DOCUMENTATION instead of code. That is not hypothetical: the first
// version of the assertion below anchored on /ELSE[\s\S]{0,600}.../ and stayed GREEN
// while the two arms were swapped, because it was matching the word "ELSE" inside the
// comment that explains the arms.
function policyArms(): { ifArm: string; elseArm: string } {
    const sql = schema().replace(/--[^\n]*/g, '');
    const start = sql.indexOf('IF t = ANY (private.rt_customer_visible_tables())');
    expect(start, 'the policy branch is gone — the staff split was reverted').toBeGreaterThan(-1);
    const end = sql.indexOf('END IF;', start);
    expect(end, 'unterminated policy branch').toBeGreaterThan(-1);
    const block = sql.slice(start, end);
    const elseAt = block.indexOf('ELSE');
    expect(elseAt, 'the policy branch has no ELSE arm').toBeGreaterThan(-1);
    return { ifArm: block.slice(0, elseAt), elseArm: block.slice(elseAt) };
}

describe('the §6 policy loop composes the two predicates correctly', () => {
    it('the arms are not swapped — staff is the DEFAULT, customer-visible is the exception', () => {
        // Split and assert each arm separately rather than windowing over the file: the
        // two arms are only ~300 characters apart once comments are stripped, so any
        // window wide enough to reach one reaches the other and pins neither.
        const { ifArm, elseArm } = policyArms();
        expect(elseArm, 'the ELSE (default) arm must require staff')
            .toContain('USING (private.rt_is_live_member() AND private.rt_is_staff());');
        expect(ifArm, 'the customer-visible arm must NOT require staff — that is what makes it customer-visible')
            .not.toContain('rt_is_staff');
        expect(ifArm, 'the customer-visible arm must still require a live member')
            .toContain('USING (private.rt_is_live_member());');
    });

    it('rt_is_staff() is never used alone — it is not a liveness gate', () => {
        // It deliberately does not re-check deleted_at / tokens_valid_from, so a policy
        // using it on its own would admit a deleted or session-revoked staff account.
        const sql = schema();
        const uses = [...sql.matchAll(/private\.rt_is_staff\(\)/g)].map((m) => m.index ?? 0);
        // the definition, the §5 grant, and the one §6 policy literal
        expect(uses.length).toBeGreaterThanOrEqual(3);
        for (const at of uses) {
            const line = sql.slice(sql.lastIndexOf('\n', at) + 1, sql.indexOf('\n', at));
            if (line.trimStart().startsWith('--')) continue; // prose about the helper, not a call
            if (line.includes('CREATE OR REPLACE FUNCTION') || line.includes('GRANT EXECUTE ON FUNCTION')) continue;
            expect(
                line,
                `rt_is_staff() must be composed as rt_is_live_member() AND rt_is_staff(): ${line.trim()}`,
            ).toContain('private.rt_is_live_member() AND private.rt_is_staff()');
        }
    });

    it('carries both arms: the Admin identity and the permission complement', () => {
        const body = functionBody(schema(), 'private.rt_is_staff');
        // Arm (A) must mirror lib/db/adminIdentity.ts isSystemAdminRole in shape:
        // is_system AND a case-folded, trimmed literal 'admin'.
        expect(body).toContain("r.is_system IS TRUE AND lower(btrim(r.name)) = 'admin'");
        // Arm (B) must be the COMPLEMENT, not a membership test — `= ANY` here would
        // invert the boundary and classify every customer as staff.
        expect(body).toContain('p.name <> ALL (private.rt_customer_perms())');
        expect(body, 'a LEFT JOIN keeps arm (B) reachable for a non-Admin role')
            .toContain('LEFT JOIN public.roles r ON r.id = u.role_id');
    });
});

describe('harness self-test', () => {
    it('functionBody picks the exact name, not a longer one sharing its prefix', () => {
        const synthetic = [
            'CREATE OR REPLACE FUNCTION private.rt_is_staff_v2()',
            'RETURNS boolean LANGUAGE sql AS $$ SELECT false; $$;',
            '',
            'CREATE OR REPLACE FUNCTION private.rt_is_staff()',
            "RETURNS boolean LANGUAGE sql AS $$ SELECT 'correct-one'; $$;",
        ].join('\n');
        expect(functionBody(synthetic, 'private.rt_is_staff')).toContain('correct-one');
        expect(functionBody(synthetic, 'private.rt_is_staff')).not.toContain('SELECT false');
    });

    it('sqlArray ignores permission names that appear only in comments', () => {
        const synthetic = [
            'CREATE OR REPLACE FUNCTION private.rt_customer_perms()',
            "-- NOT a member: 'intel:view' is staff and must never be scraped from here.",
            "RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['request:create']::text[]; $$;",
        ].join('\n');
        expect(sqlArray(synthetic, 'private.rt_customer_perms')).toEqual(['request:create']);
    });
});
