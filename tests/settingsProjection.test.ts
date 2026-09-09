import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Phase 3 item 8 — the CLIENT-TIER SETTINGS BOUNDARY.
//
// getAllSettings (lib/db/system.ts) reduces EVERY row of the `settings` table into one
// blob by key with no filter, and that blob was spread wholesale into three authenticated
// payloads: lib/db.ts getState (target=initial-state AND the no-subset full state) and
// api/query.ts's `main` case (the refresh path). stripSecrets is a NAMED-KEY deny pass, so
// anything it did not name shipped — which is how schema_version, setup_completed,
// allianceSelfProfile, allianceSyncConfig, system_broadcast and orgFeatures reached every
// authenticated caller, an external customer on the Client role included.
//
// projectSettingsForViewer replaces that spread with an ALLOW-LIST. Both directions are
// pinned in every case below: the denied party is denied AND every entitled party keeps
// access, because a fail-BROKEN projection (one that withholds from Admins and Members
// too) would pass a denial-only suite while breaking the app in production.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    settings: {} as Record<string, unknown>,
    mainState: {} as Record<string, unknown>,
    signed: [] as unknown[],
}));

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    tokenIssuedAt: () => new Date(0),
    isSessionRevokedByWatermark: () => false,
}));
vi.mock('../lib/orgMediaDocs', () => ({
    signDocMediaForClient: async (doc: unknown) => { h.signed.push(doc); return { signed: true, from: doc }; },
}));
vi.mock('../lib/db', () => ({
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => h.settings,
    getMainState: async () => h.mainState,
    isAnyStaffOnDuty: async () => true,
}));

import handler from '../api/query';
import {
    projectSettingsForViewer,
    CLIENT_SETTINGS_KEYS,
    GATED_SETTINGS_KEYS,
} from '../lib/settingsProjection';
import { MEMBER_DEFAULT_PERMS } from '../lib/roleDefaultPermissions';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';

// Distinct sentinel values per key, so a mixed-up mapping is visible rather than
// passing on shape alone (the tests/discordConfigKeyParity.test.ts idiom).
function fullBlob() {
    return {
        // --- unconditional ---
        brandingConfig: { name: 'ORG', termsOfService: '<p>ToS</p>' },
        themeConfig: { enabled: true, accent: '#112233' },
        discordConfig: { clientId: 'cid', defaultOperationAnnounceChannelId: 'chan' },
        heroCardConfig: { title: 'hero' },
        openGraphConfig: { title: 'og' },
        radioConfig: { configured: true },
        aiConfig: { enabled: false },
        publicPageConfig: { enabled: true, motto: 'motto' },
        governmentsConfig: { enabled: true },
        platformSettings: { maintenance_mode: false, force_logout_timestamp: '2026-01-01' },
        // --- domain-gated ---
        wikiHomeConfig: { welcomeContent: { type: 'doc' }, featuredPageIds: ['p1'], hideRecentlyUpdated: false },
        hrConfig: { probationDays: 0 },
    } as Record<string, unknown>;
}

