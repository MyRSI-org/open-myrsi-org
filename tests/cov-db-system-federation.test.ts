import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// lib/db/system.ts — the outbound/peer-facing surface and the operator diagnostics:
//   * API-key verification (hash-only lookup, revoked/expired refusal + audit, fail-closed
//     on any read fault, schema-drift flag) and the lifecycle-column probe;
//   * the outbound intel projection (collectShareableIntel / getPublicFeedData):
//     sync_restricted + unknown-marker exclusion, clearance ceiling, enabled channels only,
//     loop guards, cursor clamping on saturation, and FAIL-CLOSED on every read fault;
//   * runDatabaseHealthCheck — every row, including Session Secret and Supabase Anon Key,
//     and that no secret value is ever echoed into the result.

vi.mock('../lib/db/common.js', async () => (await import('./cov-db-system-harness')).commonModule());
vi.mock('../lib/cache.js', async () => (await import('./cov-db-system-harness')).cacheModule());
vi.mock('../lib/push.js', async () => (await import('./cov-db-system-harness')).pushModule());
vi.mock('../lib/db/opReminders.js', async () => (await import('./cov-db-system-harness')).opRemindersModule());
vi.mock('../lib/db/bans.js', async () => (await import('./cov-db-system-harness')).bansModule());
vi.mock('../lib/db/roleDefaults.js', async () => (await import('./cov-db-system-harness')).roleDefaultsModule());
vi.mock('../lib/db/clientRoleLock.js', async () => (await import('./cov-db-system-harness')).clientRoleLockModule());
vi.mock('../lib/crypto.js', async () => (await import('./cov-db-system-harness')).cryptoModule());
vi.mock('../lib/db/secretsRotation.js', async () => (await import('./cov-db-system-harness')).secretsRotationModule());
vi.mock('../lib/db/securityEvents.js', async () => (await import('./cov-db-system-harness')).securityEventsModule());
vi.mock('../lib/db/seeder.js', async () => (await import('./cov-db-system-harness')).seederModule());
vi.mock('../lib/db/public.js', async () => (await import('./cov-db-system-harness')).publicModule());
vi.mock('../lib/discord.js', async () => (await import('./cov-db-system-harness')).discordModule());
vi.mock('../lib/log.js', async () => (await import('./cov-db-system-harness')).logModule());

import { db, mocks, logSpy, resetHarness, has, arg0, args, type Q } from './cov-db-system-harness';
import { EXPECTED_SCHEMA_VERSION } from '../lib/schemaVersion';
import {
    findMissingApiKeyColumns, isApiKeySchemaOutdated, __resetApiKeySchemaFlagForTest, API_KEY_REQUIRED_COLUMNS,
    verifyApiKey, getMaxShareableClearance, intelItemPasses, collectShareableIntel, getPublicFeedData,
    runDatabaseHealthCheck,
} from '../lib/db/system';

const FEED_DOWN = 'Feed temporarily unavailable';
const sel = (q: Q) => arg0(q, 'select');

