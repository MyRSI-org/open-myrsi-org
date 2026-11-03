import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/orgUpload.ts — POST /api/org/upload?for=<feature>, the raw-bytes image write surface
// that bypasses the RPC dispatcher and so re-implements its gates.
//
// tests/orgUploadFeatureGate.test.ts pins the optional-module gate, the permission gate
// and maintenance mode. This suite pins everything else on the ladder, with REAL session
// tokens (lib/auth signToken/verifyToken — real HMAC, real expiry, real force-logout and
// watermark predicates) and the real cookie reader:
//   - orgUploadPreAuth: refuses a caller with no valid session BEFORE the body parser
//     buffers the upload, touches no DB, and answers with the handler's own 401 body;
//   - the same-origin gate (and that it writes no audit row for an unauthenticated caller);
//   - token → force-logout → watermark → user → ban, in that order, each failing closed;
//   - the ban gate's audit row (ids only) and its fail-closed 503 on a read fault;
//   - body validation, and the storage error → status mapping (413/415/507/500), with the
//     storage-cap denial audited;
//   - the success projection (exactly success/url/key/visibility, no-store) and a log line
//     that carries ids and a byte count only — never content;
//   - the per-user throttle: exact Retry-After arithmetic, the window boundary, per-user
//     isolation, the memory cap (sheds NEW ids, never evicts tracked ones) and pruning;
//   - the fail-closed 500 when a write action's namespace cannot be derived.

const h = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    user: null as Record<string, unknown> | null,
    userCalls: [] as unknown[],
    settingsCalls: 0,
    ban: null as { id: string } | null,
    banThrows: null as Error | null,
    banCalls: [] as unknown[],
    enabled: {} as Record<string, boolean>,
    events: [] as Array<Record<string, unknown>>,
    uploads: [] as Array<{ feature: string; buf: unknown }>,
    uploadThrows: null as unknown,
    logs: [] as Array<{ level: string; ctx: Record<string, unknown>; msg: string; fields?: Record<string, unknown> }>,
    writeActions: {} as Record<string, string | string[]>,
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ count: 0, data: null, error: null });
    return b;
}

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => { h.settingsCalls++; return h.settings; },
    getUserById: async (id: unknown) => { h.userCalls.push(id); return h.user; },
    findActiveBan: async (q: unknown) => {
        h.banCalls.push(q);
        if (h.banThrows) throw h.banThrows;
        return h.ban;
    },
    getBanNotice: async () => null,
    getAllSettings: async () => ({}),
    getSystemRoles: async () => ({ admin: { id: 1 } }),
    resolveIsSystemAdminFresh: async () => false,
    isOptionalFeatureEnabled: async (feature: string) => h.enabled[feature] ?? false,
    recordSecurityEvent: (ev: Record<string, unknown>) => { h.events.push(ev); return Promise.resolve(); },
}));

vi.mock('../lib/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/storage')>();
    return {
        ...actual,
        uploadOrgMedia: async (feature: keyof typeof actual.ORG_MEDIA_FEATURES, buf: unknown) => {
            h.uploads.push({ feature, buf });
            if (h.uploadThrows !== null) throw h.uploadThrows;
            const def = actual.ORG_MEDIA_FEATURES[feature];
            const key = `media/${feature}/00000000-0000-4000-8000-000000000000.webp`;
            return {
                url: def.visibility === 'public' ? `https://proj.supabase.co/storage/v1/object/public/${def.bucket}/${key}` : null,
                key,
                visibility: def.visibility,
            };
        },
    };
});

// The write-action map stays REAL; the object is shared so one test can reshape a single
// entry (and afterEach restores it) to drive the fail-closed namespace branch.
vi.mock('../api/orgUploadPerms', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api/orgUploadPerms')>();
    Object.assign(h.writeActions, actual.FEATURE_WRITE_ACTION);
    return { ...actual, FEATURE_WRITE_ACTION: h.writeActions };
});

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    type L = typeof actual.log;
    const mk = (ctx: Record<string, unknown>): L => ({
        debug: (msg, fields) => { h.logs.push({ level: 'debug', ctx, msg, fields }); },
        info: (msg, fields) => { h.logs.push({ level: 'info', ctx, msg, fields }); },
        warn: (msg, fields) => { h.logs.push({ level: 'warn', ctx, msg, fields }); },
        error: (msg, fields) => { h.logs.push({ level: 'error', ctx, msg, fields }); },
        child: (more) => mk({ ...ctx, ...more }),
    });
    return { ...actual, log: mk({}) };
});

