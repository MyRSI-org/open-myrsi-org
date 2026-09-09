import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PERMISSION_SATISFIED_BY, permissionSatisfied } from '../lib/permissionImplications';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { MEMBER_DEFAULT_PERMS, DISPATCHER_DEFAULT_PERMS } from '../lib/roleDefaultPermissions';
import { STAFF_VIEW_PERMS } from '../lib/staffPerms';
import { isViewer, isManager, isAwarder } from '../api/actions/academy';

// The shared permission-implication table (lib/permissionImplications.ts) and the
// gates that consume it.
//
// Two rules used to be hand-inlined at every gate that cared, and the copies had
// drifted: the intel:view ⇄ intel:view:clearance synonym existed at three server
// gates and neither client gate, and the Academy ladder existed on the client
// (AcademyHubView, pinned by tests/academyMenuGating.test.tsx) and in the db layer
// (assertCanEditCourse's canManage short-circuit) but at NO server gate.
//
// This suite pins three things:
//   1. The table's SHAPE — exactly three rows, pre-expanded, no sideways rows into
//      HR / warrants / marketplace / warehouse / finance, nothing a customer holds.
//   2. Both DIRECTIONS of every rung — ladders climb and never descend.
//   3. That the gates CONSULT the table instead of re-implementing it (source text),
//      so "an implication table nothing calls" cannot be the end state.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const KEYS = Object.keys(PERMISSION_SATISFIED_BY);
const VALUES = Object.values(PERMISSION_SATISFIED_BY).flatMap(v => [...v]);

