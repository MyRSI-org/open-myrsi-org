// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/push.ts — Web-Push fan-out. Pinned here:
//   - endpoint allow-list (stored blind-SSRF guard) at send time, with the bad row deleted;
//   - VAPID initialisation from env, once per process, never logging the private key;
//   - the wire payload is exactly the caller's payload (static: one string reused; builder:
//     one per recipient from a single explicit-column profile read);
//   - dead subscriptions (404/410) are deleted, other send errors are logged, one failure
//     never blocks the rest of the batch;
//   - every recipient query is an explicit projection, removed members are filtered out, and
//     every read fault fails closed (no push), never open.

type Call = { method: string; args: unknown[] };
type Q = { table: string; calls: Call[] };

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) =>
        ({ data: [] as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown } | Promise<never>,
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
    logs: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            const q = { table, calls };
            h.queries.push(q);
            const r = h.resolveQuery(q);
            return r instanceof Promise ? r : Promise.resolve(r);
        };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});

vi.mock('web-push', () => ({
    default: { setVapidDetails: h.setVapidDetails, sendNotification: h.sendNotification },
}));

vi.mock('../lib/log', () => {
    const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const logger = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => logger };
    return { log: logger };
});

import {
    isAllowedPushEndpoint,
    sendPushToUsers,
    sendPushToRoles,
    sendPushToStaff,
    sendPushToCommand,
    sendPushToPermission,
    sendPushToAll,
    filterLiveRecipients,
    MAX_PUSH_SUBSCRIPTIONS_PER_USER,
    type PushPayload,
    type RecipientProfile,
} from '../lib/push';

const EP = (n: number | string) => `https://fcm.googleapis.com/fcm/send/tok-${n}`;
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const subRow = (id: string, userId: number, endpoint: string = EP(id)) => ({ id, user_id: userId, subscription: { endpoint, keys: KEYS } });
const PAYLOAD: PushPayload = { title: 'Op Thunder', body: 'Starts in 15m', tag: 'op-12', data: { opId: 12 } };

const sel = (q: Q) => q.calls.find(c => c.method === 'select')?.args[0];
const byTable = (t: string) => h.queries.filter(q => q.table === t);
const deletes = () => h.queries.filter(q => q.calls.some(c => c.method === 'delete'));
const sentEndpoints = () => h.sendNotification.mock.calls.map(c => (c[0] as { endpoint?: string }).endpoint);

/** Route reads by table: push_subscriptions rows, users rows, etc. */
const routes = (r: { subs?: unknown; users?: unknown; roles?: unknown; bindings?: unknown; profiles?: unknown }) => (q: Q) => {
    if (q.calls.some(c => c.method === 'delete')) return { data: null, error: null };
    if (q.table === 'push_subscriptions') return { data: r.subs ?? [], error: null };
    if (q.table === 'roles') return { data: r.roles ?? [], error: null };
    if (q.table === 'role_permissions') return { data: r.bindings ?? [], error: null };
    if (q.table === 'users') {
        if (sel(q) === 'id, timezone, date_format') return { data: r.profiles ?? [], error: null };
        return { data: r.users ?? [], error: null };
    }
    return { data: [], error: null };
};

/** Deep search of every recorded log record for a substring (incl. Error message/stack). */
const logsContain = (needle: string) => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
        if (typeof v === 'string') return v.includes(needle);
        if (v && typeof v === 'object') {
            if (seen.has(v)) return false;
            seen.add(v);
            if (v instanceof Error && (walk(v.message) || walk(v.stack))) return true;
            return Object.values(v as Record<string, unknown>).some(walk);
        }
        return false;
    };
    return h.logs.some(r => walk(r.msg) || walk(r.fields));
};