import orgUploadHandler, { orgUploadPreAuth, pruneOrgUploadBuckets } from '../api/orgUpload';
import { FEATURE_WRITE_ACTION as REAL_WRITE_ACTIONS } from '../api/orgUploadPerms';
import { signToken } from '../lib/auth';
import { sessionCookieName, SESSION_COOKIE_IS_SECURE } from '../lib/sessionCookie';

const ORIGINAL_WRITE_ACTIONS = structuredClone({ ...REAL_WRITE_ACTIONS });
const T0 = new Date('2026-08-01T00:00:00.000Z').getTime();
const IP = '203.0.113.9';
const IMAGE = Buffer.from('fake-image-bytes');
const UNAUTH = { message: 'Unauthorized' };
const EXPIRED = 'Session expired. Please log in again.';

interface MockRes {
    statusCode: number;
    body: Record<string, unknown> | undefined;
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

function actor(extra: Record<string, unknown> = {}) {
    return {
        id: 7, discordId: 'discord-7', rsiHandle: 'Uploader', roleId: 3, role: 'Custom',
        permissions: ['admin:config:branding', 'wiki:edit_page'], isSystemAdmin: false, tokensValidFrom: null, ...extra,
    };
}

let token = '';

function req(over: { feature?: unknown; headers?: Record<string, unknown>; body?: unknown; auth?: boolean } = {}) {
    const headers: Record<string, unknown> = { host: 'org.example', ...(over.auth === false ? {} : { authorization: `Bearer ${token}` }), ...over.headers };
    return {
        method: 'POST',
        query: 'feature' in over ? { for: over.feature } : { for: 'branding' },
        headers,
        ip: IP,
        body: 'body' in over ? over.body : IMAGE,
    };
}

async function post(over: Parameters<typeof req>[0] = {}): Promise<MockRes> {
    const res = mockRes();
    await orgUploadHandler(req(over) as never, res as never);
    return res;
}

const logs = (level: string) => h.logs.filter((l) => l.level === level).map((l) => ({ msg: l.msg, fields: l.fields }));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    pruneOrgUploadBuckets(T0 + 10 * 60_000);
    token = signToken({ userId: 7 });
    h.settings = {};
    h.user = actor();
    h.userCalls = [];
    h.settingsCalls = 0;
    h.ban = null;
    h.banThrows = null;
    h.banCalls = [];
    h.enabled = {};
    h.events = [];
    h.uploads = [];
    h.uploadThrows = null;
    h.logs = [];
});