// Every key the projection must DROP. Falsy scalars (`setup_completed: true` is truthy on
// purpose; `maxShareableClearance: 0` and `hideRecentlyUpdated: false` are falsy) are mixed
// in so neither a truthiness-based nor a presence-based mis-implementation passes.
function zeroConsumerKeys() {
    return {
        system_broadcast: { message: 'FLASH — all hands', id: '1' },
        orgFeatures: { academy: { enabled: true } },
        schema_version: '15.2.0-open',
        setup_completed: true,
        allianceSelfProfile: { orgName: 'X', contactDiscord: 'y#1' },
        allianceSyncConfig: { intervalMs: 1 },
        systemConfig: { appUrl: 'https://x' },
        intelSharingConfig: { maxShareableClearance: 0 },
        admin_setup_code: { code: 'SETUP-DEADBEEF' },
        active_eam: { message: 'm' },
        geminiKey: 'raw',
        allianceLocalPairingCode: { codeEnc: 'c' },
        role_permission_backfills: { applied: [] },
    } as Record<string, unknown>;
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('projectSettingsForViewer — the allow-list', () => {
    it('1. a Client keeps the unconditional set, values intact', () => {
        const src = fullBlob();
        const out = projectSettingsForViewer(src, CLIENT_DEFAULT_PERMS) as Record<string, unknown>;
        for (const key of CLIENT_SETTINGS_KEYS) {
            expect(out[key], key).toEqual(src[key]);
        }
        expect(Object.keys(out).sort()).toEqual([...CLIENT_SETTINGS_KEYS].sort());
    });

    it('2. a Client loses every zero-consumer key — absent, not present-with-undefined', () => {
        const src = { ...fullBlob(), ...zeroConsumerKeys() };
        const out = projectSettingsForViewer(src, CLIENT_DEFAULT_PERMS) as Record<string, unknown>;
        for (const key of Object.keys(zeroConsumerKeys())) {
            expect(out[key], key).toBeUndefined();
            // `in`, not just undefined: an own property carrying undefined would survive
            // JSON.stringify identically but behave differently for `'x' in obj` and
            // Object.keys, and the whole hasOwnProperty-guard design turns on this.
            expect(key in out, `${key} must be ABSENT`).toBe(false);
        }
    });

    it('3. the open tail — an unknown/imported key drops by default', () => {
        // lib/db/importer.ts filters imported settings rows against a denylist and then
        // falls through to `default: return row`, so a key this fork has never heard of
        // (hosted's starCommsConfig, say) is inserted verbatim. Its `apiKey` would survive
        // stripSecrets' regex backstop, which is underscore-anchored (_api_key|_secret|…)
        // and therefore blind to camelCase `apiKey`/`apiSecret`. THIS is the test that
        // would have caught that: the allow-list drops the whole key, named or not.
        const src = {
            ...fullBlob(),
            starCommsConfig: { apiKey: 'sk-leak', apiSecret: 'shh', baseUrl: 'https://x' },
            someFutureConfig: { token2: 't' },
        };
        const out = projectSettingsForViewer(src, MEMBER_DEFAULT_PERMS) as Record<string, unknown>;
        expect('starCommsConfig' in out).toBe(false);
        expect('someFutureConfig' in out).toBe(false);
    });

    it('4. wikiHomeConfig is withheld without wiki:view and delivered BY REFERENCE with it', () => {
        const src = fullBlob();
        expect((projectSettingsForViewer(src, []) as Record<string, unknown>).wikiHomeConfig).toBeUndefined();
        const out = projectSettingsForViewer(src, ['wiki:view']) as Record<string, unknown>;
        // Reference identity, not deep equality: the read paths sign private-bucket images
        // by MUTATING wikiHome.welcomeContent in place, so a clone here would silently
        // stop the signed URLs from reaching the payload.
        expect(out.wikiHomeConfig).toBe(src.wikiHomeConfig);
    });

    it('5. hrConfig is withheld without hr:view and delivered with it (probationDays: 0 survives)', () => {
        const src = fullBlob();
        expect((projectSettingsForViewer(src, []) as Record<string, unknown>).hrConfig).toBeUndefined();
        const out = projectSettingsForViewer(src, ['hr:view']) as Record<string, unknown>;
        expect(out.hrConfig).toEqual({ probationDays: 0 });
    });

    it('6. fails closed on a missing/garbage viewer, and never throws on a missing blob', () => {
        const src = fullBlob();
        const bad: Array<readonly string[] | undefined | null> = [
            undefined,
            null,
            [],
            'wiki:view' as unknown as readonly string[], // truthy non-array
        ];
        for (const perms of bad) {
            const out = projectSettingsForViewer(src, perms) as Record<string, unknown>;
            expect(Object.keys(out).sort(), String(perms)).toEqual([...CLIENT_SETTINGS_KEYS].sort());
            expect('wikiHomeConfig' in out, String(perms)).toBe(false);
            expect('hrConfig' in out, String(perms)).toBe(false);
        }
        expect(projectSettingsForViewer(null, ['wiki:view'])).toEqual({});
        expect(projectSettingsForViewer(undefined, ['wiki:view'])).toEqual({});
        // The real call shape is `currentUser?.permissions` off a possibly-absent user.
        const noUser = undefined as { permissions?: string[] } | undefined;
        expect(projectSettingsForViewer(src, noUser?.permissions)).toEqual(
            projectSettingsForViewer(src, []),
        );
    });

    it('7. routes through permissionSatisfied, so the implication table applies', () => {
        // lib/permissionImplications.ts has three keys today and neither wiki:view nor
        // hr:view is among them, so this is asserted STRUCTURALLY as well as behaviourally.
        // A hand-rolled `permissions.includes(perm)` here would pass the behavioural half
        // and silently drop a future implication the subset gate would honour — the exact
        // drift lib/permissionImplications.ts exists to prevent.
        const src = fullBlob();
        expect((projectSettingsForViewer(src, ['hr:view']) as Record<string, unknown>).hrConfig).toBeDefined();
        const mod = read('lib/settingsProjection.ts');
        expect(mod).toContain(`import { permissionSatisfied } from './permissionImplications.js'`);
        expect(mod).toContain('permissionSatisfied(permissions, perm)');
        // Comment lines stripped first: the docblock NAMES the anti-pattern in prose, and
        // a regex that cannot tell prose from code would fail for the wrong reason.
        const code = mod.split(/\r?\n/)
            .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
            .join('\n');
        expect(code).not.toMatch(/permissions[?.\s]*\.includes\(/);
    });

    it('8. the seeded staff tiers lose NOTHING — the gate is a no-op above the Client tier', () => {
        // The argument that makes this gate safe. MEMBER_DEFAULT_PERMS and
        // DISPATCHER_DEFAULT_PERMS both hold wiki:view AND hr:view, and the seeder defines
        // Admin as every permission — so the only tiers that lose anything are Client and
        // custom roles below staff. Driven from the REAL default arrays, not synthetic
        // strings, so removing wiki:view from the Member defaults in another cluster fails
        // HERE instead of silently blanking every member's wiki home page.
        const src = fullBlob();
        const member = projectSettingsForViewer(src, MEMBER_DEFAULT_PERMS) as Record<string, unknown>;
        expect(member.wikiHomeConfig).toBeDefined();
        expect(member.hrConfig).toBeDefined();

        const client = projectSettingsForViewer(src, CLIENT_DEFAULT_PERMS) as Record<string, unknown>;
        expect('wikiHomeConfig' in client).toBe(false);
        expect('hrConfig' in client).toBe(false);
    });

    it('9. RATCHET — the allow-lists are pinned exactly', () => {
        // ADDING A KEY TO CLIENT_SETTINGS_KEYS PUBLISHES IT TO EVERY AUTHENTICATED CALLER,
        // INCLUDING AN EXTERNAL CUSTOMER ON THE CLIENT ROLE. That must be a deliberate,
        // reviewed edit — not something that rides in on an unrelated change.
        expect([...CLIENT_SETTINGS_KEYS]).toEqual([
            'brandingConfig',
            'themeConfig',
            'discordConfig',
            'heroCardConfig',
            'openGraphConfig',
            'radioConfig',
            'aiConfig',
            'publicPageConfig',
            'governmentsConfig',
            'platformSettings',
        ]);
        expect(GATED_SETTINGS_KEYS).toEqual([
            { key: 'wikiHomeConfig', perm: 'wiki:view' },
            { key: 'hrConfig', perm: 'hr:view' },
        ]);
        // BARE gate strings, matching api/query.ts's SUBSET_REQUIRED_PERMISSION exactly.
        // A `view || edit` disjunct here would make this read WIDER than the subset it
        // configures — the drift Phase 3 removed. The destructive-save hazard that
        // widening was proposed to close is handled on the WRITE side instead
        // (updateWikiHomeConfig read-merges), pinned in tests/wikiHomeConfigSanitize.ts.
        const q = read('api/query.ts');
        for (const { key, perm } of GATED_SETTINGS_KEYS) {
            expect(q, key).toContain(`${key === 'wikiHomeConfig' ? 'wiki' : 'hr'}: '${perm}'`);
        }
    });
});

// --- Endpoint half: the real api/query handler on subset=main ---

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const mockReq = (query: Record<string, unknown>) =>
    ({ method: 'GET', query, headers: { authorization: 'Bearer tok' } }) as any;

const clientUser = { id: 5, role: 'Client', permissions: [...CLIENT_DEFAULT_PERMS], auth_user_id: 'u5' };
const memberUser = { id: 6, role: 'Member', permissions: [...MEMBER_DEFAULT_PERMS], auth_user_id: 'u6' };

beforeEach(() => {
    h.decoded = { userId: 5 };
    h.user = clientUser;
    h.settings = { ...fullBlob(), ...zeroConsumerKeys() };
    h.mainState = { serviceTypes: [{ id: 1, name: 'Escort' }], anyStaffOnDuty: true };
    h.signed = [];
});

describe('GET /api/query?subset=main — the projection on the wire', () => {
    it('10. a Client body carries the projection and nothing else', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(200);
        const body = res.body as Record<string, unknown>;

        for (const key of ['wikiHomeConfig', 'hrConfig', 'system_broadcast', 'orgFeatures',
            'schema_version', 'setup_completed', 'allianceSelfProfile', 'allianceSyncConfig']) {
            expect(body[key], key).toBeUndefined();
        }
        // The Client surfaces that MUST keep working: the ToS view reads
        // brandingConfig.termsOfService, CreateRequestModal renders heroCardConfig, and
        // platformSettings is the ONLY carrier of maintenance_mode / force_logout_timestamp
        // on this path (the boot path appends its own copy after the spread).
        expect(body.brandingConfig).toBeDefined();
        expect(body.heroCardConfig).toBeDefined();
        expect(body.platformSettings).toBeDefined();
        expect(body.discordConfig).toBeDefined();
        expect(body.serviceTypes).toBeDefined();
    });

    it('11. a wiki:view holder keeps wikiHomeConfig AND its media is signed', async () => {
        // Pins the ORDER the whole design turns on: the projection runs BEFORE the signing
        // block, so the signer still sees the object and mutates it in place.
        h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(200);
        const body = res.body as any;
        expect(h.signed).toHaveLength(1);
        expect(body.wikiHomeConfig.welcomeContent).toEqual({ signed: true, from: { type: 'doc' } });
    });

    it('12. an hr:view holder keeps hrConfig; a Client never reaches the signer at all', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        let res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect((res.body as any).hrConfig).toEqual({ probationDays: 0 });

        h.signed = [];
        h.decoded = { userId: 5 }; h.user = clientUser;
        res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect((res.body as any).hrConfig).toBeUndefined();
        expect(h.signed).toHaveLength(0);
    });

    it('13. stripSecrets still runs AFTER the projection', async () => {
        // Once the allow-list makes the geminiKey / admin_setup_code / active_eam deletes
        // unreachable on the three projected paths, a refactor could reorder or drop the
        // stripSecrets call and nothing else would notice — every case in
        // tests/stripSecrets.test.ts calls the function directly, not through the handler.
        // This drives two secrets through the endpoint instead.
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        const body = res.body as Record<string, unknown>;
        expect(body.geminiKey).toBeUndefined();
        expect(body.admin_setup_code).toBeUndefined();
        expect(body.active_eam).toBeUndefined();
        // radioConfig IS allow-listed, and stripSecrets rebuilds it — proof the deny pass
        // still ran over the projection rather than being skipped for it.
        expect(body.radioConfig).toEqual({ configured: false });
    });
});

