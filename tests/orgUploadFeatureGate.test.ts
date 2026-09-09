import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler-level pins for POST /api/org/upload's two non-permission gates:
//
//   * MAINTENANCE MODE — the upload endpoint is a write surface, and an operator who has
//     declared maintenance has closed non-Admin writes. The dispatcher and the read path
//     both enforce it; this endpoint used to skip it entirely on a settings object it had
//     already loaded.
//   * OPTIONAL-MODULE GATE — a module the org has switched OFF has no upload surface
//     either. The namespace is DERIVED from FEATURE_WRITE_ACTION and looked up in the
//     dispatcher's OWN OPTIONAL_FEATURE_NAMESPACES registry, so the write gate, the read
//     gate and the upload gate cannot disagree about which module owns a namespace.
//
// Scope note, deliberately pinned below (see 'ungated targets'): this is dispatcher
// parity + disabled-module folder hygiene. It is NOT a storage-abuse fix — twelve of the
// sixteen targets ride never-gated namespaces, so a permitted caller can still mint
// world-readable objects and fill the global storage cap at exactly the same rate with
// every module off.

const h = vi.hoisted(() => ({
    decoded: null as unknown,
    user: null as unknown,
    settings: {} as Record<string, unknown>,
    enabled: {} as Record<string, boolean>,
    enabledCalls: [] as string[],
    enabledThrows: false,
    freshAdmin: false,
    uploads: [] as string[],
    events: [] as Array<Record<string, unknown>>,
    // When true, the audit emitter throws SYNCHRONOUSLY — the exact shape of a lib/db test
    // double that hand-lists exports and omits this one, which is how an absent emitter
    // turned 26 tests red earlier. A denial must survive it.
    eventThrows: false,
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ count: 0, data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    tokenIssuedAt: () => new Date(0),
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => h.settings,
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => ({}),
    getSystemRoles: async () => ({ admin: { id: 1 } }),
    resolveIsSystemAdminFresh: async () => h.freshAdmin,
    isOptionalFeatureEnabled: async (feature: string) => {
        h.enabledCalls.push(feature);
        if (h.enabledThrows) throw new Error('settings read failed');
        return h.enabled[feature] ?? false;
    },
    recordSecurityEvent: (ev: Record<string, unknown>) => {
        if (h.eventThrows) throw new Error('audit table unavailable');
        h.events.push(ev);
        return Promise.resolve();
    },
}));

// lib/storage stays REAL apart from the writer: isOrgMediaFeature and ORG_MEDIA_FEATURES
// are the allowlist and the bucket table this test derives its cases from, so mocking
// them would make the coverage circular.
vi.mock('../lib/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/storage')>();
    return {
        ...actual,
        uploadOrgMedia: async (feature: keyof typeof actual.ORG_MEDIA_FEATURES) => {
            h.uploads.push(feature as string);
            const def = actual.ORG_MEDIA_FEATURES[feature];
            const key = `media/${feature}/00000000-0000-4000-8000-000000000000.webp`;
            return {
                url: def.visibility === 'public'
                    ? `https://proj.supabase.co/storage/v1/object/public/${def.bucket}/${key}`
                    : null,
                key,
                visibility: def.visibility,
            };
        },
    };
});

import orgUploadHandler, { pruneOrgUploadBuckets } from '../api/orgUpload';
import { FEATURE_UPLOAD_PERMS, FEATURE_WRITE_ACTION } from '../api/orgUploadPerms';
import { OPTIONAL_FEATURE_NAMESPACES } from '../api/services';
import { ORG_MEDIA_FEATURES } from '../lib/storage';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';

type UploadFeature = keyof typeof ORG_MEDIA_FEATURES;
const FEATURES = Object.keys(ORG_MEDIA_FEATURES) as UploadFeature[];
const flat = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);
const namespaceOf = (f: UploadFeature): string => {
    const first = flat(FEATURE_WRITE_ACTION[f])[0];
    return first.slice(0, first.indexOf(':') + 1);
};
const GATED = FEATURES.filter(f =>
    Object.prototype.hasOwnProperty.call(OPTIONAL_FEATURE_NAMESPACES, namespaceOf(f)),
);
const UNGATED = FEATURES.filter(f => !GATED.includes(f));

