import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as uploadPerms from '../api/orgUploadPerms';
import { fullPermissionMap, OPTIONAL_FEATURE_NAMESPACES } from '../api/services';
import { ORG_MEDIA_FEATURES } from '../lib/storage';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { permissionSatisfied } from '../lib/permissionImplications';

const { FEATURE_UPLOAD_PERMS, FEATURE_WRITE_ACTION } = uploadPerms;

// Uploading media for a feature must require the same permission as editing that feature's
// resource. This pins each upload permission to fullPermissionMap[<the write action>], so a
// change to a write permission fails here until the upload map is updated to match.
describe('image-upload permission parity', () => {
    it('every upload feature is gated by the same permission as its write action', () => {
        for (const feature of Object.keys(FEATURE_UPLOAD_PERMS) as (keyof typeof FEATURE_UPLOAD_PERMS)[]) {
            const uploadPerm = FEATURE_UPLOAD_PERMS[feature];
            const writeAction = FEATURE_WRITE_ACTION[feature];
            const uploadPerms = Array.isArray(uploadPerm) ? uploadPerm : [uploadPerm];
            const writeActions = Array.isArray(writeAction) ? writeAction : [writeAction];
            expect(writeActions.length, `${feature} arity`).toBe(uploadPerms.length);
            writeActions.forEach((action, i) => {
                const mapped = fullPermissionMap[action];
                expect(mapped, `${feature}: fullPermissionMap[${action}] missing`).toBeTruthy();
                expect(mapped, `${feature}: upload perm must match its write action's perm`).toBe(uploadPerms[i]);
            });
        }
    });

    it('the two maps cover exactly the same features', () => {
        expect(Object.keys(FEATURE_WRITE_ACTION).sort()).toEqual(Object.keys(FEATURE_UPLOAD_PERMS).sort());
    });
});

type UploadFeature = keyof typeof FEATURE_UPLOAD_PERMS;
const FEATURES = Object.keys(FEATURE_UPLOAD_PERMS) as UploadFeature[];
const flat = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/** The EXACT derivation api/orgUpload.ts runs: first-colon prefix of the write action. */
const deriveNamespace = (feature: UploadFeature): string => {
    const first = flat(FEATURE_WRITE_ACTION[feature])[0];
    const colon = first.indexOf(':');
    return colon <= 0 ? '' : first.slice(0, colon + 1);
};