beforeEach(() => {
    h.queries = [];
    h.logs = [];
    h.resolveQuery = () => ({ data: [], error: null });
    h.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
    h.setVapidDetails.mockReset();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('isAllowedPushEndpoint', () => {
    it('accepts https endpoints on each vendor host family, apex or subdomain, any case', () => {
        for (const ok of [
            'https://fcm.googleapis.com/fcm/send/abc',
            'https://android.googleapis.com/gcm/send/abc',
            'https://googleapis.com/x',
            'https://updates.push.services.mozilla.com/wpush/v2/abc',
            'https://web.push.apple.com/QAbc',
            'https://wns2-by3p.notify.windows.com/w/?token=abc',
            'https://db5.push.windows.com/x',
            'https://FCM.GoogleAPIs.COM/fcm/send/abc',
            'https://fcm.googleapis.com:443/fcm/send/abc',
        ]) expect(isAllowedPushEndpoint(ok)).toBe(true);
    });

    it('rejects non-https, internal, look-alike and malformed endpoints', () => {
        for (const bad of [
            'http://fcm.googleapis.com/fcm/send/abc',
            'https://10.0.0.5/internal',
            'https://localhost/x',
            'https://evilgoogleapis.com/x',
            'https://fcm.googleapis.com.attacker.net/x',
            'https://mozilla.com/x',
            'https://attacker.net/?u=https://fcm.googleapis.com',
            'wss://fcm.googleapis.com/x',
            'not a url',
            '',
            undefined,
            null,
            42,
            { endpoint: 'https://fcm.googleapis.com/x' },
        ]) expect(isAllowedPushEndpoint(bad)).toBe(false);
    });

    it('caps per-user subscriptions at 20', () => {
        expect(MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBe(20);
    });
});

describe('VAPID initialisation (fresh module per test)', () => {
    const PRIV = 'vapid-private-key-must-never-be-logged-0123456789';
    const PUB = 'BPublicVapidKey-0123456789';
    const fresh = async () => {
        vi.resetModules();
        return import('../lib/push');
    };
    const oneSub = () => { h.resolveQuery = routes({ subs: [subRow('a', 1)] }); };

    it('signs with the configured subject and key pair, once per process', async () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', PUB);
        vi.stubEnv('VAPID_PRIVATE_KEY', PRIV);
        vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.org');
        oneSub();
        const push = await fresh();
        await push.sendPushToUsers([1], PAYLOAD);
        await push.sendPushToUsers([1], PAYLOAD);
        expect(h.setVapidDetails).toHaveBeenCalledTimes(1);
        expect(h.setVapidDetails).toHaveBeenCalledWith('mailto:ops@example.org', PUB, PRIV);
        expect(h.sendNotification).toHaveBeenCalledTimes(2);
        expect(logsContain(PRIV)).toBe(false);
    });

    it('defaults the subject when VAPID_SUBJECT is unset', async () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', PUB);
        vi.stubEnv('VAPID_PRIVATE_KEY', PRIV);
        vi.stubEnv('VAPID_SUBJECT', '');
        oneSub();
        await (await fresh()).sendPushToUsers([1], PAYLOAD);
        expect(h.setVapidDetails).toHaveBeenCalledWith('mailto:admin@example.com', PUB, PRIV);
    });

    it('never signs with a half-configured key pair, and warns without echoing the key', async () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', PUB);
        vi.stubEnv('VAPID_PRIVATE_KEY', '');
        oneSub();
        await (await fresh()).sendPushToUsers([1], PAYLOAD);
        expect(h.setVapidDetails).not.toHaveBeenCalled();
        expect(h.logs).toContainEqual({ level: 'warn', msg: 'vapid keys not configured, push notifications will fail', fields: undefined });
        vi.stubEnv('VAPID_PUBLIC_KEY', '');
        vi.stubEnv('VAPID_PRIVATE_KEY', PRIV);
        await (await fresh()).sendPushToUsers([1], PAYLOAD);
        expect(h.setVapidDetails).not.toHaveBeenCalled();
        expect(logsContain(PRIV)).toBe(false);
    });

    it('does not load web-push at all when there is nothing to send', async () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', PUB);
        vi.stubEnv('VAPID_PRIVATE_KEY', PRIV);
        h.resolveQuery = routes({ subs: [] });
        await (await fresh()).sendPushToUsers([1], PAYLOAD);
        expect(h.setVapidDetails).not.toHaveBeenCalled();
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('works with a web-push build that exposes named exports only (no default)', async () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', PUB);
        vi.stubEnv('VAPID_PRIVATE_KEY', PRIV);
        const named = { setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue({}) };
        vi.resetModules();
        vi.doMock('web-push', () => ({ default: undefined, ...named }));
        try {
            oneSub();
            const push = await import('../lib/push');
            await push.sendPushToUsers([1], PAYLOAD);
            expect(named.setVapidDetails).toHaveBeenCalledWith('mailto:admin@example.com', PUB, PRIV);
            expect(named.sendNotification).toHaveBeenCalledWith(subRow('a', 1).subscription, JSON.stringify(PAYLOAD));
        } finally {
            vi.doMock('web-push', () => ({ default: { setVapidDetails: h.setVapidDetails, sendNotification: h.sendNotification } }));
            vi.resetModules();
        }
    });
});