const PERM_DENIED = 'Forbidden: you do not have permission to upload here.';
const MAINTENANCE = 'The platform is currently undergoing maintenance. Please try again later.';

interface MockRes {
    statusCode: number;
    body: { message?: string; url?: string | null; key?: string; visibility?: string } | undefined;
    headers: Record<string, string>;
    status(c: number): MockRes;
    json(b: unknown): MockRes;
    setHeader(k: string, v: string): MockRes;
}

function mockRes(): MockRes {
    const res = { statusCode: 0, body: undefined, headers: {} } as unknown as MockRes;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b as MockRes['body']; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}

function mockReq(feature: string): any {
    return {
        method: 'POST',
        query: { for: feature },
        headers: { authorization: 'Bearer tok' },
        body: Buffer.from('image-bytes'),
    };
}

function actor(permissions: string[], id = 7, extra: Record<string, unknown> = {}) {
    return { id, roleId: 3, role: 'Custom', permissions, isSystemAdmin: false, ...extra };
}

async function post(feature: string): Promise<MockRes> {
    const res = mockRes();
    await orgUploadHandler(mockReq(feature), res as any);
    return res;
}

beforeEach(() => {
    // Clear the module-level per-user upload buckets so one test's traffic can never
    // 429 the next (the throttle is process-global and 30/min). B12 drives the limiter
    // deliberately, inside a single test, on its own user id.
    pruneOrgUploadBuckets(Date.now() + 10 * 60_000);
    h.decoded = { userId: 7 };
    h.user = actor(['academy:instruct']);
    h.settings = {};
    h.enabled = {};
    h.enabledCalls = [];
    h.enabledThrows = false;
    h.freshAdmin = false;
    h.uploads = [];
    h.events = [];
    h.eventThrows = false;
});

describe('org upload — denials reach the security audit trail', () => {
    // This endpoint bypasses api/services.ts, so none of its denials reach that file's
    // auditDenial helper. Without a local emitter the trail has a blind spot on a real
    // write surface: "which account tried to upload where, and when" has no answer.
    it('emits a durable audit row when the optional-module gate denies', async () => {
        const res = await post('academy');
        expect(res.statusCode).toBe(403);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]).toMatchObject({
            event: 'upload.feature_disabled.denied',
            action: 'org:upload',
            actorUserId: 7,
            details: { feature: 'academy', module: 'academy' },
        });
    });

    it('emits the dispatcher\'s OWN slug for a permission denial, so one filter sees both surfaces', async () => {
        h.user = actor([]); // holds nothing
        h.enabled = { academy: true };
        const res = await post('academy');
        expect(res.statusCode).toBe(403);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]).toMatchObject({ event: 'authz.permission.denied', details: { feature: 'academy' } });
    });

    // THE STRUCTURAL GUARD. `void fn()` protects a caller from a REJECTED promise, not from an
    // absent export or a synchronous throw. If the emitter can break the denial, an attacker
    // who can break the audit table converts every 403 into a 500 — and a 500 is retried or
    // handled more permissively on several paths. Losing an audit row is bad; losing the
    // denial is worse.
    it('still DENIES when the audit emitter throws synchronously', async () => {
        h.eventThrows = true;
        const res = await post('academy');
        expect(res.statusCode).toBe(403);
        expect(res.body?.message).toBe('The Academy feature is not enabled.');
        expect(h.uploads).toEqual([]);
    });

    // A pre-auth emit would write a durable, IP-bearing row for a fully unauthenticated
    // request, bounded only by the per-IP limiter and trivially amplified from many
    // addresses — and it could not name an account, which is the only thing the trail is for.
    it('writes NOTHING on a successful upload (allowed outcomes are log-only)', async () => {
        h.enabled = { academy: true };
        const res = await post('academy');
        expect(res.statusCode).toBe(200);
        expect(h.events).toEqual([]);
    });
});