// api/orgUpload.ts refuses an upload whose optional module is switched off, using the
// dispatcher's OWN registry (OPTIONAL_FEATURE_NAMESPACES). It DERIVES the namespace from
// FEATURE_WRITE_ACTION rather than carrying a fourth hand-written map, because a
// hand-typed prefix that drops its trailing colon ('qm' vs 'qm:') would pass a
// `startsWith` check, miss the registry key, and silently un-gate that target — fail-OPEN
// in exactly the place a reader would assume was guarded. These tests pin the derivation,
// the resulting gated set, and the deliberate exclusion.
describe('image-upload optional-module gate', () => {
    it('A1 — the upload maps cover exactly the ORG_MEDIA_FEATURES key set', () => {
        const media = Object.keys(ORG_MEDIA_FEATURES).sort();
        expect(Object.keys(FEATURE_UPLOAD_PERMS).sort()).toEqual(media);
        expect(Object.keys(FEATURE_WRITE_ACTION).sort()).toEqual(media);
    });

    it('A2 — every write action for a feature shares one well-formed namespace prefix', () => {
        for (const feature of FEATURES) {
            const actions = flat(FEATURE_WRITE_ACTION[feature]);
            expect(actions.length, `${feature} has no write action`).toBeGreaterThan(0);
            const ns = deriveNamespace(feature);
            // Equality, never startsWith: startsWith('qm') passes on the exact typo that
            // un-gates a target, so it cannot be the invariant this file enforces.
            expect(ns, `${feature} namespace must be lower-case letters + a trailing colon`).toMatch(/^[a-z]+:$/);
            for (const action of actions) {
                expect(action.slice(0, action.indexOf(':') + 1), `${feature}: ${action} namespace`).toBe(ns);
            }
        }
    });

    it('A3 — exactly academy, government, legislation and quartermaster are module-gated uploads', () => {
        // Four of four, with NO exclusion filter: every target whose DERIVED namespace is a
        // gated module is gated. F1 removed the last exception by giving the platform Item
        // Catalog tab its own ungated `catalog` target, so ?for=quartermaster serves only
        // the org's OWN custom quartermaster_catalog rows (qm:update_catalog_item /
        // qm:admin) and belongs inside the module gate with the rest.
        //
        // If a future upload target's Upload button "breaks" on a module-off org, the fix
        // is to repoint that call site at an ungated target — NOT to re-add a skip list
        // here. See A3b.
        const gated = FEATURES.filter(f =>
            Object.prototype.hasOwnProperty.call(OPTIONAL_FEATURE_NAMESPACES, deriveNamespace(f)),
        ).sort();
        expect(gated).toEqual(['academy', 'government', 'legislation', 'quartermaster']);
    });

    it('A3b — there is NO exclusion/skip list, on the module surface or in the handler', () => {
        // Item 6 shipped UPLOAD_GATE_EXCLUDED purely to carry ?for=quartermaster un-gated
        // while the PLATFORM Item Catalog tab was still pointed at it. F1 repointed that
        // tab, so the lever is gone. Its ABSENCE is the invariant: a skip list is
        // fail-OPEN — a row added to it un-gates a target, and nothing can tell that from
        // a deliberate choice. Deleting it made four-of-four structural, not data-driven.
        expect(Object.keys(uploadPerms), 'the upload-gate skip list must stay deleted')
            .not.toContain('UPLOAD_GATE_EXCLUDED');

        // Source-text half, so re-introducing the lever under a NEW name is caught too.
        // Single-line substrings only: this tree has MIXED line endings (api/services.ts
        // and the .tsx call site are CRLF; api/orgUpload.ts is LF today). Never match
        // across a line break with a literal newline — if a block ratchet is ever needed
        // here use src.search(/\r?\n\}\r?\n/) plus an explicit
        // expect(end).toBeGreaterThan(-1).
        const src = readFileSync(resolve(__dirname, '..', 'api', 'orgUpload.ts'), 'utf8');
        expect(src).not.toContain('UPLOAD_GATE_EXCLUDED');
        expect(src, 'the gate must be the bare derived registry lookup')
            .toContain('const gate = Object.prototype.hasOwnProperty.call(OPTIONAL_FEATURE_NAMESPACES, namespace)');
    });

    it('A4 — each gated target resolves to the module and label the 403 message is built from', () => {
        const gateFor = (f: UploadFeature) => OPTIONAL_FEATURE_NAMESPACES[deriveNamespace(f)];
        expect(gateFor('government').feature).toBe('government');
        expect(gateFor('government').label).toBe('Government');
        // legislation lives in the SAME namespace as government — both must consult the
        // government settings row, not the orgFeatures blob.
        expect(gateFor('legislation').feature).toBe('government');
        expect(gateFor('legislation').label).toBe('Government');
        expect(gateFor('academy').feature).toBe('academy');
        expect(gateFor('academy').label).toBe('Academy');
        // Gated as of F1. The label is what the 403 message is built from, so it is also
        // byte-pinned at the handler in tests/orgUploadFeatureGate.test.ts (B4).
        expect(gateFor('quartermaster').feature).toBe('quartermaster');
        expect(gateFor('quartermaster').label).toBe('Quartermaster');
    });

    it('A5 — no upload target is reachable with the Client entitlement', () => {
        // This is the STATIC form of a runtime Client-tier denial, and it is deliberate.
        // A runtime role check here would be dead code: the Client role's grants are
        // code-owned and triple-enforced (assertRoleIsNotClient on the admin action AND
        // inside updateRolePermissions, plus enforceClientRolePermissionLock on repair and
        // after an import), and the only permission-shaped predicate available
        // (hasAnyStaffViewPerm) answers "is this person staff?" — a different question
        // from "may this person write this resource?", so it would deny on the wrong axis.
        // If a future upload target is ever gated on a Client-held permission, THIS fires.
        // Do not "fix" it by adding a role gate to api/orgUpload.ts.
        const client = [...CLIENT_DEFAULT_PERMS];
        for (const feature of FEATURES) {
            for (const perm of flat(FEATURE_UPLOAD_PERMS[feature])) {
                expect(permissionSatisfied(client, perm), `${feature}: reachable with Client perms`).toBe(false);
                expect(client, `${feature}: ${perm} is a Client default`).not.toContain(perm);
            }
        }
    });

    it('A6 — admin:, alliance:, wiki: and catalog: are not gated namespaces', () => {
        // Over-blocking guard. If any of these ever becomes a toggleable module, the
        // upload path silently starts 403ing branding/rank/wiki/alliance/platform-catalog
        // media — this fires first so the change is deliberate. `catalog:` is now
        // LOAD-BEARING: the platform Item Catalog's Thumbnail Upload rides it (F1), and
        // making catalog: a gated namespace would re-break the exact admin button F1
        // repaired. (It asserts a property of OPTIONAL_FEATURE_NAMESPACES rather than of
        // the upload maps; it would arguably read better in
        // tests/featureGateParity.test.ts, but that file is outside this change's
        // ownership — see the cluster report.)
        for (const ns of ['admin:', 'alliance:', 'wiki:', 'catalog:']) {
            expect(OPTIONAL_FEATURE_NAMESPACES[ns], `${ns} became a gated namespace`).toBeUndefined();
        }
    });

    it('A7 — the platform-catalog upload target is the ungated, public twin of quartermaster', () => {
        // One table, two resources. catalog:update_item writes quartermaster_catalog WHERE
        // source='platform'; qm:update_catalog_item writes WHERE source='custom'. Two
        // permissions, two namespaces, two gates — pinned so a later "cleanup" cannot
        // collapse them.
        expect(FEATURE_UPLOAD_PERMS.catalog).toBe('admin:config:catalog');
        expect(FEATURE_WRITE_ACTION.catalog).toBe('catalog:update_item');
        expect(fullPermissionMap['catalog:update_item']).toBe('admin:config:catalog');
        expect(deriveNamespace('catalog')).toBe('catalog:');
        expect(
            Object.prototype.hasOwnProperty.call(OPTIONAL_FEATURE_NAMESPACES, 'catalog:'),
            'catalog: must stay ungated — the admin console reaches this tab with no module condition',
        ).toBe(false);

        // PUBLIC is load-bearing, not stylistic: nothing signs quartermaster_catalog's
        // thumbnail_url on read (lib/db/mappers.ts maps it straight to the wire and the UI
        // renders a bare <img src>), so a private-bucket placement would render broken
        // everywhere an item thumbnail appears — silently, at runtime, with no error.
        expect(ORG_MEDIA_FEATURES.catalog.visibility).toBe('public');
        expect(ORG_MEDIA_FEATURES.catalog.bucket).toBe(ORG_MEDIA_FEATURES.quartermaster.bucket);
    });

    it('A8 — F1 repointed the tab, it did not merge the two permissions', () => {
        // The widening the owner approved, stated as a test so the release note is
        // checkable: admin:config:catalog holders GAIN the platform-catalog upload...
        expect(permissionSatisfied(['admin:config:catalog'], FEATURE_UPLOAD_PERMS.catalog as string)).toBe(true);
        // ...and nothing else. qm:admin does not reach it, admin:config:catalog does not
        // reach the org's own QM rows, and neither is reachable from the Client tier.
        expect(permissionSatisfied(['qm:admin'], FEATURE_UPLOAD_PERMS.catalog as string)).toBe(false);
        expect(permissionSatisfied(['admin:config:catalog'], FEATURE_UPLOAD_PERMS.quartermaster as string)).toBe(false);
        expect(permissionSatisfied([...CLIENT_DEFAULT_PERMS], FEATURE_UPLOAD_PERMS.catalog as string)).toBe(false);
    });

    it('A9 — the platform Item Catalog uploads under ?for=catalog, and ?for=quartermaster has no UI consumer', () => {
        // ImageInput's prop is `feature: string` (components/common/ImageInput.tsx), NOT
        // OrgMediaFeature, so TypeScript cannot catch a revert of this attribute — this
        // assertion is the only thing that does. Losing it means the tab silently uploads
        // under the gated qm: namespace again and its Upload button returns
        // "The Quartermaster feature is not enabled." on every default (QM-off) install.
        //
        // Substring matching only. AdminItemCatalogTab.tsx is a CRLF file in this checkout
        // while api/orgUpload.ts is LF, so anything spanning a line break must be written
        // /\r?\n/-tolerant. `feature="catalog"` contains no newline and is safe as-is.
        const ROOT = resolve(__dirname, '..');
        const tabPath = join(ROOT, 'components', 'views', 'admin', 'catalog', 'AdminItemCatalogTab.tsx');
        const tab = readFileSync(tabPath, 'utf8');
        expect(tab).toContain('feature="catalog"');
        expect(tab).not.toContain('feature="quartermaster"');

        // ?for=quartermaster is module-gated, so it must stay consumer-free until a UI for
        // the org's OWN custom quartermaster_catalog rows exists — and that UI would live
        // inside the Quartermaster module, where the gate is correct.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
                if (/[Ff]eature\s*=\s*["']quartermaster["']/.test(readFileSync(full, 'utf8'))) {
                    offenders.push(full.slice(ROOT.length + 1).replace(/\\/g, '/'));
                }
            }
        };
        walk(join(ROOT, 'components'));
        expect(offenders, '?for=quartermaster is module-gated and must have no UI consumer').toEqual([]);
    });
});
