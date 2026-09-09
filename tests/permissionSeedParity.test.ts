import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Permission seed parity (deploy-correctness rule).
// A fresh Supabase deploy runs ONLY schema.sql — its §7 INSERT is THE seed of
// the permissions table. The seeder (lib/db/seeder.ts) then grants Admin every
// permission that EXISTS; it inserts none itself. So a permission the app gates
// on that is MISSING from §7 can never be held by anyone on a fresh install
// (the feature is dead until an admin manually runs "repair database").
//
// This test enforces three contracts:
//   1. Every permission the SERVER gates on is seeded in schema.sql §7.
//   2. The repair backstop (lib/db/system.ts GLOBAL_PERMISSIONS) stays in
//      PARITY with §7, so "repair database" can fully self-heal.
//   3. (informational) reports §7 permissions no server path gates on.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel.split('/').join('/')), 'utf8');

function seededFromSchema(): Set<string> {
    const schema = read('schema.sql');
    const start = schema.indexOf('INSERT INTO public.permissions (name, description, category) VALUES');
    const block = schema.slice(start, schema.indexOf('ON CONFLICT', start));
    const set = new Set<string>();
    for (const m of block.matchAll(/\(\s*'([^']+)'\s*,/g)) set.add(m[1]);
    return set;
}

function globalPermissions(): Set<string> {
    const sys = read('lib/db/system.ts');
    const i = sys.indexOf('const GLOBAL_PERMISSIONS = [');
    const block = sys.slice(i, sys.indexOf('];', i));
    const set = new Set<string>();
    for (const m of block.matchAll(/name:\s*'([^']+)'/g)) set.add(m[1]);
    return set;
}

// Inline server-side gate calls, by shape. `permissionSatisfied` is on this list
// because gates are migrating off bare `.includes()` onto the shared implication
// table (lib/permissionImplications.ts). A gate helper the alternation does not name
// is INVISIBLE to this scanner: the gate keeps working and its permission silently
// drops out of the deploy-seed contract below, with nothing going red. The loss is
// structural and grows with every migration, so the alternation has to learn each new
// helper as it appears — pinned by the gate-shape self-test at the bottom of the file,
// which consumes this same factory.
const gateCallRe = () => /\.includes\(\s*'([a-z][a-z0-9_]*:[a-z0-9_:]+)'\s*\)|(?:hasPerm|aggHasPerm|hasPermission|permissionSatisfied)\(\s*(?:[^,]+,\s*)?'([a-z][a-z0-9_]*:[a-z0-9_:]+)'/g;

function gatedPermissions(): Set<string> {
    const set = new Set<string>();
    // fullPermissionMap values: 'action': 'permission'
    const services = read('api/services.ts');
    for (const m of services.matchAll(/'[^']+'\s*:\s*'([a-z][a-z0-9_]*:[^']+)'/g)) set.add(m[1]);
    // SUBSET_REQUIRED_PERMISSION values: subset: 'permission'
    const query = read('api/query.ts');
    for (const m of query.matchAll(/[a-z_]+\s*:\s*'([a-z][a-z0-9_]*:[^']+)'/g)) set.add(m[1]);
    // inline server-side checks
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.ts')) files.push(p);
        }
    };
    walk('lib'); walk('api');
    const re = gateCallRe();
    for (const f of files) {
        for (const m of read(f).matchAll(re)) {
            const perm = m[1] || m[2];
            if (perm) set.add(perm);
        }
    }
    return set;
}

describe('permission seed parity', () => {
    const seeded = seededFromSchema();
    const global = globalPermissions();
    const gated = gatedPermissions();

    it('every server-gated permission is seeded in schema.sql §7 (deploy contract)', () => {
        const missing = [...gated].filter(p => !seeded.has(p)).sort();
        expect(missing, `gated-but-unseeded (nobody could ever hold these on a fresh deploy):\n${missing.join('\n')}`).toEqual([]);
    });

    it('GLOBAL_PERMISSIONS repair backstop is in parity with schema.sql §7', () => {
        const onlySchema = [...seeded].filter(p => !global.has(p)).sort();
        const onlyGlobal = [...global].filter(p => !seeded.has(p)).sort();
        expect(onlySchema, `in §7 but NOT in GLOBAL_PERMISSIONS (repair can't heal these):\n${onlySchema.join('\n')}`).toEqual([]);
        expect(onlyGlobal, `in GLOBAL_PERMISSIONS but NOT in §7 (seed gap):\n${onlyGlobal.join('\n')}`).toEqual([]);
    });

    it('sanity: a meaningful number of permissions are parsed (guard against regex breakage)', () => {
        expect(seeded.size).toBeGreaterThan(80);
        expect(gated.size).toBeGreaterThan(80);
        expect(global.size).toBe(seeded.size);
    });

    // Self-test of the harness (see the gateCallRe note above): contract 1 is only as
    // wide as the call shapes the scanner recognises, so pin one representative of
    // every gate shape the tree uses today and make adding the next one deliberate.
    it('recognises every gate-call shape in use, so no migrated gate leaves the contract', () => {
        const shapes: Array<[string, string]> = [
            ['bare includes', "if (perms.includes('intel:view')) return true;"],
            ['hasPerm', "const ok = hasPerm(currentUser, 'warrant:view');"],
            ['aggHasPerm', "const ok = aggHasPerm(currentUser, 'hr:view');"],
            ['hasPermission', "if (hasPermission('operations:view')) return;"],
            ['permissionSatisfied', "const ok = permissionSatisfied(u?.permissions, 'academy:view');"],
        ];
        for (const [name, snippet] of shapes) {
            const found = [...snippet.matchAll(gateCallRe())].map(m => m[1] || m[2]);
            expect(found, `${name} gate call is invisible to gatedPermissions()`).toHaveLength(1);
        }
    });
});