describe('org upload — optional-module gate', () => {
    it('B1 — academy OFF gives the dispatcher\'s exact 403 and stores nothing', async () => {
        const res = await post('academy');
        expect(res.statusCode).toBe(403);
        expect(res.body?.message).toBe('The Academy feature is not enabled.');
        expect(h.uploads).toEqual([]);
        expect(h.enabledCalls).toEqual(['academy']);
    });

    it('B1b — a settings row that resolves absent (orgFeatures = {}) still 403s: fail CLOSED', async () => {
        // The reachable fail-closed path, not the throwing one: lib/db/system.ts's readers
        // swallow their error and return {} / false, so "unknown" must read as OFF.
        h.enabled = {};
        const res = await post('academy');
        expect(res.statusCode).toBe(403);
        expect(h.uploads).toEqual([]);
    });

    it('B2 — academy ON with academy:instruct uploads exactly once', async () => {
        h.enabled = { academy: true };
        const res = await post('academy');
        expect(res.statusCode).toBe(200);
        expect(h.uploads).toEqual(['academy']);
    });

    it('B3 — academy ON with academy:manage still reaches storage (implication ladder)', async () => {
        h.enabled = { academy: true };
        h.user = actor(['academy:manage']);
        const res = await post('academy');
        expect(res.statusCode).toBe(200);
        expect(h.uploads).toEqual(['academy']);
    });

    it('B4 — quartermaster OFF gives the Quartermaster 403 and stores nothing', async () => {
        // F1 landed: the platform Item Catalog tab was repointed at ?for=catalog (B4b), so
        // ?for=quartermaster now serves only the org's OWN custom quartermaster_catalog
        // rows (qm:update_catalog_item / qm:admin) and is gated four-of-four with academy,
        // government and legislation.
        //
        // If this ever flips back to expecting 200, a skip list has been re-introduced.
        // Do NOT repair a module-off Upload button that way — repoint the caller at an
        // ungated target, the way F1 did.
        h.enabled = {};
        h.user = actor(['qm:admin']);
        const off = await post('quartermaster');
        expect(off.statusCode).toBe(403);
        // Byte-exact, and byte-identical to the dispatcher's own message
        // (api/services.ts) minus its `success: false`. A reword there must reword here.
        expect(off.body?.message).toBe('The Quartermaster feature is not enabled.');
        expect(h.enabledCalls).toEqual(['quartermaster']);
        expect(h.uploads).toEqual([]);

        h.enabled = { quartermaster: true };
        h.enabledCalls = [];
        expect((await post('quartermaster')).statusCode).toBe(200);
        expect(h.uploads).toEqual(['quartermaster']);
    });

    it('B4b — the platform catalog target is UNGATED and public: it uploads with every module OFF', async () => {
        // THE regression F1 exists to prevent, in the exact shape a user meets it:
        // Admin -> Catalogs -> Item Catalog -> edit an item -> Thumbnail -> Upload, on a
        // default install (Quartermaster and Academy both ship OFF).
        //
        // The actor holds ONLY admin:config:catalog — the delegated "catalog curator" who
        // reaches the tab (AdminPanelView gates it on that permission alone) but could not
        // upload AT ALL before F1, because the button asked for qm:admin.
        h.enabled = {};
        h.user = actor(['admin:config:catalog']);
        const res = await post('catalog');
        expect(res.statusCode).toBe(200);
        expect(h.uploads).toEqual(['catalog']);
        expect(h.enabledCalls, 'catalog: is not a gated namespace — no settings read').toEqual([]);
        // PUBLIC is load-bearing: nothing signs quartermaster_catalog.thumbnail_url on
        // read, so a private key here would render broken wherever a thumbnail appears.
        expect(res.body?.visibility).toBe('public');
        expect(res.body?.url).toContain('/object/public/');
        expect(res.body?.key).toContain('media/catalog/');
    });

    it('B4c — the two catalog targets stay disjoint at the permission gate', async () => {
        // qm:admin must not reach the PLATFORM catalog, and admin:config:catalog must not
        // reach the org's OWN QM rows. Modules ON so the permission gate is provably what
        // refuses, not the feature gate.
        h.enabled = { quartermaster: true };
        h.user = actor(['qm:admin']);
        const a = await post('catalog');
        expect(a.statusCode).toBe(403);
        expect(a.body?.message).toBe(PERM_DENIED);

        h.user = actor(['admin:config:catalog']);
        const b = await post('quartermaster');
        expect(b.statusCode).toBe(403);
        expect(b.body?.message).toBe(PERM_DENIED);
        expect(h.uploads).toEqual([]);
    });

    it('B4d — every gated target 403s with its module OFF: four of four, no exceptions', async () => {
        // Derived from the registry, so this fires however a future un-gating is spelled —
        // a skip list, a per-feature flag, an early return. B4/B5 pin the individual
        // messages; this pins that the SET is complete.
        expect([...GATED].sort()).toEqual(['academy', 'government', 'legislation', 'quartermaster']);
        for (const feature of GATED) {
            h.enabled = {};
            h.enabledCalls = [];
            h.uploads = [];
            h.user = actor(flat(FEATURE_UPLOAD_PERMS[feature]));
            const res = await post(feature);
            expect(res.statusCode, `${feature} must 403 while its module is off`).toBe(403);
            expect(res.body?.message, `${feature} denial reason`).toMatch(/ feature is not enabled\.$/);
            expect(h.uploads, `${feature} must store nothing`).toEqual([]);
            expect(h.enabledCalls.length, `${feature} must consult exactly one module toggle`).toBe(1);
        }
    });

    it('B5 — government and legislation both consult the government module', async () => {
        h.user = actor(['gov:admin', 'gov:elected_official']);
        const gov = await post('government');
        expect(gov.statusCode).toBe(403);
        expect(gov.body?.message).toBe('The Government feature is not enabled.');
        const leg = await post('legislation');
        expect(leg.statusCode).toBe(403);
        expect(leg.body?.message).toBe('The Government feature is not enabled.');
        // Both must hit the government settings row, never the orgFeatures blob.
        expect(h.enabledCalls).toEqual(['government', 'government']);
        expect(h.uploads).toEqual([]);

        h.enabled = { government: true };
        h.enabledCalls = [];
        h.user = actor(['gov:admin']);
        expect((await post('government')).statusCode).toBe(200);
        h.user = actor(['gov:elected_official']);
        expect((await post('legislation')).statusCode).toBe(200);
        expect(h.uploads).toEqual(['government', 'legislation']);
    });

    it('B6 — every ungated target still uploads with all modules OFF, without a feature read', async () => {
        // Derived from ORG_MEDIA_FEATURES minus the gated set, so a new ungated upload
        // target is covered automatically instead of rotting a hand-written list.
        expect(UNGATED.length).toBeGreaterThan(0);
        for (const feature of UNGATED) {
            h.enabled = {};
            h.enabledCalls = [];
            h.uploads = [];
            h.user = actor(flat(FEATURE_UPLOAD_PERMS[feature]));
            const res = await post(feature);
            expect(res.statusCode, `${feature} should upload while modules are off`).toBe(200);
            expect(h.uploads).toEqual([feature]);
            expect(h.enabledCalls, `${feature} must not consult a module toggle`).toEqual([]);
        }
    });

    it('B6b — an ungated PUBLIC-bucket target still mints a world-readable URL with modules OFF', async () => {
        // Scope honesty. This item does NOT stop a permitted caller minting permanent
        // public objects while every module is off — media/branding/, media/rank/,
        // media/alliance/ and eight more remain public-read and ungated. The gate
        // constrains WHICH FOLDER an object lands in, not whether one can be created.
        h.enabled = {};
        h.user = actor(['admin:config:branding']);
        const res = await post('branding');
        expect(res.statusCode).toBe(200);
        expect(res.body?.visibility).toBe('public');
        expect(res.body?.url).toContain('/object/public/');
    });

    it('B7 — module ON but caller unpermitted still gets the permission 403', async () => {
        h.enabled = { academy: true };
        h.user = actor(['wiki:edit_page']);
        const res = await post('academy');
        expect(res.statusCode).toBe(403);
        expect(res.body?.message).toBe(PERM_DENIED);
        expect(h.uploads).toEqual([]);
    });

    it('B8 — module OFF and caller unpermitted gets the PERMISSION message, and no module state leaks', async () => {
        // Pins the ordering: permission first, so an unpermitted caller cannot probe which
        // modules an org has enabled.
        h.enabled = {};
        h.user = actor(['wiki:edit_page']);
        const res = await post('academy');
        expect(res.body?.message).toBe(PERM_DENIED);
        expect(h.enabledCalls).toEqual([]);
    });

    it('B9 — a THROWING feature reader never reaches storage', async () => {
        // Defensive pin only: lib/db/system.ts's readers each end `catch { return false; }`
        // and getOrgFeatures discards its error, so this is unreachable in production
        // today. It exists so a future refactor that removes those catches cannot turn a
        // read fault into an ungated upload. The reachable fail-closed path is B1b.
        h.enabledThrows = true;
        const res = mockRes();
        await expect(orgUploadHandler(mockReq('academy'), res as any)).rejects.toThrow();
        expect(h.uploads).toEqual([]);
    });

    it('B10 — a Client is refused every target with all modules ON, by the PERMISSION gate', async () => {
        h.enabled = { academy: true, government: true, quartermaster: true, marketplace: true, warehouse: true, finances: true };
        h.user = actor([...CLIENT_DEFAULT_PERMS]);
        for (const feature of FEATURES) {
            h.uploads = [];
            const res = await post(feature);
            expect(res.statusCode, `${feature} must refuse a Client`).toBe(403);
            // The PERMISSION message, not the feature one — which is precisely why a
            // runtime Client-role denial on this endpoint would be dead code. The static
            // ratchet lives in tests/orgUploadPermParity.test.ts (A5).
            expect(res.body?.message, `${feature} denial reason`).toBe(PERM_DENIED);
            expect(h.uploads).toEqual([]);
        }
    });

    it('B11 — an unknown ?for= is still 404 before any feature read', async () => {
        const res = await post('not-a-feature');
        expect(res.statusCode).toBe(404);
        expect(res.body?.message).toBe('Unknown upload target');
        expect(h.enabledCalls).toEqual([]);
        expect(h.uploads).toEqual([]);
    });

    it('B12 — a feature-denied request CONSUMES the caller\'s own upload budget', async () => {
        // The gate sits BELOW the per-user throttle, so hammering a disabled module's
        // target is metered and a request already over the limit is 429'd without paying a
        // settings read. If the gate ever drifts back above the throttle, request 31 comes
        // back 403 instead of 429 and this fails.
        h.enabled = {};
        h.user = actor(['academy:instruct'], 91_001);
        h.decoded = { userId: 91_001 };
        for (let i = 0; i < 30; i++) {
            expect((await post('academy')).statusCode).toBe(403);
        }
        h.enabledCalls = [];
        const throttled = await post('academy');
        expect(throttled.statusCode).toBe(429);
        expect(throttled.headers['Retry-After']).toBeTruthy();
        expect(h.enabledCalls, 'a throttled request must not cost a settings read').toEqual([]);
        expect(h.uploads).toEqual([]);
    });
});