function seededFromSchema(): Set<string> {
    const schema = read('schema.sql');
    const start = schema.indexOf('INSERT INTO public.permissions (name, description, category) VALUES');
    const block = schema.slice(start, schema.indexOf('ON CONFLICT', start));
    const set = new Set<string>();
    for (const m of block.matchAll(/\(\s*'([^']+)'\s*,/g)) set.add(m[1]);
    return set;
}

describe('PERMISSION_SATISFIED_BY — shape', () => {
    // A1. The deploy-seed contract. tests/permissionSeedParity.test.ts derives its
    // gated set by regexing `.includes('perm')` / hasPerm(...) call sites, which does
    // NOT match `permissionSatisfied`, so every string this table carries would
    // otherwise silently leave that contract as gates migrate onto the helper.
    it('every key and every value is seeded in schema.sql §7 (deploy contract)', () => {
        const seeded = seededFromSchema();
        expect(seeded.size).toBeGreaterThan(80); // guard against regex breakage
        const missing = [...KEYS, ...VALUES].filter(p => !seeded.has(p)).sort();
        expect(missing, `table entries not seeded in §7 (nobody could hold them on a fresh deploy):\n${missing.join('\n')}`).toEqual([]);
    });

    // A3. The anti-silent-widening tripwire. permissionSatisfied is consulted by the
    // read gate, the boot aggregate, the academy staff predicate and both client
    // gates, so a fourth row widens all of them at once. Adding one must be a
    // deliberate edit to THIS line, reviewed as a security change. DO NOT RELAX.
    it('has exactly three rows', () => {
        expect(KEYS.sort()).toEqual(['academy:instruct', 'academy:view', 'intel:view']);
    });

    // A2. Pre-expanded: the lookup is one level deep and never walks transitively, so
    // `academy:view` must list `academy:manage` itself rather than reaching it via
    // `academy:instruct`. Guards against a "simplification" that silently narrows.
    it('is pre-expanded — every alternative of an alternative is listed directly', () => {
        for (const [required, alts] of Object.entries(PERMISSION_SATISFIED_BY)) {
            for (const alt of alts) {
                const nested = PERMISSION_SATISFIED_BY[alt] ?? [];
                for (const deep of nested) {
                    expect(alts, `${required} must list ${deep} directly (reached via ${alt})`).toContain(deep);
                }
            }
        }
    });

    // A4. No sideways rows. Pins that HR case-file redaction, the clearance module's
    // write-side guard and the marketplace's ownership-only boundary cannot be
    // reached from here — inventing a ladder in any of those domains would widen the
    // bundle AND every slice subset that shares its gate string, at once.
    it('contains no key or value from an un-laddered domain', () => {
        const forbidden = ['hr:', 'warrant:', 'admin:', 'gov:', 'warehouse:', 'finance:', 'qm:', 'marketplace:', 'alliance:', 'wiki:', 'operations:', 'request:', 'fleet:', 'radio:', 'unit:', 'user:'];
        for (const p of [...KEYS, ...VALUES]) {
            for (const prefix of forbidden) {
                expect(p.startsWith(prefix), `${p} is in the implication table`).toBe(false);
            }
        }
    });

    // A5/D3 (general form). The docstring on STAFF_VIEW_PERMS names three perms
    // excluded ON PURPOSE because they are grantable to the org's external customers,
    // and the existing disjointness pin in tests/radioRoomAuthz.test.ts is a
    // STRING-SET test over that array. Once a gate consults the table, the effective
    // staff set is (list ∪ implications-of-list), so the invariant has to follow the
    // semantics: no customer-grantable permission may satisfy ANY staff perm.
    it('no customer-grantable permission satisfies a staff-view permission', () => {
        const customerGrantable = ['units:view_all', 'academy:view', 'marketplace:view', ...CLIENT_DEFAULT_PERMS];
        for (const customer of customerGrantable) {
            for (const p of STAFF_VIEW_PERMS) {
                expect(permissionSatisfied([customer], p), `${customer} -> ${p}`).toBe(false);
            }
        }
    });

    // A6. An empty alternatives array reads as if an implication exists and silently
    // does nothing; a self-implication is noise that hides a real row.
    it('no key implies itself and no alternatives array is empty', () => {
        for (const [required, alts] of Object.entries(PERMISSION_SATISFIED_BY)) {
            expect(alts.length, `${required} has no alternatives`).toBeGreaterThan(0);
            expect(alts, `${required} implies itself`).not.toContain(required);
        }
    });
});

describe('permissionSatisfied — fail-closed', () => {
    // A7.
    it('denies on an empty or missing permission array', () => {
        expect(permissionSatisfied([], 'intel:view')).toBe(false);
        expect(permissionSatisfied(undefined, 'intel:view')).toBe(false);
        expect(permissionSatisfied(null, 'intel:view')).toBe(false);
    });

    it('denies on an empty requirement', () => {
        expect(permissionSatisfied(['intel:view'], '')).toBe(false);
    });

    // A non-array `held` must never reach String.prototype.includes, where substring
    // matching would make 'intel:view:clearance'.includes('intel:view') true for
    // entirely the wrong reason — and would leak any permission that is a prefix of
    // another. aggHasPerm used to carry this guard inline; it lives in the helper now.
    it('denies on a truthy non-array held (no substring matching, no throw)', () => {
        expect(permissionSatisfied('intel:view:clearance' as unknown as string[], 'intel:view')).toBe(false);
        expect(permissionSatisfied({} as unknown as string[], 'intel:view')).toBe(false);
        expect(permissionSatisfied(42 as unknown as string[], 'intel:view')).toBe(false);
    });

    // A prototype-inherited name would otherwise resolve to a truthy non-array and
    // turn a denial into a 500 — the same hazard api/services.ts guards its action
    // dispatch against.
    it('denies on prototype-inherited requirement names instead of throwing', () => {
        for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
            expect(permissionSatisfied(['intel:view'], key), key).toBe(false);
        }
    });
});