describe('sendBatch — what goes on the wire', () => {
    it('sends the caller payload verbatim (one stringify, reused) to every subscription', async () => {
        const stringify = vi.spyOn(JSON, 'stringify');
        h.resolveQuery = routes({ subs: [subRow('a', 1), subRow('b', 2), { id: 'c', user_id: 2, subscription: JSON.stringify({ endpoint: EP('c'), keys: KEYS }) }] });
        try {
            await sendPushToUsers([1, 2], PAYLOAD);
            expect(stringify.mock.calls.filter(c => c[0] === PAYLOAD)).toHaveLength(1);
        } finally {
            stringify.mockRestore();
        }
        expect(h.sendNotification.mock.calls).toEqual([
            [{ endpoint: EP('a'), keys: KEYS }, JSON.stringify(PAYLOAD)],
            [{ endpoint: EP('b'), keys: KEYS }, JSON.stringify(PAYLOAD)],
            // A subscription stored as a JSON string is parsed before sending.
            [{ endpoint: EP('c'), keys: KEYS }, JSON.stringify(PAYLOAD)],
        ]);
        // Static payloads need no per-recipient profile read.
        expect(byTable('users')).toHaveLength(0);
    });

    it('builds a per-recipient payload from ONE explicit-column profile read', async () => {
        h.resolveQuery = routes({
            subs: [subRow('a', 1), subRow('b', 2), subRow('c', 3), subRow('a2', 1)],
            profiles: [
                { id: 1, timezone: 'Asia/Tokyo', date_format: 'iso_24h' },
                { id: 2, timezone: null, date_format: undefined },
            ],
        });
        const builder = vi.fn((r: RecipientProfile): PushPayload => ({ title: 'Reminder', body: `${r.userId}|${r.timezone}|${r.dateFormat}` }));
        await sendPushToUsers([1, 2, 3], builder);

        const profileReads = byTable('users');
        expect(profileReads).toHaveLength(1);
        expect(profileReads[0].calls).toEqual([
            { method: 'select', args: ['id, timezone, date_format'] },
            { method: 'in', args: ['id', [1, 2, 3]] },
        ]);
        expect(builder).toHaveBeenCalledTimes(4);
        expect(h.sendNotification.mock.calls.map(c => c[1])).toEqual([
            JSON.stringify({ title: 'Reminder', body: '1|Asia/Tokyo|iso_24h' }),
            JSON.stringify({ title: 'Reminder', body: '2|null|null' }),
            // No profile row: defaults, never another user's prefs.
            JSON.stringify({ title: 'Reminder', body: '3|null|null' }),
            JSON.stringify({ title: 'Reminder', body: '1|Asia/Tokyo|iso_24h' }),
        ]);
    });

    it('a builder with a failed/empty profile read still sends with default prefs', async () => {
        h.resolveQuery = (q) => {
            if (q.table === 'push_subscriptions') return { data: [subRow('a', 5)], error: null };
            return { data: null, error: { message: 'profile read failed' } };
        };
        await sendPushToUsers([5], (r) => ({ title: 't', body: `${r.userId}:${r.timezone}:${r.dateFormat}` }));
        expect(h.sendNotification).toHaveBeenCalledWith(subRow('a', 5).subscription, JSON.stringify({ title: 't', body: '5:null:null' }));
    });
});