describe('org upload — maintenance mode', () => {
    it('blocks a non-Admin with the dispatcher\'s exact 503 and stores nothing', async () => {
        h.settings = { maintenance_mode: true };
        h.enabled = { academy: true };
        const res = await post('academy');
        expect(res.statusCode).toBe(503);
        expect(res.body?.message).toBe(MAINTENANCE);
        expect(h.uploads).toEqual([]);
        // Runs before the feature allowlist and the permission gate: nothing downstream
        // executes during a declared window.
        expect(h.enabledCalls).toEqual([]);
    });

    it('blocks an unknown-identity actor (unstamped => not Admin)', async () => {
        h.settings = { maintenance_mode: true };
        h.user = { id: 7, roleId: 3, role: 'Custom', permissions: ['academy:instruct'] };
        h.freshAdmin = false;
        expect((await post('academy')).statusCode).toBe(503);
        expect(h.uploads).toEqual([]);
    });

    it('lets the stamped system Admin through', async () => {
        h.settings = { maintenance_mode: true };
        h.enabled = { academy: true };
        h.user = actor(['academy:instruct'], 7, { isSystemAdmin: true });
        const res = await post('academy');
        expect(res.statusCode).toBe(200);
        expect(h.uploads).toEqual(['academy']);
    });

    it('lets a cache-free re-resolved Admin through when the stamp is stale', async () => {
        // An org import rebuilds `roles`, so the 5-minute memo behind isSystemAdmin can
        // name a dead id. Same recovery path as the dispatcher's deny branch.
        h.settings = { maintenance_mode: true };
        h.enabled = { academy: true };
        h.freshAdmin = true;
        const res = await post('academy');
        expect(res.statusCode).toBe(200);
        expect(h.uploads).toEqual(['academy']);
    });

    it('maintenance OFF changes nothing', async () => {
        h.settings = { maintenance_mode: false };
        h.enabled = { academy: true };
        expect((await post('academy')).statusCode).toBe(200);
    });
});
