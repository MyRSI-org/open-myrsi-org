import { describe, it, expect, vi, beforeEach } from 'vitest';

// THE BOOT PAYLOAD, EXERCISED FOR REAL.
//
// Phase 3 item 8's single most important edit is the settings projection inside
// lib/db.ts getState() — it covers TWO egress paths at once: target=initial-state (the
// boot payload the phase headline is about) and the no-subset full state. Before this
// file, every test in the repo that named getState mocked the whole `lib/db` barrel, so
// the real function never executed under vitest and that edit would have landed pinned by
// NOTHING. A structural "no raw ...settings spread" ratchet cannot substitute: it passes
// just as happily for projectSettingsForViewer(settings, undefined) or
// (settings, currentUser?.perms) — the wrong field name, since the real field is
// `permissions` — either of which compiles and silently withholds BOTH gated keys from
// Admins, Dispatchers and every default Member. Instantly visible in production,
// invisible in CI.
//
// So this file mocks one layer LOWER — lib/db/common's supabase client — and drives the
// genuine aggregator. Same idiom as tests/featureGatePredicate.test.ts.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        let keyFilter: string | null = null;
        const rows = () => {
            const all = h.tables[table] ?? [];
            if (keyFilter !== null) return all.filter(r => r.key === keyFilter);
            return all;
        };
        const settle = () => Promise.resolve({ data: rows(), error: null });
        const first = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        const own: Record<string, unknown> = {
            then: (res: unknown, rej: unknown) => settle().then(res as never, rej as never),
            maybeSingle: first,
            single: first,
        };
        // Every other builder method (select/order/limit/in/is/not/or/…) is a no-op that
        // returns the builder, so this stub does not have to track the query DSL as the
        // data layer grows.
        const proxy: any = new Proxy(own, {
            get(t, prop) {
                if (prop in t) return (t as Record<string | symbol, unknown>)[prop];
                if (typeof prop === 'symbol') return undefined;
                return () => proxy;
            },
        });
        // Attached after the proxy exists so `eq` can close over it. Only the `key` column
        // is tracked: settings rows are addressed by key, and every other filter in the
        // aggregate is a no-op against this stub's empty tables.
        own.eq = (col: string, val: string) => { if (col === 'key') keyFilter = val; return proxy; };
        return proxy;
    }
    return {
        supabase: { from: (table: string) => builder(table), rpc: async () => ({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message?: string }) => {
            if (error) throw new Error(message || 'db error');
        },
        safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            const { data, error } = await query; return error ? fallback : (data ?? fallback);
        },
        broadcastToOrg: () => Promise.resolve(),
        broadcastToChannel: () => Promise.resolve(),
        getSystemRoles: async () => ({}),
    };
});
vi.mock('../lib/cache', () => ({
    cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} },
    TTL: {},
}));
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {} }));

import { getState, getMainState } from '../lib/db';
import { CLIENT_SETTINGS_KEYS, GATED_SETTINGS_KEYS } from '../lib/settingsProjection';
import { MEMBER_DEFAULT_PERMS } from '../lib/roleDefaultPermissions';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';

// One row per settings key, exactly as the `settings` table stores them — so
// getAllSettings' real reduce runs over real row shapes rather than a hand-built blob.
const SETTINGS_ROWS = [
    { key: 'brandingConfig', value: { name: 'ORG', termsOfService: '<p>ToS</p>' } },
    { key: 'themeConfig', value: { enabled: true, accent: '#112233' } },
    { key: 'discordConfig', value: { clientId: 'cid' } },
    { key: 'heroCardConfig', value: { title: 'hero' } },
    { key: 'openGraphConfig', value: { title: 'og' } },
    { key: 'radioConfig', value: {} },
    { key: 'aiConfig', value: { enabled: false } },
    { key: 'publicPageConfig', value: { enabled: true } },
    { key: 'governmentsConfig', value: { enabled: true } },
    { key: 'platformSettings', value: { maintenance_mode: false } },
    { key: 'wikiHomeConfig', value: { welcomeContent: { type: 'doc' }, featuredPageIds: ['p1'] } },
    { key: 'hrConfig', value: { probationDays: 0 } },
    // The zero-consumer tail that used to ride every authenticated payload.
    { key: 'system_broadcast', value: { message: 'FLASH — all hands', id: '1' } },
    { key: 'orgFeatures', value: { academy: { enabled: true } } },
    { key: 'schema_version', value: '15.2.0-open' },
    { key: 'setup_completed', value: true },
    { key: 'allianceSelfProfile', value: { orgName: 'X' } },
    { key: 'allianceSyncConfig', value: { intervalMs: 1 } },
    { key: 'systemConfig', value: { appUrl: 'https://x' } },
    { key: 'intelSharingConfig', value: { maxShareableClearance: 0 } },
    // An imported key this fork has never heard of — lib/db/importer.ts's open tail.
    { key: 'starCommsConfig', value: { apiKey: 'sk-leak' } },
];