describe('sendBatch — endpoint gate and malformed rows', () => {
    it('drops AND deletes a stored disallowed endpoint, never POSTing to it', async () => {
        h.resolveQuery = routes({ subs: [subRow('bad', 1, 'https://10.0.0.5/internal'), subRow('good', 1)] });
        await sendPushToUsers([1], PAYLOAD);
        expect(sentEndpoints()).toEqual([EP('good')]);
        expect(deletes().map(q => ({ table: q.table, calls: q.calls }))).toEqual([
            { table: 'push_subscriptions', calls: [{ method: 'delete', args: [] }, { method: 'eq', args: ['id', 'bad'] }] },
        ]);
        expect(h.logs).toContainEqual({ level: 'warn', msg: 'skipping push subscription with disallowed endpoint host', fields: { subscriptionId: 'bad' } });
    });

    it('a subscription blob with no endpoint is judged on the row endpoint (never sent unless allowed)', async () => {
        h.resolveQuery = routes({
            subs: [
                { id: 'noep', user_id: 1, subscription: { keys: KEYS } },
                { id: 'rowep', user_id: 1, endpoint: EP('rowep'), subscription: { keys: KEYS } },
            ],
        });
        await sendPushToUsers([1], PAYLOAD);
        expect(h.sendNotification.mock.calls.map(c => c[0])).toEqual([{ keys: KEYS }]);
        expect(deletes().map(q => q.calls.find(c => c.method === 'eq')!.args)).toEqual([['id', 'noep']]);
    });

    it('skips a disallowed row without an id (nothing to delete) and swallows a failing delete', async () => {
        h.resolveQuery = (q) => {
            if (q.calls.some(c => c.method === 'delete')) return Promise.reject(new Error('delete failed'));
            return { data: [{ user_id: 1, subscription: { endpoint: 'http://insecure.example/x' } }, subRow('bad', 1, 'https://attacker.net/x'), subRow('ok', 1)], error: null };
        };
        await expect(sendPushToUsers([1], PAYLOAD)).resolves.toBeUndefined();
        expect(deletes().map(q => q.calls.find(c => c.method === 'eq')!.args)).toEqual([['id', 'bad']]);
        expect(sentEndpoints()).toEqual([EP('ok')]);
    });

    it('skips a malformed subscription without deleting it, and keeps sending the rest', async () => {
        h.resolveQuery = routes({ subs: [{ id: 'mal', user_id: 1, subscription: '{not json' }, subRow('ok', 1)] });
        await sendPushToUsers([1], PAYLOAD);
        expect(sentEndpoints()).toEqual([EP('ok')]);
        expect(deletes()).toHaveLength(0);
        const warn = h.logs.find(r => r.msg === 'skipping malformed push subscription')!;
        expect(warn.level).toBe('warn');
        expect(warn.fields!.subscriptionId).toBe('mal');
        expect(warn.fields!.err).toBeInstanceOf(SyntaxError);
    });
});

describe('sendBatch — delivery failures', () => {
    it.each([410, 404])('deletes a subscription the push service reports gone (%i)', async (statusCode) => {
        h.resolveQuery = routes({ subs: [subRow('dead', 1), subRow('live', 1)] });
        h.sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
            if (sub.endpoint === EP('dead')) throw Object.assign(new Error('Received unexpected response code'), { statusCode });
            return { statusCode: 201 };
        });
        await sendPushToUsers([1], PAYLOAD);
        expect(sentEndpoints()).toEqual([EP('dead'), EP('live')]);
        expect(deletes().map(q => ({ table: q.table, calls: q.calls }))).toEqual([
            { table: 'push_subscriptions', calls: [{ method: 'delete', args: [] }, { method: 'eq', args: ['id', 'dead'] }] },
        ]);
        expect(h.logs.filter(r => r.level === 'error')).toEqual([]);
    });

    it('logs (and keeps) a subscription on any other delivery error, without logging its keys', async () => {
        const failure = Object.assign(new Error('Received unexpected response code'), { statusCode: 500 });
        h.resolveQuery = routes({ subs: [subRow('flaky', 1), subRow('ok', 1)] });
        h.sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
            if (sub.endpoint === EP('flaky')) throw failure;
            return { statusCode: 201 };
        });
        await sendPushToUsers([1], PAYLOAD);
        expect(deletes()).toHaveLength(0);
        expect(h.logs).toContainEqual({ level: 'error', msg: 'push send failed', fields: { err: failure } });
        expect(logsContain(KEYS.p256dh)).toBe(false);
        expect(logsContain(KEYS.auth)).toBe(false);
        expect(sentEndpoints()).toEqual([EP('flaky'), EP('ok')]);
    });

    it('a failing cleanup delete after a 410 does not reject the fan-out', async () => {
        h.resolveQuery = (q) => {
            if (q.calls.some(c => c.method === 'delete')) return Promise.reject(new Error('delete failed'));
            return { data: [subRow('dead', 1)], error: null };
        };
        h.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
        await expect(sendPushToUsers([1], PAYLOAD)).resolves.toBeUndefined();
        expect(deletes()).toHaveLength(1);
    });
});