describe('STRUCTURAL RATCHET — every settings merge site is projected', () => {
    // A POSITIVE call-shape pin first. A negative "no raw ...settings" assertion alone
    // cannot distinguish correct wiring from projectSettingsForViewer(settings, undefined)
    // or (settings, currentUser?.perms) — the wrong field name; the real field is
    // `permissions` — either of which compiles and silently withholds BOTH gated keys from
    // Admins, Dispatchers and every default Member while the whole suite stays green.
    it('14. both merge sites pass the viewer permissions, spelled exactly', () => {
        for (const f of ['lib/db.ts', 'api/query.ts']) {
            expect(read(f), f).toContain('projectSettingsForViewer(settings, currentUser?.permissions)');
        }
    });

    it('15. no raw settings spread survives in either merge file', () => {
        for (const f of ['lib/db.ts', 'api/query.ts']) {
            const offenders = read(f).split(/\r?\n/)
                .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
                .filter(l => /\.\.\.\s*settings\b/.test(l));
            expect(offenders, f).toEqual([]);
        }
    });

    it('16. the getAllSettings call-site census is pinned — a sixth raw consumer is a review event', () => {
        // Name-independent: this catches a new merge site in a THIRD file, and one that
        // renames its variable past the negative regex above. Five sites today —
        // api/query.ts x3 (pre-admin boot, logged-out boot, the `main` case), lib/db.ts x1
        // (getState) and lib/db/users.ts x1 (server-internal, brandingConfig only).
        const files = ['api/query.ts', 'lib/db.ts', 'lib/db/users.ts'];
        const census: Record<string, number> = {};
        for (const f of files) {
            census[f] = (read(f).match(/getAllSettings\(/g) || []).length;
        }
        expect(census).toEqual({ 'api/query.ts': 3, 'lib/db.ts': 1, 'lib/db/users.ts': 1 });
    });
});