beforeEach(() => { resetHarness(); __resetApiKeySchemaFlagForTest(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('findMissingApiKeyColumns', () => {
    it('probes each required column with a bounded head-count read; all present ⇒ []', async () => {
        expect(await findMissingApiKeyColumns()).toEqual([]);
        const probes = db.q('api_keys');
        expect(probes.map(sel)).toEqual([...API_KEY_REQUIRED_COLUMNS]);
        for (const q of probes) expect(args(q, 'select')[0][1]).toEqual({ count: 'exact', head: true });
        expect(isApiKeySchemaOutdated()).toBe(false);
    });

    it('names exactly the missing columns (42703) and raises the outdated flag', async () => {
        db.on('api_keys', { error: { code: '42703' } }, (q) => sel(q) === 'scopes' || sel(q) === 'key_prefix');
        expect(await findMissingApiKeyColumns()).toEqual(['scopes', 'key_prefix']);
        expect(isApiKeySchemaOutdated()).toBe(true);
        __resetApiKeySchemaFlagForTest();
        expect(isApiKeySchemaOutdated()).toBe(false);
    });

    it('any other fault THROWS ("could not tell" is not "up to date")', async () => {
        const fault = { code: '57014', message: 'timeout' };
        db.on('api_keys', { error: fault }, (q) => sel(q) === 'expires_at');
        await expect(findMissingApiKeyColumns()).rejects.toBe(fault);
    });
});

describe('verifyApiKey — hash-only, fail-closed', () => {
    const KEY = 'sk_live_example_key';
    const HASH = createHash('sha256').update(KEY).digest('hex');
    const lastUsedWrites = () => db.q('api_keys').filter((q) => has(q, 'update'));

    it('refuses a non-string or empty key without a lookup', async () => {
        expect(await verifyApiKey('')).toBeNull();
        expect(await verifyApiKey(42 as unknown as string)).toBeNull();
        expect(db.queries).toHaveLength(0);
    });

    it('authenticates by SHA-256 hash only, stamps last_used_at, returns id/label/scopes', async () => {
        db.on('api_keys', { data: { id: 'k1', label: 'alliance:p1', scopes: ['alliance'], expires_at: null, revoked_at: null } }, (q) => has(q, 'maybeSingle'));
        expect(await verifyApiKey(KEY)).toEqual({ id: 'k1', label: 'alliance:p1', scopes: ['alliance'] });
        const [look] = db.q('api_keys');
        expect(sel(look)).toBe('id, label, scopes, expires_at, revoked_at');
        expect(has(look, 'eq', 'key_hash', HASH)).toBe(true);
        expect(JSON.stringify(look.ops)).not.toContain(KEY);
        const [stamp] = lastUsedWrites();
        expect(arg0(stamp, 'update')).toEqual({ last_used_at: expect.any(String) });
        expect(has(stamp, 'eq', 'id', 'k1')).toBe(true);
    });

    it('an unknown key is refused', async () => {
        expect(await verifyApiKey(KEY)).toBeNull();
        expect(lastUsedWrites()).toHaveLength(0);
    });

    it('a missing lifecycle column refuses ALL keys loudly and raises the outdated flag', async () => {
        db.on('api_keys', { error: { code: '42703', message: 'column scopes does not exist' } });
        expect(await verifyApiKey(KEY)).toBeNull();
        expect(isApiKeySchemaOutdated()).toBe(true);
        expect(logSpy.error).toHaveBeenCalledWith('api_keys is missing lifecycle columns — re-run schema.sql', {
            code: '42703', required: [...API_KEY_REQUIRED_COLUMNS],
            effect: 'API key authentication is refused until the database is updated.',
        });
    });

    it('any other read fault refuses the key (never fail-open) and logs', async () => {
        db.on('api_keys', { error: { code: '08006' } });
        expect(await verifyApiKey(KEY)).toBeNull();
        expect(isApiKeySchemaOutdated()).toBe(false);
        expect(logSpy.error).toHaveBeenCalledWith('api key lookup failed', { err: { code: '08006' } });
    });

    it('a revoked key is refused and audited, and is NOT stamped as used', async () => {
        db.on('api_keys', { data: { id: 'k2', label: 'Feed', scopes: ['feed'], expires_at: null, revoked_at: '2026-01-01T00:00:00Z' } });
        expect(await verifyApiKey(KEY)).toBeNull();
        expect(mocks.recordSecurityEvent).toHaveBeenCalledWith({ event: 'authz.api_key.revoked', action: 'api:verify_key', details: { keyId: 'k2', label: 'Feed' } });
        expect(lastUsedWrites()).toHaveLength(0);
    });

    it('an expired (or unparseable-expiry) key is refused and audited', async () => {
        db.once('api_keys', { data: { id: 'k3', label: 'Feed', scopes: null, expires_at: '2000-01-01T00:00:00Z', revoked_at: null } });
        expect(await verifyApiKey(KEY)).toBeNull();
        db.once('api_keys', { data: { id: 'k4', label: 'Feed', scopes: null, expires_at: 'not-a-date', revoked_at: null } });
        expect(await verifyApiKey(KEY)).toBeNull();
        expect(mocks.recordSecurityEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ event: 'authz.api_key.expired', details: { keyId: 'k3', label: 'Feed' } }));
        expect(mocks.recordSecurityEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ event: 'authz.api_key.expired', details: { keyId: 'k4', label: 'Feed' } }));
        expect(lastUsedWrites()).toHaveLength(0);
    });

    it('an audit emitter that throws synchronously cannot turn a 403 into a 500', async () => {
        db.on('api_keys', { data: { id: 'k5', label: 'Feed', scopes: null, expires_at: null, revoked_at: 'yes' } });
        mocks.recordSecurityEvent.mockImplementationOnce(() => { throw new Error('emitter missing'); });
        expect(await verifyApiKey(KEY)).toBeNull();
        expect(logSpy.warn).toHaveBeenCalledWith('security event emit threw', expect.objectContaining({ err: expect.any(Error) }));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getMaxShareableClearance / intelItemPasses', () => {
    it('reads the org ceiling; a missing, non-numeric or unreadable value collapses to 0', async () => {
        db.once('settings', { data: { value: { maxShareableClearance: 3 } } });
        expect(await getMaxShareableClearance()).toBe(3);
        const [q] = db.q('settings');
        expect(sel(q)).toBe('value');
        expect(has(q, 'eq', 'key', 'intelSharingConfig')).toBe(true);
        db.once('settings', { data: { value: { maxShareableClearance: '5' } } });
        expect(await getMaxShareableClearance()).toBe(0);
        db.once('settings', { data: null, error: { message: 'down' } });
        expect(await getMaxShareableClearance()).toBe(0);
    });

    it('a restricted item never passes; otherwise level ≤ ceiling (null level = 0)', () => {
        expect(intelItemPasses(0, true, 9)).toBe(false);
        expect(intelItemPasses(null, false, 0)).toBe(true);
        expect(intelItemPasses(undefined, false, -1)).toBe(false);
        expect(intelItemPasses(2, false, 2)).toBe(true);
        expect(intelItemPasses(3, false, 2)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('collectShareableIntel', () => {
    const MARKERS = [
        { id: 1, code: 'NOFORN', sync_restricted: true },
        { id: 2, code: 'REL-ALLY', sync_restricted: false },
        { id: 3, code: 'EYES', sync_restricted: false },
    ];
    const r = (id: string, level: number, ts = '2026-01-01T00:00:00Z') => ({ id, target_id: 't', subject_type: 'person', threat_level: 'low', tags: [], summary: 's', created_at: ts, affiliated_org: null, classification_level: level });
    const b = (id: string, level: number, ts = '2026-01-01T00:00:00Z') => ({ id, title: 't', body: 'b', threat_level: 'low', location: 'x', expires_at: '2099-01-01', classification_level: level, created_at: ts });
    const w = (id: string, ts = '2026-01-01T00:00:00Z') => ({ id, target_rsi_handle: 'h', reason: 'r', action: 'a', uec_reward: 1, status: 'Active', created_at: ts });

    function world(opts: { reports?: unknown[]; warrants?: unknown[]; bulletins?: unknown[]; rAssoc?: unknown[]; bAssoc?: unknown[] } = {}) {
        db.on('security_limiting_markers', { data: MARKERS });
        db.on('intel_reports', { data: opts.reports ?? [] });
        db.on('warrants', { data: opts.warrants ?? [] });
        db.on('intel_bulletins', { data: opts.bulletins ?? [] });
        db.on('intel_report_limiting_markers', { data: opts.rAssoc ?? [] });
        db.on('intel_bulletin_limiting_markers', { data: opts.bAssoc ?? [] });
    }
    const all = { reports: true, warrants: true, bulletins: true };

    it('fails closed when the marker set cannot be read', async () => {
        db.on('security_limiting_markers', { error: { message: 'x' } });
        await expect(collectShareableIntel({ maxClearance: 5, channels: all, bulletinsRequireSharedFlag: false })).rejects.toThrow(FEED_DOWN);
        expect(logSpy.error).toHaveBeenCalledWith('shareable-intel marker lookup failed', { err: { message: 'x' } });
        expect(db.q('intel_reports').some((q) => q.awaited)).toBe(false);
    });

    it('fails closed when the marker set is SATURATED (a marker not fetched cannot exclude)', async () => {
        db.on('security_limiting_markers', { data: Array.from({ length: 500 }, (_, i) => ({ id: i, code: `M${i}`, sync_restricted: false })) });
        await expect(collectShareableIntel({ maxClearance: 5, channels: all, bulletinsRequireSharedFlag: false })).rejects.toThrow(FEED_DOWN);
        const [mq] = db.q('security_limiting_markers');
        expect(sel(mq)).toBe('id, code, sync_restricted');
        expect(has(mq, 'order', 'id', { ascending: true })).toBe(true);
        expect(has(mq, 'limit', 500)).toBe(true);
    });

    it('withholds sync_restricted, unknown-marker and over-ceiling items; tags shareable caveats', async () => {
        world({
            reports: [r('r1', 0), r('r2', 1), r('r3', 0), r('r4', 3), r('r5', 0)],
            warrants: [w('w1')],
            bulletins: [b('b1', 0), b('b2', 0), b('b3', 0), b('b4', 5)],
            rAssoc: [{ report_id: 'r2', marker_id: 2 }, { report_id: 'r3', marker_id: 1 }, { report_id: 'r5', marker_id: 99 }, { report_id: 'r2', marker_id: 3 }],
            bAssoc: [{ bulletin_id: 'b1', marker_id: 2 }, { bulletin_id: 'b1', marker_id: 3 }, { bulletin_id: 'b2', marker_id: 1 }, { bulletin_id: 'b3', marker_id: 77 }],
        });
        const out = await collectShareableIntel({ maxClearance: 2, channels: all, bulletinsRequireSharedFlag: true, since: '2025-12-31T00:00:00Z' });
        expect(out.reports.map((x) => [x.id, x.limiting_markers])).toEqual([['r1', []], ['r2', ['REL-ALLY', 'EYES']]]);
        expect(out.bulletins.map((x) => [x.id, x.limiting_markers])).toEqual([['b1', ['REL-ALLY', 'EYES']]]);
        expect(out.warrants).toEqual([w('w1')]);
        // _meta exposes the ceiling and cursor only — never how much was withheld.
        expect(Object.keys(out._meta).sort()).toEqual(['fetchedAt', 'maxShareableLevel']);
        expect(out._meta.maxShareableLevel).toBe(2);
        expect(Number.isNaN(Date.parse(out._meta.fetchedAt))).toBe(false);
    });

    it('builds each channel query with explicit columns, loop guards, the cursor and ASC order', async () => {
        world({ reports: [r('r1', 0)], bulletins: [b('b1', 0)] });
        await collectShareableIntel({ maxClearance: 0, channels: all, bulletinsRequireSharedFlag: true, since: 'CURSOR' });
        const [rq] = db.q('intel_reports');
        expect(sel(rq)).toBe('id, target_id, subject_type, threat_level, tags, summary, created_at, affiliated_org, classification_level');
        expect(has(rq, 'is', 'source_feed_id', null)).toBe(true);
        expect(has(rq, 'gt', 'created_at', 'CURSOR')).toBe(true);
        expect(args(rq, 'order')).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]]);
        expect(has(rq, 'limit', 500)).toBe(true);
        const [wq] = db.q('warrants');
        expect(sel(wq)).toBe('id, target_rsi_handle, reason, action, uec_reward, status, created_at');
        expect(has(wq, 'is', 'source_feed_id', null)).toBe(true);
        expect(has(wq, 'in', 'status', ['Active', 'Standing'])).toBe(true);
        expect(has(wq, 'gt', 'created_at', 'CURSOR')).toBe(true);
        const [bq] = db.q('intel_bulletins');
        expect(sel(bq)).toBe('id, title, body, threat_level, location, expires_at, classification_level, created_at');
        expect(has(bq, 'gt', 'expires_at')).toBe(true);
        expect(has(bq, 'is', 'source_bulletin_id', null)).toBe(true);
        expect(has(bq, 'is', 'source_organization_id', null)).toBe(true);
        expect(has(bq, 'eq', 'shared_with_allies', true)).toBe(true);
        expect(has(bq, 'gt', 'created_at', 'CURSOR')).toBe(true);
        const [ra] = db.q('intel_report_limiting_markers');
        expect(sel(ra)).toBe('report_id, marker_id');
        expect(has(ra, 'in', 'report_id', ['r1'])).toBe(true);
        const [ba] = db.q('intel_bulletin_limiting_markers');
        expect(sel(ba)).toBe('bulletin_id, marker_id');
        expect(has(ba, 'in', 'bulletin_id', ['b1'])).toBe(true);
    });

    it('a disabled channel is never executed and returns []; no shared-flag/cursor filter when not asked', async () => {
        world({ reports: [r('r1', 0)], warrants: [w('w1')], bulletins: [b('b1', 0)] });
        const out = await collectShareableIntel({ maxClearance: 5, channels: { warrants: true }, bulletinsRequireSharedFlag: false });
        expect(out.reports).toEqual([]);
        expect(out.bulletins).toEqual([]);
        expect(out.warrants).toEqual([w('w1')]);
        expect(db.q('intel_reports')[0].awaited).toBe(false);
        expect(db.q('intel_bulletins')[0].awaited).toBe(false);
        expect(db.q('warrants')[0].awaited).toBe(true);
        expect(has(db.q('intel_bulletins')[0], 'eq', 'shared_with_allies', true)).toBe(false);
        expect(has(db.q('warrants')[0], 'gt', 'created_at')).toBe(false);
        expect(db.q('intel_report_limiting_markers')).toHaveLength(0);
        expect(db.q('intel_bulletin_limiting_markers')).toHaveLength(0);
    });

    it('a sub-zero ceiling withholds even level-0 warrants; an omitted ceiling means 0', async () => {
        world({ reports: [r('r1', 0), r('r2', 1)], warrants: [w('w1')] });
        const neg = await collectShareableIntel({ maxClearance: -1, channels: all, bulletinsRequireSharedFlag: false });
        expect(neg.warrants).toEqual([]);
        expect(neg.reports).toEqual([]);
        const dflt = await collectShareableIntel({ maxClearance: undefined as unknown as number, channels: all, bulletinsRequireSharedFlag: false });
        expect(dflt._meta.maxShareableLevel).toBe(0);
        expect(dflt.reports.map((x) => x.id)).toEqual(['r1']);
    });

    it('null payloads are empty, not errors', async () => {
        db.on('security_limiting_markers', { data: null });
        db.on('intel_reports', { data: [r('r1', 0)] });
        db.on('intel_report_limiting_markers', { data: null });
        db.on('warrants', { data: null });
        db.on('intel_bulletins', { data: null });
        const out = await collectShareableIntel({ maxClearance: 0, channels: all, bulletinsRequireSharedFlag: false });
        expect(out.reports.map((x) => x.id)).toEqual(['r1']);
        expect(out.warrants).toEqual([]);
        expect(out.bulletins).toEqual([]);
    });

    it.each(['intel_reports', 'warrants', 'intel_bulletins'])('a %s read fault fails the whole page closed', async (table) => {
        world({ reports: [r('r1', 0)], warrants: [w('w1')], bulletins: [b('b1', 0)] });
        db.on(table, { error: { message: 'boom' } });
        await expect(collectShareableIntel({ maxClearance: 5, channels: all, bulletinsRequireSharedFlag: false })).rejects.toThrow(FEED_DOWN);
        expect(logSpy.error).toHaveBeenCalledWith('shareable-intel channel query failed', expect.objectContaining({ err: { message: 'boom' } }));
    });

    it.each(['intel_report_limiting_markers', 'intel_bulletin_limiting_markers'])('a %s fault fails closed (never an empty exclusion set)', async (table) => {
        world({ reports: [r('r1', 0)], bulletins: [b('b1', 0)] });
        db.on(table, { error: { message: '414 URI too long' } });
        await expect(collectShareableIntel({ maxClearance: 5, channels: all, bulletinsRequireSharedFlag: false })).rejects.toThrow(FEED_DOWN);
        expect(logSpy.error).toHaveBeenCalledWith('shareable-intel marker-association lookup failed', { err: { message: '414 URI too long' } });
    });

    it('marker associations are fetched in chunks of 100 ids', async () => {
        const reports = Array.from({ length: 250 }, (_, i) => r(`r${i}`, 0, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`));
        world({ reports });
        await collectShareableIntel({ maxClearance: 0, channels: { reports: true }, bulletinsRequireSharedFlag: false });
        const batches = db.q('intel_report_limiting_markers').map((q) => (args(q, 'in')[0][1] as string[]).length);
        expect(batches).toEqual([100, 100, 50]);
    });

    it('a saturated page clamps the cursor to the last created_at strictly below the tail (min across legs)', async () => {
        const reports = Array.from({ length: 500 }, (_, i) => r(`r${i}`, 0, `2026-02-01T00:00:00.${String(Math.min(i, 498)).padStart(3, '0')}Z`));
        const warrants = Array.from({ length: 500 }, (_, i) => w(`w${i}`, `2026-01-15T00:00:00.${String(i).padStart(3, '0')}Z`));
        world({ reports, warrants });
        const out = await collectShareableIntel({ maxClearance: 0, channels: all, bulletinsRequireSharedFlag: false });
        // reports tail = rows 498,499 at .498 ⇒ cursor .497; warrants tail .499 ⇒ cursor .498; min wins.
        expect(out._meta.fetchedAt).toBe('2026-01-15T00:00:00.498Z');
        expect(logSpy.warn).toHaveBeenCalledWith('shareable-intel page saturated; clamping the next cursor to the last row served', { cap: 500, effectiveFetchedAt: '2026-01-15T00:00:00.498Z' });
    });

    it('with three saturated legs the earliest clamped cursor wins regardless of leg order', async () => {
        const page = (prefix: string, mk: (id: string, ts: string) => unknown) => Array.from({ length: 500 }, (_, i) => mk(`${prefix}${i}`, `${prefix === 'r' ? '2026-01' : prefix === 'w' ? '2026-02' : '2026-03'}-01T00:00:00.${String(i).padStart(3, '0')}Z`));
        world({
            reports: page('r', (id, ts) => r(id, 0, ts)),
            warrants: page('w', (id, ts) => w(id, ts)),
            bulletins: page('b', (id, ts) => b(id, 0, ts)),
        });
        const out = await collectShareableIntel({ maxClearance: 0, channels: all, bulletinsRequireSharedFlag: false });
        expect(out._meta.fetchedAt).toBe('2026-01-01T00:00:00.498Z');
    });

    it('a saturated page sharing ONE timestamp cannot advance the cursor ⇒ refuses to serve', async () => {
        world({ bulletins: Array.from({ length: 500 }, (_, i) => b(`b${i}`, 0, '2026-03-01T00:00:00Z')) });
        await expect(collectShareableIntel({ maxClearance: 0, channels: { bulletins: true }, bulletinsRequireSharedFlag: false })).rejects.toThrow(FEED_DOWN);
        expect(logSpy.error).toHaveBeenCalledWith(expect.stringContaining('cannot advance the cursor'), { cap: 500 });
    });

    it('a saturated but DISABLED channel never clamps the enabled ones', async () => {
        world({ reports: Array.from({ length: 500 }, (_, i) => r(`r${i}`, 0, '2026-03-01T00:00:00Z')), warrants: [w('w1')] });
        const out = await collectShareableIntel({ maxClearance: 0, channels: { warrants: true }, bulletinsRequireSharedFlag: false });
        expect(out.warrants).toHaveLength(1);
        expect(logSpy.warn).not.toHaveBeenCalled();
    });
});

describe('getPublicFeedData', () => {
    it('applies the org ceiling, all channels, the per-bulletin share opt-in and the cursor', async () => {
        db.on('settings', { data: { value: { maxShareableClearance: 1 } } });
        db.on('intel_reports', { data: [{ id: 'r1', classification_level: 1, created_at: 't' }, { id: 'r2', classification_level: 2, created_at: 't' }] });
        const out = await getPublicFeedData('SINCE');
        expect(out._meta.maxShareableLevel).toBe(1);
        expect(out.reports.map((x) => x.id)).toEqual(['r1']);
        expect(has(db.q('intel_bulletins')[0], 'eq', 'shared_with_allies', true)).toBe(true);
        expect(has(db.q('intel_reports')[0], 'gt', 'created_at', 'SINCE')).toBe(true);
        expect(db.q('warrants')[0].awaited).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('runDatabaseHealthCheck', () => {
    const ENV = ['JWT_SECRET', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'SECRETS_ENCRYPTION_KEY', 'VAPID_PUBLIC_KEY'];
    let saved: Record<string, string | undefined>;
    const STRONG_SESSION = 'session-secret-'.padEnd(48, 'q');
    beforeEach(() => {
        saved = {};
        for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
        process.env.JWT_SECRET = STRONG_SESSION;
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-value';
        process.env.SUPABASE_ANON_KEY = 'sb_publishable_abc123';
        db.on('settings', { data: { value: EXPECTED_SCHEMA_VERSION } });
    });
    afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    const row = <T extends { check: string }>(rows: T[], prefix: string) => rows.find((x) => x.check.startsWith(prefix));

    it('a healthy deployment: every diagnostic row OK, then the counts', async () => {
        db.on('service_requests', { count: 10 });
        db.on('intel_reports', { count: 4 });
        db.on('users', { count: 0 });
        db.on('operations', { count: 2 });
        db.on('hr_applications', { count: 7 });
        mocks.inventorySecretCiphertexts.mockResolvedValue({ total: 3, underCurrent: 3, underPrevious: 0, undecryptable: 0, noKey: 0 });
        const out = await runDatabaseHealthCheck();
        expect(out).toEqual([
            { check: `Schema Version (${EXPECTED_SCHEMA_VERSION})`, status: 'OK', count: null },
            { check: 'Secret Encryption (3 value(s) current)', status: 'OK', count: 3 },
            { check: 'Session Secret', status: 'OK', count: null },
            { check: 'Supabase Anon Key', status: 'OK', count: null },
            { check: 'API Key Lifecycle Columns', status: 'OK', count: null },
            { check: 'Total Service Requests', status: 'OK', count: 10 },
            { check: 'Total Intel Reports', status: 'OK', count: 4 },
            { check: 'User Role Integrity', status: 'OK', count: 0 },
            { check: 'Total Operations Logged', status: 'OK', count: 2 },
            { check: 'HR Case Files', status: 'OK', count: 7 },
        ]);
        const [ver] = db.q('settings');
        expect(sel(ver)).toBe('value');
        expect(has(ver, 'eq', 'key', 'schema_version')).toBe(true);
        for (const t of ['service_requests', 'intel_reports', 'users', 'operations', 'hr_applications']) {
            const [q] = db.q(t);
            expect(sel(q)).toBe('id');
            expect(args(q, 'select')[0][1]).toEqual({ count: 'exact', head: true });
        }
        expect(has(db.q('users')[0], 'is', 'role_id', null)).toBe(true);
        expect(has(db.q('users')[0], 'is', 'deleted_at', null)).toBe(true);
        expect(db.q('government_motions')).toHaveLength(0);
    });

    it.each([
        ['14.0.0-open', `Schema Version (found 14.0.0-open, expected ${EXPECTED_SCHEMA_VERSION})`],
        [null, 'Schema Version (not recorded)'],
        [42, 'Schema Version (not recorded)'],
    ])('schema stamp %j ⇒ WARNING "%s"', async (stamp, check) => {
        db.on('settings', { data: stamp === null ? null : { value: stamp } });
        const out = await runDatabaseHealthCheck();
        expect(out[0]).toEqual({ check, status: 'WARNING', count: null, action: 'Re-run schema.sql' });
    });

    it('an unreadable schema stamp is UNKNOWN (warning), never a false drift', async () => {
        db.on('settings', () => { throw new Error('relation does not exist'); });
        expect((await runDatabaseHealthCheck())[0]).toEqual({ check: 'Schema Version (unreadable)', status: 'WARNING', count: null, action: 'Re-run schema.sql' });
    });

    it.each([
        [{ noKey: 2, undecryptable: 1, underPrevious: 1, underCurrent: 0 }, false, { check: 'Secret Encryption (2 encrypted value(s), no key configured)', status: 'ERROR', count: 2, action: 'Set SECRETS_ENCRYPTION_KEY and restart' }],
        [{ noKey: 0, undecryptable: 1, underPrevious: 1, underCurrent: 0 }, false, { check: 'Secret Encryption (1 value(s) decrypt under NEITHER key)', status: 'ERROR', count: 1, action: 'Set SECRETS_ENCRYPTION_KEY_PREVIOUS to the old key and restart' }],
        [{ noKey: 0, undecryptable: 0, underPrevious: 4, underCurrent: 1 }, true, { check: 'Secret Encryption (4 value(s) still under the previous key)', status: 'WARNING', count: 4, action: 'Rotate Encryption Key' }],
        [{ noKey: 0, undecryptable: 0, underPrevious: 0, underCurrent: 5 }, true, { check: 'Secret Encryption (5 current; previous key no longer needed)', status: 'WARNING', count: 5, action: 'Remove SECRETS_ENCRYPTION_KEY_PREVIOUS' }],
    ])('secret inventory %j (previous key=%s) ⇒ %j', async (inv, prev, expected) => {
        mocks.inventorySecretCiphertexts.mockResolvedValue({ total: 0, ...inv });
        mocks.hasPreviousKey.mockReturnValue(prev);
        const out = await runDatabaseHealthCheck();
        expect(out[1]).toEqual(expected);
    });

    it('an unreadable secret inventory is a WARNING with no count', async () => {
        mocks.inventorySecretCiphertexts.mockRejectedValue(new Error('x'));
        expect((await runDatabaseHealthCheck())[1]).toEqual({ check: 'Secret Encryption (unreadable)', status: 'WARNING', count: null });
    });

    it('Session Secret: unset / short / published-copy are ERROR; 16-31 chars or a private-key copy WARN; value never echoed', async () => {
        delete process.env.JWT_SECRET;
        expect(row(await runDatabaseHealthCheck(), 'Session Secret')).toEqual({
            check: 'Session Secret (JWT_SECRET not configured)', status: 'ERROR', count: null,
            action: 'Set a new JWT_SECRET: see Rotating the session secret in DEPLOYMENT_GUIDE.md',
        });
        process.env.JWT_SECRET = 'short-secret';
        expect(row(await runDatabaseHealthCheck(), 'Session Secret')?.check).toBe('Session Secret (JWT_SECRET shorter than 16 characters)');
        process.env.JWT_SECRET = 'twenty-char-secret!!';
        expect(row(await runDatabaseHealthCheck(), 'Session Secret')).toEqual({
            check: 'Session Secret (JWT_SECRET shorter than the recommended 32 characters)', status: 'WARNING', count: null,
            action: 'Rotate JWT_SECRET when convenient: see Rotating the session secret in DEPLOYMENT_GUIDE.md',
        });
        process.env.JWT_SECRET = STRONG_SESSION;
        process.env.SECRETS_ENCRYPTION_KEY = STRONG_SESSION;
        const warnRow = row(await runDatabaseHealthCheck(), 'Session Secret');
        expect(warnRow?.check).toBe('Session Secret (JWT_SECRET identical to SECRETS_ENCRYPTION_KEY)');
        expect(JSON.stringify(warnRow)).not.toContain(STRONG_SESSION);
        process.env.SUPABASE_ANON_KEY = STRONG_SESSION;
        const out = await runDatabaseHealthCheck();
        expect(row(out, 'Session Secret')?.status).toBe('ERROR');
        expect(row(out, 'Session Secret')?.check).toContain('identical to the published SUPABASE_ANON_KEY');
        expect(JSON.stringify(out)).not.toContain(STRONG_SESSION);
    });

    it('Supabase Anon Key: missing WARN, secret ERROR, unrecognised WARN — the key is never echoed', async () => {
        const setPublishable = 'Set SUPABASE_ANON_KEY to the publishable (sb_publishable_…) or legacy anon key from Supabase Dashboard → Project Settings → API, then restart';
        delete process.env.SUPABASE_ANON_KEY;
        expect(row(await runDatabaseHealthCheck(), 'Supabase Anon Key')).toEqual({ check: 'Supabase Anon Key (not set — live updates disabled)', status: 'WARNING', count: null, action: setPublishable });

        process.env.SUPABASE_ANON_KEY = 'sb_secret_DO_NOT_LEAK_123';
        let out = await runDatabaseHealthCheck();
        expect(row(out, 'Supabase Anon Key')).toEqual({
            check: 'Supabase Anon Key (is a secret key (sb_secret_) — withheld from browsers; replace it with the publishable key)',
            status: 'ERROR', count: null, action: `${setPublishable}. Never use the service-role / sb_secret_ key here`,
        });
        expect(JSON.stringify(out)).not.toContain('DO_NOT_LEAK');

        process.env.SUPABASE_ANON_KEY = 'service-role-value';
        out = await runDatabaseHealthCheck();
        expect(row(out, 'Supabase Anon Key')?.check).toBe('Supabase Anon Key (same as SUPABASE_SERVICE_ROLE_KEY — withheld from browsers; replace it with the publishable key)');
        expect(JSON.stringify(out)).not.toContain('service-role-value');

        process.env.SUPABASE_ANON_KEY = 'garbage-NOT-A-KEY';
        out = await runDatabaseHealthCheck();
        expect(row(out, 'Supabase Anon Key')).toEqual({ check: 'Supabase Anon Key (not a recognised publishable key — never sent to browsers; live updates disabled)', status: 'WARNING', count: null, action: setPublishable });
        expect(JSON.stringify(out)).not.toContain('garbage-NOT-A-KEY');
    });

    it('API key lifecycle: names the missing columns (ERROR) or reports unreadable (WARNING)', async () => {
        db.on('api_keys', { error: { code: '42703' } }, (q) => sel(q) === 'revoked_at');
        expect(row(await runDatabaseHealthCheck(), 'Database Update Required')).toEqual({
            check: 'Database Update Required — api_keys is missing: revoked_at', status: 'ERROR', count: 1,
            action: 'Re-run schema.sql — API key authentication is refused until you do',
        });
        db.on('api_keys', { error: { code: '08006' } });
        expect(row(await runDatabaseHealthCheck(), 'API Key Lifecycle Columns')).toEqual({ check: 'API Key Lifecycle Columns (unreadable)', status: 'WARNING', count: null });
    });

    it('mid-rotation only: secret-ballot motions in Voting are flagged; a fault there is contained', async () => {
        mocks.hasPreviousKey.mockReturnValue(true);
        db.once('government_motions', { count: 2 });
        let out = await runDatabaseHealthCheck();
        expect(row(out, 'Secret-Ballot')).toEqual({ check: 'Secret-Ballot Motions Mid-Vote During Key Change', status: 'WARNING', count: 2, action: 'Set BALLOT_PEPPER or conclude the vote' });
        const [mq] = db.q('government_motions');
        expect(sel(mq)).toBe('id');
        expect(has(mq, 'eq', 'is_secret_ballot', true)).toBe(true);
        expect(has(mq, 'eq', 'status', 'Voting')).toBe(true);
        db.once('government_motions', { count: 0 });
        out = await runDatabaseHealthCheck();
        expect(row(out, 'Secret-Ballot')).toBeUndefined();
        db.once('government_motions', () => { throw new Error('no table'); });
        out = await runDatabaseHealthCheck();
        expect(row(out, 'Secret-Ballot')).toBeUndefined();
        expect(row(out, 'HR Case Files')).toBeDefined();
    });

    it('users missing a role are flagged as repairable', async () => {
        db.on('users', { count: 3 });
        expect(row(await runDatabaseHealthCheck(), 'Users Missing Role')).toEqual({ check: 'Users Missing Role', status: 'WARNING', count: 3, action: 'Repairable' });
    });
});