describe('permissionSatisfied — ladders climb, never descend', () => {
    // A8. The second half is the direction that must never invert.
    it('intel:view:clearance satisfies intel:view, and not the reverse', () => {
        expect(permissionSatisfied(['intel:view:clearance'], 'intel:view')).toBe(true);
        expect(permissionSatisfied(['intel:view'], 'intel:view:clearance')).toBe(false);
    });

    // A9. The three false cases are the anti-widening half: academy:view is
    // documented as grantable to customers, so it must never climb into staff
    // authority, and an Instructor must never gain the Learning Manager's
    // approve/certify powers.
    it('academy: manage ⊇ instruct ⊇ view, in that direction only', () => {
        expect(permissionSatisfied(['academy:instruct'], 'academy:view')).toBe(true);
        expect(permissionSatisfied(['academy:manage'], 'academy:view')).toBe(true);
        expect(permissionSatisfied(['academy:manage'], 'academy:instruct')).toBe(true);
        expect(permissionSatisfied(['academy:view'], 'academy:instruct')).toBe(false);
        expect(permissionSatisfied(['academy:view'], 'academy:manage')).toBe(false);
        expect(permissionSatisfied(['academy:instruct'], 'academy:manage')).toBe(false);
    });

    // A10. No invented implications — every non-table string behaves exactly like a
    // bare includes().
    it('invents no implication outside the table', () => {
        expect(permissionSatisfied(['hr:view'], 'intel:view')).toBe(false);
        expect(permissionSatisfied(['warehouse:view'], 'finance:view')).toBe(false);
        expect(permissionSatisfied(['operations:view'], 'operations:manage')).toBe(false);
        expect(permissionSatisfied(['hr:view'], 'hr:recruiter')).toBe(false);
        expect(permissionSatisfied(['academy:manage'], 'admin:award:certification')).toBe(false);
    });
});