describe('sendPushToUsers — recipient query', () => {
    it('does nothing at all for an empty recipient list', async () => {
        await sendPushToUsers([], PAYLOAD);
        expect(h.queries).toHaveLength(0);
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('selects explicit columns, joins users and excludes soft-deleted members', async () => {
        h.resolveQuery = routes({ subs: [subRow('a', 1)] });
        await sendPushToUsers([1, 2], PAYLOAD);
        expect(byTable('push_subscriptions')[0].calls).toEqual([
            { method: 'select', args: ['id, user_id, subscription, user:users!inner(deleted_at)'] },
            { method: 'in', args: ['user_id', [1, 2]] },
            { method: 'is', args: ['user.deleted_at', null] },
        ]);
    });

    it('FAILS CLOSED on a lookup error: logs code/message only, sends nothing, reads no profiles', async () => {
        h.resolveQuery = () => ({ data: [subRow('a', 1)], error: { code: '08006', message: 'connection failure', details: 'host=db.internal' } });
        await sendPushToUsers([1], () => PAYLOAD);
        expect(h.sendNotification).not.toHaveBeenCalled();
        expect(byTable('users')).toHaveLength(0);
        expect(h.logs).toContainEqual({ level: 'error', msg: 'push subscription lookup failed', fields: { code: '08006', message: 'connection failure' } });
    });

    it('treats a null result without an error as no subscriptions', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await expect(sendPushToUsers([1], PAYLOAD)).resolves.toBeUndefined();
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('PGRST200 fallback: with no live recipients, stops before a second subscription read', async () => {
        h.resolveQuery = (q) => {
            if (q.table === 'users') return { data: [], error: null };
            return { data: null, error: { code: 'PGRST200', message: 'no relationship' } };
        };
        await sendPushToUsers([1, 2], PAYLOAD);
        expect(byTable('push_subscriptions')).toHaveLength(1);
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('PGRST200 fallback: a failing retry read is logged and sends nothing', async () => {
        let subReads = 0;
        h.resolveQuery = (q) => {
            if (q.table === 'users') return { data: [{ id: 1 }], error: null };
            subReads++;
            return subReads === 1
                ? { data: null, error: { code: 'PGRST200', message: 'no relationship' } }
                : { data: [subRow('a', 1)], error: { code: '57014', message: 'statement timeout' } };
        };
        await sendPushToUsers([1], PAYLOAD);
        const retry = byTable('push_subscriptions')[1];
        expect(retry.calls).toEqual([
            { method: 'select', args: ['id, user_id, subscription'] },
            { method: 'in', args: ['user_id', [1]] },
        ]);
        expect(h.sendNotification).not.toHaveBeenCalled();
        expect(h.logs).toContainEqual({ level: 'error', msg: 'push subscription lookup failed', fields: { code: '57014', message: 'statement timeout' } });
    });
});

describe('filterLiveRecipients', () => {
    it('keeps only live ids, in the caller order (duplicates preserved)', async () => {
        h.resolveQuery = () => ({ data: [{ id: 1 }, { id: 3 }], error: null });
        await expect(filterLiveRecipients([3, 2, 1, 3])).resolves.toEqual([3, 1, 3]);
        expect(byTable('users')[0].calls).toEqual([
            { method: 'select', args: ['id'] },
            { method: 'in', args: ['id', [3, 2, 1, 3]] },
            { method: 'is', args: ['deleted_at', null] },
        ]);
    });

    it('answers an empty list without querying', async () => {
        await expect(filterLiveRecipients([])).resolves.toEqual([]);
        expect(h.queries).toHaveLength(0);
    });

    it('a null result without an error means nobody is live', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await expect(filterLiveRecipients([1, 2])).resolves.toEqual([]);
    });

    it('FAILS CLOSED on a probe fault: null (not the input), logging code/message only', async () => {
        h.resolveQuery = () => ({ data: [{ id: 1 }], error: { code: '08006', message: 'connection failure', details: 'host=db.internal', hint: 'x' } });
        await expect(filterLiveRecipients([1])).resolves.toBeNull();
        expect(h.logs).toContainEqual({ level: 'error', msg: 'recipient liveness probe failed', fields: { code: '08006', message: 'connection failure' } });
    });

    it('PGRST200 fallback with a faulting probe sends nothing and makes no retry read', async () => {
        h.resolveQuery = (q) => {
            if (q.table === 'users') return { data: null, error: { code: '08006', message: 'connection failure' } };
            return { data: [subRow('a', 1)], error: { code: 'PGRST200', message: 'no relationship' } };
        };
        await sendPushToUsers([1], PAYLOAD);
        expect(byTable('push_subscriptions')).toHaveLength(1);
        expect(h.sendNotification).not.toHaveBeenCalled();
    });
});

describe('role / permission / org fan-out helpers', () => {
    it('sendPushToRoles resolves users by role id, then fans out to exactly those ids', async () => {
        h.resolveQuery = routes({ users: [{ id: 4 }, { id: 9 }], subs: [subRow('a', 4)] });
        await sendPushToRoles([2, 3], PAYLOAD);
        expect(byTable('users')[0].calls).toEqual([
            { method: 'select', args: ['id'] },
            { method: 'in', args: ['role_id', [2, 3]] },
        ]);
        expect(byTable('push_subscriptions')[0].calls).toContainEqual({ method: 'in', args: ['user_id', [4, 9]] });
        expect(sentEndpoints()).toEqual([EP('a')]);
    });

    it('sendPushToRoles stops when no user holds the roles (or the read returns nothing)', async () => {
        for (const users of [[], null]) {
            h.queries = [];
            h.resolveQuery = (q) => (q.table === 'users' ? { data: users, error: null } : { data: [subRow('a', 1)], error: null });
            await sendPushToRoles([2], PAYLOAD);
            expect(byTable('push_subscriptions')).toHaveLength(0);
        }
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('sendPushToStaff targets the Member, Dispatcher and Admin roles by name', async () => {
        h.resolveQuery = routes({ roles: [{ id: 1 }, { id: 2 }, { id: 3 }], users: [{ id: 10 }], subs: [subRow('a', 10)] });
        await sendPushToStaff(PAYLOAD);
        expect(byTable('roles')[0].calls).toEqual([
            { method: 'select', args: ['id'] },
            { method: 'in', args: ['name', ['Member', 'Dispatcher', 'Admin']] },
        ]);
        expect(byTable('users')[0].calls).toContainEqual({ method: 'in', args: ['role_id', [1, 2, 3]] });
        expect(sentEndpoints()).toEqual([EP('a')]);
    });

    it('sendPushToCommand targets only the Dispatcher and Admin roles', async () => {
        h.resolveQuery = routes({ roles: [{ id: 2 }, { id: 3 }], users: [{ id: 10 }], subs: [subRow('a', 10)] });
        await sendPushToCommand(PAYLOAD);
        expect(byTable('roles')[0].calls).toEqual([
            { method: 'select', args: ['id'] },
            { method: 'in', args: ['name', ['Dispatcher', 'Admin']] },
        ]);
        expect(byTable('users')[0].calls).toContainEqual({ method: 'in', args: ['role_id', [2, 3]] });
        expect(sentEndpoints()).toEqual([EP('a')]);
    });

    it.each([
        ['sendPushToStaff', sendPushToStaff],
        ['sendPushToCommand', sendPushToCommand],
    ] as const)('%s sends nothing when no role resolves (empty or failed read)', async (_n, fn) => {
        for (const roles of [[], null]) {
            h.queries = [];
            h.resolveQuery = (q) => (q.table === 'roles' ? { data: roles, error: null } : { data: [{ id: 1 }], error: null });
            await fn(PAYLOAD);
            expect(h.queries.map(q => q.table)).toEqual(['roles']);
        }
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('sendPushToPermission resolves roles holding the permission, de-duplicated, and only live users', async () => {
        h.resolveQuery = routes({
            bindings: [{ role_id: 5 }, { role_id: 7 }, { role_id: 5 }],
            users: [{ id: 21 }, { id: 22 }],
            subs: [subRow('a', 21)],
        });
        await sendPushToPermission('finance:approve', PAYLOAD);
        expect(byTable('role_permissions')[0].calls).toEqual([
            { method: 'select', args: ['role_id, permission:permissions!inner(name)'] },
            { method: 'eq', args: ['permission.name', 'finance:approve'] },
        ]);
        expect(byTable('users')[0].calls).toEqual([
            { method: 'select', args: ['id'] },
            { method: 'in', args: ['role_id', [5, 7]] },
            { method: 'is', args: ['deleted_at', null] },
        ]);
        expect(byTable('push_subscriptions')[0].calls).toContainEqual({ method: 'in', args: ['user_id', [21, 22]] });
        expect(sentEndpoints()).toEqual([EP('a')]);
    });

    it('sendPushToPermission sends nothing when no role holds it, or no live user holds the role', async () => {
        for (const bindings of [[], null]) {
            h.queries = [];
            h.resolveQuery = (q) => (q.table === 'role_permissions' ? { data: bindings, error: null } : { data: [{ id: 1 }], error: null });
            await sendPushToPermission('intel:view', PAYLOAD);
            expect(h.queries.map(q => q.table)).toEqual(['role_permissions']);
        }
        for (const users of [[], null]) {
            h.queries = [];
            h.resolveQuery = (q) => {
                if (q.table === 'role_permissions') return { data: [{ role_id: 1 }], error: null };
                if (q.table === 'users') return { data: users, error: null };
                return { data: [subRow('a', 1)], error: null };
            };
            await sendPushToPermission('intel:view', PAYLOAD);
            expect(h.queries.map(q => q.table)).toEqual(['role_permissions', 'users']);
        }
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('sendPushToAll targets every live user', async () => {
        h.resolveQuery = routes({ users: [{ id: 1 }, { id: 2 }], subs: [subRow('a', 1), subRow('b', 2)] });
        await sendPushToAll(PAYLOAD);
        expect(byTable('users')[0].calls).toEqual([
            { method: 'select', args: ['id'] },
            { method: 'is', args: ['deleted_at', null] },
        ]);
        expect(byTable('push_subscriptions')[0].calls).toContainEqual({ method: 'in', args: ['user_id', [1, 2]] });
        expect(sentEndpoints()).toEqual([EP('a'), EP('b')]);
    });

    it('sendPushToAll sends nothing when the user read is empty or fails', async () => {
        for (const users of [[], null]) {
            h.queries = [];
            h.resolveQuery = (q) => (q.table === 'users' ? { data: users, error: null } : { data: [subRow('a', 1)], error: null });
            await sendPushToAll(PAYLOAD);
            expect(h.queries.map(q => q.table)).toEqual(['users']);
        }
        expect(h.sendNotification).not.toHaveBeenCalled();
    });

    it('no fan-out query ever selects a wildcard', async () => {
        h.resolveQuery = routes({ roles: [{ id: 1 }], bindings: [{ role_id: 1 }], users: [{ id: 1 }], subs: [subRow('a', 1)], profiles: [{ id: 1, timezone: null, date_format: null }] });
        await sendPushToStaff(PAYLOAD);
        await sendPushToCommand(PAYLOAD);
        await sendPushToPermission('x', () => PAYLOAD);
        await sendPushToAll(PAYLOAD);
        const selects = h.queries.map(sel).filter((s): s is string => typeof s === 'string');
        expect(selects.length).toBeGreaterThan(8);
        for (const s of selects) expect(s).not.toMatch(/\*/);
    });
});