afterEach(() => {
    for (const k of Object.keys(h.writeActions)) delete h.writeActions[k];
    Object.assign(h.writeActions, structuredClone(ORIGINAL_WRITE_ACTIONS));
    pruneOrgUploadBuckets(Date.now() + 10 * 60_000);
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('orgUploadPreAuth — refuse before the body is buffered', () => {
    function run(headers: Record<string, unknown>) {
        const res = mockRes();
        const next = vi.fn();
        orgUploadPreAuth({ headers } as never, res as never, next);
        return { res, next };
    }

    it('a valid bearer token passes straight through, with no I/O and no response written', () => {
        const { res, next } = run({ authorization: `Bearer ${token}` });
        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith();
        expect(res.statusCode).toBe(0);
        expect(res.headers).toEqual({});
        expect(h.settingsCalls).toBe(0);
        expect(h.userCalls).toEqual([]);
    });

    it('a valid session cookie passes (cookie preferred over a bad header)', () => {
        const { next } = run({ cookie: `other=1; ${sessionCookieName(SESSION_COOKIE_IS_SECURE)}=${token}`, authorization: 'Bearer junk' });
        expect(next).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['no credential at all', {}],
        ['a bare "Bearer" with no token', { authorization: 'Bearer' }],
        ['garbage token', { authorization: 'Bearer not.a.token' }],
        ['wrong cookie name', { cookie: `myrsi_session_x=${'a'.repeat(20)}.${'0'.repeat(64)}` }],
    ])('%s → 401 Unauthorized, no-store, next() never called', (_label, headers) => {
        const { res, next } = run(headers);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual(UNAUTH);
        expect(res.headers).toEqual({ 'Cache-Control': 'no-store' });
        expect(h.settingsCalls).toBe(0);
    });

    it('a forged signature is refused', () => {
        const [data] = token.split('.');
        const { res, next } = run({ authorization: `Bearer ${data}.${'f'.repeat(64)}` });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('an expired token is refused (24h lifetime)', () => {
        vi.setSystemTime(T0 + 24 * 60 * 60 * 1000 + 1);
        const { res, next } = run({ authorization: `Bearer ${token}` });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });
});

// ---------------------------------------------------------------------------
describe('same-origin gate', () => {
    it.each([
        ['a foreign origin', { origin: 'https://evil.example' }],
        ['a port mismatch', { origin: 'https://org.example:8443' }],
        ['an unparseable origin', { origin: 'not a url' }],
        ['an origin with no Host to compare against', { origin: 'https://org.example', host: undefined }],
    ])('%s → 403 before any auth work, and NO audit row for the unauthenticated caller', async (_label, headers) => {
        const res = await post({ headers });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Forbidden: cross-site request blocked' });
        expect(h.settingsCalls).toBe(0);
        expect(h.userCalls).toEqual([]);
        expect(h.events).toEqual([]);
        expect(h.uploads).toEqual([]);
    });

    it.each([
        ['no Origin header', {}],
        ['a matching Origin', { origin: 'https://org.example' }],
        ['an Origin matching the forwarded host', { origin: 'https://public.example', host: 'internal:3000', 'x-forwarded-host': 'public.example' }],
    ])('%s is allowed through to the token check', async (_label, headers) => {
        const res = await post({ headers });
        expect(res.statusCode).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe('session ladder: token → force-logout → watermark → user', () => {
    it('no token → 401 without reading settings or the user', async () => {
        const res = await post({ auth: false });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual(UNAUTH);
        expect(h.settingsCalls).toBe(0);
        expect(h.userCalls).toEqual([]);
    });

    it('an invalid token → 401 without reading settings', async () => {
        const res = await post({ headers: { authorization: 'Bearer forged.token' } });
        expect(res.statusCode).toBe(401);
        expect(h.settingsCalls).toBe(0);
    });

    it('a token issued before the platform force-logout → 401 with force_logout, user never loaded', async () => {
        h.settings = { force_logout_timestamp: new Date(T0 + 1).toISOString() };
        const res = await post();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: EXPIRED, force_logout: true });
        expect(h.userCalls).toEqual([]);
        expect(h.uploads).toEqual([]);
    });

    it('a token issued AFTER the force-logout is accepted', async () => {
        h.settings = { force_logout_timestamp: new Date(T0 - 1).toISOString() };
        expect((await post()).statusCode).toBe(200);
        expect(h.userCalls).toEqual([7]);
    });

    it('a token issued before the user\'s revocation watermark → 401 (no force_logout flag), ban never checked', async () => {
        h.user = actor({ tokensValidFrom: new Date(T0 + 1).toISOString() });
        const res = await post();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: EXPIRED });
        expect(h.banCalls).toEqual([]);
        expect(h.uploads).toEqual([]);
    });

    it('a deleted / unknown user → 401 Unauthorized, ban never checked', async () => {
        h.user = null;
        const res = await post();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual(UNAUTH);
        expect(h.banCalls).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('org ban gate', () => {
    it('an active ban → 403, audited with ids only, nothing stored', async () => {
        h.ban = { id: 'ban-42' };
        const res = await post();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Your access to this organization has been suspended.' });
        expect(h.banCalls).toEqual([{ userId: 7, discordId: 'discord-7' }]);
        expect(h.events).toEqual([{
            event: 'authz.org_ban.denied',
            action: 'org:upload',
            actorUserId: 7,
            actorLabel: 'Uploader',
            actorIp: IP,
            details: { banId: 'ban-42', surface: 'org_upload' },
        }]);
        expect(h.uploads).toEqual([]);
    });

    it('an audit row without a numeric id / handle records nulls rather than caller text', async () => {
        h.ban = { id: 'ban-1' };
        h.user = actor({ id: 'seven', rsiHandle: undefined });
        await post();
        expect(h.events[0]).toMatchObject({ actorUserId: null, actorLabel: null });
    });

    it('a ban-read fault (BanCheckUnavailable) fails CLOSED with a retryable 503 and no error log', async () => {
        h.banThrows = Object.assign(new Error('ban table unavailable'), { name: 'BanCheckUnavailable' });
        const res = await post();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ message: 'Unable to verify account status. Please try again.' });
        expect(logs('error')).toEqual([]);
        expect(h.uploads).toEqual([]);
    });

    it('an unexpected throw in the gate also fails closed, and is logged loudly', async () => {
        const boom = new TypeError('cannot read properties of undefined');
        h.banThrows = boom;
        const res = await post();
        expect(res.statusCode).toBe(503);
        expect(logs('error')).toEqual([{ msg: 'ban gate failed unexpectedly on org upload', fields: { userId: 7, err: boom } }]);
        expect(h.uploads).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('body validation and storage outcomes', () => {
    it.each([
        ['a string', 'not-a-buffer'],
        ['a parsed object', { image: 'x' }],
        ['undefined', undefined],
        ['an empty Buffer', Buffer.alloc(0)],
    ])('%s body → 400, storage never called', async (_label, body) => {
        const res = await post({ body });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Empty or invalid image body' });
        expect(h.uploads).toEqual([]);
    });

    it('success returns exactly { success, url, key, visibility }, no-store, and logs ids + byte count only', async () => {
        const res = await post({ feature: 'branding' });
        expect(res.statusCode).toBe(200);
        expect(res.headers).toEqual({ 'Cache-Control': 'no-store' });
        expect(res.body).toEqual({
            success: true,
            url: 'https://proj.supabase.co/storage/v1/object/public/org-public-media/media/branding/00000000-0000-4000-8000-000000000000.webp',
            key: 'media/branding/00000000-0000-4000-8000-000000000000.webp',
            visibility: 'public',
        });
        expect(h.uploads).toHaveLength(1);
        expect(h.uploads[0].feature).toBe('branding');
        expect(h.uploads[0].buf).toBe(IMAGE);
        expect(logs('info')).toEqual([{
            msg: 'org media uploaded',
            fields: { userId: 7, feature: 'branding', bytes: IMAGE.length, key: 'media/branding/00000000-0000-4000-8000-000000000000.webp' },
        }]);
        expect(JSON.stringify(h.logs)).not.toContain('fake-image-bytes');
        expect(h.events).toEqual([]);
    });

    it('a private-bucket feature returns a null url and the object key (signed on read)', async () => {
        const res = await post({ feature: 'wiki' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, url: null, visibility: 'private' });
        expect(res.body?.key).toBe('media/wiki/00000000-0000-4000-8000-000000000000.webp');
    });

    it.each([
        ['Image too large', 413, 'Image too large.'],
        ['Unsupported or invalid image', 415, 'Unsupported image type. Use PNG, JPEG, WEBP, GIF, or AVIF.'],
    ])('storage "%s" → %i with a fixed message, not audited', async (thrown, status, message) => {
        h.uploadThrows = new Error(thrown);
        const res = await post();
        expect(res.statusCode).toBe(status);
        expect(res.body).toEqual({ message });
        expect(h.events).toEqual([]);
        expect(res.headers).toEqual({});
    });

    it('storage cap reached → 507 and an audit row naming only the feature', async () => {
        h.uploadThrows = new Error('Storage limit reached');
        const res = await post();
        expect(res.statusCode).toBe(507);
        expect(res.body).toEqual({ message: 'Storage limit reached. Remove some uploaded images to free space.' });
        expect(h.events).toEqual([{
            event: 'upload.storage_cap.denied', action: 'org:upload', actorUserId: 7, actorLabel: 'Uploader', actorIp: IP,
            details: { feature: 'branding' },
        }]);
    });

    it('any other storage failure → a generic 500 (no internal message leaks) and an error log', async () => {
        const boom = new Error('bucket org-media: permission denied for service key sk_live_xyz');
        h.uploadThrows = boom;
        const res = await post();
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Upload failed' });
        expect(JSON.stringify(res.body)).not.toContain('sk_live');
        expect(logs('error')).toEqual([{ msg: 'org media upload failed', fields: { err: boom } }]);
    });

    it('a non-Error throw is also a generic 500', async () => {
        h.uploadThrows = 'Image too large';
        const res = await post();
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Upload failed' });
    });

    it('a permission denial is logged with ids only', async () => {
        h.user = actor({ permissions: [] });
        const res = await post({ feature: 'branding' });
        expect(res.statusCode).toBe(403);
        expect(logs('warn')).toEqual([{ msg: 'upload permission denied', fields: { userId: 7, feature: 'branding' } }]);
        expect(h.events[0]).toMatchObject({ event: 'authz.permission.denied', actorIp: IP, details: { feature: 'branding' } });
    });

    it('a user record without a permissions array is denied, not crashed', async () => {
        h.user = actor({ permissions: 'admin:config:branding' });
        const res = await post({ feature: 'branding' });
        expect(res.statusCode).toBe(403);
        expect(h.uploads).toEqual([]);
    });

    it.each([
        ['missing', undefined],
        ['repeated (array)', ['branding', 'branding']],
        ['prototype key', '__proto__'],
    ])('a %s ?for= target → 404, not audited (only caller text to record), nothing stored', async (_label, feature) => {
        const res = await post({ feature });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ message: 'Unknown upload target' });
        expect(h.events).toEqual([]);
        expect(h.uploads).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('per-user throttle', () => {
    it('allows 30 per minute; the 31st is 429 with exact Retry-After, audited; the window resets at exactly 60s', async () => {
        for (let i = 0; i < 30; i++) expect((await post()).statusCode, `request ${i + 1}`).toBe(200);
        vi.setSystemTime(T0 + 45_500);
        const throttled = await post();
        expect(throttled.statusCode).toBe(429);
        expect(throttled.body).toEqual({ message: 'Too many uploads. Please slow down and try again shortly.' });
        // 14.5s left in the window → rounded UP to whole seconds.
        expect(throttled.headers).toEqual({ 'Retry-After': '15' });
        expect(h.events).toEqual([{
            event: 'upload.rate_limited', action: 'org:upload', actorUserId: 7, actorLabel: 'Uploader', actorIp: IP,
            details: { feature: 'branding' },
        }]);
        expect(h.uploads).toHaveLength(30);

        vi.setSystemTime(T0 + 59_500);
        expect((await post()).headers['Retry-After']).toBe('1'); // ceil(0.5s), never 0

        vi.setSystemTime(T0 + 59_999);
        expect((await post()).statusCode).toBe(429);
        vi.setSystemTime(T0 + 60_000);
        expect((await post()).statusCode).toBe(200);
        expect(h.uploads).toHaveLength(31);
    });

    it('the budget is per user: another account is unaffected', async () => {
        for (let i = 0; i < 31; i++) await post();
        expect((await post()).statusCode).toBe(429);
        token = signToken({ userId: 8 });
        h.user = actor({ id: 8 });
        expect((await post()).statusCode).toBe(200);
    });

    it('pruning drops only expired buckets and reports how many it removed', async () => {
        await post(); // user 7 bucket at T0
        vi.setSystemTime(T0 + 30_000);
        token = signToken({ userId: 8 });
        h.user = actor({ id: 8 });
        await post(); // user 8 bucket at T0+30s
        expect(pruneOrgUploadBuckets(T0 + 59_999)).toBe(0);
        expect(pruneOrgUploadBuckets(T0 + 60_000)).toBe(1);
        expect(pruneOrgUploadBuckets(T0 + 60_000)).toBe(0);
        expect(pruneOrgUploadBuckets(T0 + 90_000)).toBe(1);
    });

    it('at the 50,000-bucket memory cap NEW ids are shed (untracked) while tracked ids keep their limit', async () => {
        // Fill the map to the cap with distinct users; user 7 is among the first and is
        // pushed to its limit so it is tracked when the cap is hit.
        for (let i = 0; i < 30; i++) await post();
        for (let id = 100_000; id < 100_000 + 49_999; id++) {
            token = signToken({ userId: id });
            h.user = actor({ id });
            await post();
        }
        // A brand-new id past the cap is never tracked, so it is never throttled.
        token = signToken({ userId: 999_999 });
        h.user = actor({ id: 999_999 });
        for (let i = 0; i < 31; i++) expect((await post()).statusCode).toBe(200);
        // The already-tracked user is NOT evicted to make room: still throttled.
        token = signToken({ userId: 7 });
        h.user = actor();
        expect((await post()).statusCode).toBe(429);

        expect(pruneOrgUploadBuckets(T0 + 60_000)).toBe(50_000);
        // After pruning the new id is tracked normally again.
        vi.setSystemTime(T0 + 60_000);
        token = signToken({ userId: 999_999 });
        h.user = actor({ id: 999_999 });
        for (let i = 0; i < 30; i++) await post();
        expect((await post()).statusCode).toBe(429);
    }, 60_000);
});

// ---------------------------------------------------------------------------
describe('underivable optional-module namespace fails CLOSED', () => {
    it.each([
        ['a colon-less write action', 'nocolon'],
        ['a leading colon', ':update'],
        ['an empty write-action list', []],
    ])('%s → 500, audited, nothing stored, no feature read', async (_label, shape) => {
        h.writeActions.branding = shape as string | string[];
        const res = await post({ feature: 'branding' });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Upload failed' });
        expect(h.uploads).toEqual([]);
        expect(logs('error')).toEqual([{ msg: 'upload namespace underivable', fields: { userId: 7, feature: 'branding' } }]);
        expect(h.events).toEqual([{
            event: 'upload.namespace_underivable.denied', action: 'org:upload', actorUserId: 7, actorLabel: 'Uploader', actorIp: IP,
            details: { feature: 'branding' },
        }]);
    });
});