describe('the change is a strict no-op on every seeded role', () => {
    // The whole blast radius is meant to land on hand-crafted custom roles: Admin
    // holds every permission, and Member/Dispatcher hold BOTH intel strings and NO
    // academy string. Pin that as an executable property rather than prose — for
    // every permission any gate can ask for, the seeded arrays answer identically
    // before and after the refactor. The two arrays are the shared defaults the
    // seeder assigns on a fresh install (lib/roleDefaultPermissions.ts).
    const SEEDED: Record<string, readonly string[]> = {
        Member: MEMBER_DEFAULT_PERMS,
        Dispatcher: DISPATCHER_DEFAULT_PERMS,
    };

    function gateStrings(): string[] {
        const set = new Set<string>();
        const services = read('api/services.ts');
        for (const m of services.matchAll(/'[^']+'\s*:\s*'([a-z][a-z0-9_]*:[^']+)'/g)) set.add(m[1]);
        const query = read('api/query.ts');
        const i = query.indexOf('const SUBSET_REQUIRED_PERMISSION');
        const block = query.slice(i, query.indexOf('};', i));
        for (const m of block.matchAll(/:\s*'([a-z][a-z0-9_]*:[^']+)'/g)) set.add(m[1]);
        return [...set];
    }

    const gates = gateStrings();

    it('sanity: a meaningful number of gate strings were parsed', () => {
        expect(gates.length).toBeGreaterThan(80);
        expect(gates).toContain('intel:view');
        expect(gates).toContain('academy:view');
        expect(gates).toContain('academy:instruct');
    });

    for (const [role, perms] of Object.entries(SEEDED)) {
        it(`the seeded ${role} role answers every gate identically with and without the implication table`, () => {
            expect(perms.length).toBeGreaterThan(20);
            const widened = gates.filter(g => permissionSatisfied(perms, g) !== perms.includes(g));
            expect(widened, `${role} gains/loses: ${widened.join(', ')}`).toEqual([]);
        });
    }

    it('no seeded role holds an academy permission (the ladder has nobody to lift)', () => {
        for (const [role, perms] of Object.entries(SEEDED)) {
            expect(perms.filter(p => p.startsWith('academy:')), role).toEqual([]);
        }
    });

    // Admin is DEFINED as every permission, so it holds both intel strings and all
    // three academy strings outright — the table can only ever be redundant for it.
    it('an all-permissions Admin gains nothing (every gate already answers true)', () => {
        const all = [...new Set([...KEYS, ...VALUES, ...gates])];
        for (const g of gates) expect(permissionSatisfied(all, g), g).toBe(true);
    });
});

describe('api/actions/academy staff predicates', () => {
    // F1. The instructor who filed a student's outcome verdicts must be able to open
    // the student they filed them on — getEnrollmentDetail's self-or-staff gate.
    it('isViewer accepts academy:instruct and academy:manage through the ladder', () => {
        expect(isViewer({ permissions: ['academy:instruct'] })).toBe(true);
        expect(isViewer({ permissions: ['academy:manage'] })).toBe(true);
    });

    // F2. Anti-regression: hosted moved this predicate to 'academy:instruct', which
    // under the open build's meaning of academy:view (the STAFF read) would REMOVE
    // access a staff reader has today. Keep the question at academy:view.
    it('isViewer still accepts a plain academy:view staff reader', () => {
        expect(isViewer({ permissions: ['academy:view'] })).toBe(true);
    });

    // F3.
    it('isViewer denies an unprivileged custom role', () => {
        expect(isViewer({ permissions: [] })).toBe(false);
        expect(isViewer({ permissions: ['hr:recruiter'] })).toBe(false);
        expect(isViewer(undefined)).toBe(false);
    });

    // F4. isManager / isAwarder are deliberately NOT routed through the table:
    // nothing implies academy:manage or admin:award:certification, so the double gate
    // on certificate award (dispatcher academy:manage + handler
    // admin:award:certification) is untouched.
    it('isManager and isAwarder gain nothing from the ladder', () => {
        expect(isManager({ permissions: ['academy:instruct'] })).toBe(false);
        expect(isManager({ permissions: ['academy:view'] })).toBe(false);
        expect(isAwarder({ permissions: ['academy:manage'] })).toBe(false);
        expect(isAwarder({ permissions: ['academy:instruct'] })).toBe(false);
    });

    it('isManager and isAwarder still accept their own permission', () => {
        expect(isManager({ permissions: ['academy:manage'] })).toBe(true);
        expect(isAwarder({ permissions: ['admin:award:certification'] })).toBe(true);
    });
});

describe('the gates consult the table instead of re-implementing it', () => {
    // A11. Import parity, by source text. Server importers carry .js (Node16
    // resolution against the emitted tree); client importers must NOT (Vite/bundler)
    // — a missing .js breaks `npm run build:server` but NOT `npx tsc --noEmit`, so a
    // source-text pin is the cheapest thing that catches it either way.
    const serverSites: Array<[string, string]> = [
        ['api/query.ts', '../lib/permissionImplications.js'],
        ['lib/db.ts', './permissionImplications.js'],
        ['api/actions/academy.ts', '../../lib/permissionImplications.js'],
    ];
    for (const [file, spec] of serverSites) {
        it(`${file} imports permissionSatisfied with the .js extension`, () => {
            expect(read(file)).toContain(`import { permissionSatisfied } from '${spec}'`);
        });
    }

    const clientSites: Array<[string, string]> = [
        ['contexts/SessionContext.tsx', '../lib/permissionImplications'],
        ['contexts/DataCoreContext.tsx', '../lib/permissionImplications'],
    ];
    for (const [file, spec] of clientSites) {
        it(`${file} imports permissionSatisfied WITHOUT the .js extension`, () => {
            const src = read(file);
            expect(src).toContain(`import { permissionSatisfied } from '${spec}'`);
            expect(src).not.toContain(`from '${spec}.js'`);
        });
    }

    // …and the hand-inlined copies of the intel rule are gone from those files. Each
    // of these matched before the refactor; a re-introduced inline compare is a
    // second source of truth and is how the gates drifted the first time.
    it('the inlined intel:view ⇄ intel:view:clearance compares are gone', () => {
        expect(read('api/query.ts')).not.toMatch(/requiredPerm === 'intel:view' && perms\.includes/);
        expect(read('lib/db.ts')).not.toMatch(/aggHasPerm\(currentUser, 'intel:view:clearance'\)/);
        expect(read('contexts/DataCoreContext.tsx')).not.toMatch(/hasPerm\('intel:view:clearance'\)/);
    });

    // The client's universal gate implemented NEITHER synonym before this change, so
    // an intel:view:clearance-only role was served the intel subset by the server and
    // shown no Intel nav by the browser.
    it('SessionContext.hasPermission routes through the table, not a bare includes', () => {
        const src = read('contexts/SessionContext.tsx');
        expect(src).toMatch(/return permissionSatisfied\(currentUser\.permissions, permission\)/);
        expect(src).not.toMatch(/return currentUser\.permissions\?\.includes\(permission\)/);
    });
});