const WITHHELD_FROM_CLIENT = [
    'wikiHomeConfig', 'hrConfig', 'system_broadcast', 'orgFeatures', 'schema_version',
    'setup_completed', 'allianceSelfProfile', 'allianceSyncConfig', 'systemConfig',
    'intelSharingConfig', 'starCommsConfig',
];

const client = { id: 5, role: 'Client', permissions: [...CLIENT_DEFAULT_PERMS], isSystemAdmin: false };
const member = { id: 6, role: 'Member', permissions: [...MEMBER_DEFAULT_PERMS], isSystemAdmin: false };

beforeEach(() => { h.tables = { settings: SETTINGS_ROWS.map(r => ({ ...r })) }; });

describe('lib/db.ts getState() — the REAL aggregator, settings half', () => {
    it('1. a zero-permission Client receives the projection, not the blob', async () => {
        const state = await getState(client) as Record<string, unknown>;
        for (const key of WITHHELD_FROM_CLIENT) {
            expect(state[key], key).toBeUndefined();
            expect(key in state, `${key} must be ABSENT, not present-with-undefined`).toBe(false);
        }
        // And the Client surfaces that must keep working. brandingConfig carries the ToS
        // body; heroCardConfig is rendered by CreateRequestModal; platformSettings carries
        // maintenance_mode / force_logout_timestamp; discordConfig.clientId is decorated
        // from the env var one layer up and keys on the property being PRESENT.
        for (const key of ['brandingConfig', 'heroCardConfig', 'platformSettings', 'discordConfig']) {
            expect(state[key], key).toBeDefined();
        }
        expect((state.brandingConfig as Record<string, unknown>).termsOfService).toBe('<p>ToS</p>');
    });

    it('2. a wiki:view holder receives wikiHomeConfig on the BOOT path', async () => {
        // The boot twin of the subset=main case in tests/settingsProjection.test.ts, which
        // pins the refresh path only. Both paths must agree, or a browser sees the wiki
        // home page at boot and loses it on the first settings_update.
        const state = await getState({ id: 7, role: 'Member', permissions: ['wiki:view'] }) as Record<string, unknown>;
        expect(state.wikiHomeConfig).toEqual({ welcomeContent: { type: 'doc' }, featuredPageIds: ['p1'] });
        expect('hrConfig' in state).toBe(false);
    });

    it('3. an hr:view holder receives hrConfig; wikiHomeConfig stays withheld', async () => {
        const state = await getState({ id: 8, role: 'Member', permissions: ['hr:view'] }) as Record<string, unknown>;
        expect(state.hrConfig).toEqual({ probationDays: 0 });
        expect('wikiHomeConfig' in state).toBe(false);
    });

    it('4. the REAL seeded Member defaults keep both gated keys', async () => {
        // Driven from MEMBER_DEFAULT_PERMS, not a synthetic ['wiki:view']: removing
        // wiki:view or hr:view from the Member defaults in another cluster would otherwise
        // blank the wiki home page and the probation banner for every member in the org
        // with the entire suite still green.
        const state = await getState(member) as Record<string, unknown>;
        expect(state.wikiHomeConfig).toBeDefined();
        expect(state.hrConfig).toBeDefined();
    });

    it('5. fails closed for a caller with no permissions array at all', async () => {
        for (const viewer of [{ id: 9, role: 'Member' }, { id: 9, role: 'Member', permissions: null }]) {
            const state = await getState(viewer as never) as Record<string, unknown>;
            expect('wikiHomeConfig' in state, JSON.stringify(viewer)).toBe(false);
            expect('hrConfig' in state, JSON.stringify(viewer)).toBe(false);
            expect(state.brandingConfig, JSON.stringify(viewer)).toBeDefined();
        }
    });

    it('6. the projected key set cannot collide with getMainState\'s keys', async () => {
        // Item 3's TG-10, made cheap. `{ ...mainState, ...settings }` means the settings
        // half WINS the spread at both merge sites, so this disjointness is what makes
        // item 3's roster projection the last word. DERIVED at runtime, not a literal
        // 13-name list: getMainState's return has already been rewritten twice this phase,
        // and a hard-coded array keeps passing while no longer describing the function it
        // protects.
        const staffKeys = Object.keys(await getMainState({
            id: 1, role: 'Admin', permissions: ['admin:access'], isSystemAdmin: true,
        } as never));
        const projected = [...CLIENT_SETTINGS_KEYS, ...GATED_SETTINGS_KEYS.map(g => g.key)];
        expect(staffKeys.length).toBeGreaterThan(0);
        expect(projected.filter(k => staffKeys.includes(k))).toEqual([]);
    });
});
