// @vitest-environment node
//
// lib/radio.ts — LiveKit voice: per-user cost throttle, room resolution +
// authorization, token minting, the room-status read gate, ban eviction and the
// admin reboot. Complements tests/radioRoomAuthz.test.ts (which runs the REAL
// canUserSeeOpInList / assertUnitAccess against a row stub) by pinning, with those
// collaborators mocked, exactly:
//   - which supabase queries run (explicit columns, filters, order + cap) and which
//     are skipped (no round-trip on a malformed id or a manager bypass);
//   - the projection handed to the shared canUserSeeOpInList predicate;
//   - the denial contract (one message, reason only in the log-only fields);
//   - the LiveKit calls: credentials read only AFTER authorization, fail-closed when
//     any credential is missing, the exact grant (roomJoin on ONE server-derived
//     room), identity from the authenticated user, participant identities only when
//     the caller may see them, and the eviction's token-revocation cutoff.
// Op-voice LISTING stays ACTIVE-participant only (time_left IS NULL) — deliberate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface Row { [col: string]: unknown }
interface Query { table: string; select: string | null; calls: unknown[][]; terminal: string | null }

const h = vi.hoisted(() => {
    const state = {
        tables: {} as Record<string, Row[]>,
        queries: [] as Query[],
        errorFor: null as null | ((table: string) => { message: string } | null),
        nullDataFor: new Set<string>(),
        /** Tables whose reads ignore every filter (the DB hands back rows not asked for). */
        looseFor: new Set<string>(),
        secrets: {} as Record<string, string | null>,
        secretReads: [] as string[],
    };
    const lk = {
        clients: [] as unknown[][],
        created: [] as unknown[],
        createRoomError: undefined as unknown,
        tokens: [] as Array<{ key: string; secret: string; opts: Record<string, unknown>; grants: unknown[] }>,
        rooms: [] as Array<{ name: string; numParticipants?: number }>,
        listRoomsCalls: 0,
        listRoomsError: undefined as unknown,
        participants: {} as Record<string, Array<{ identity: string; name: string }>>,
        listParticipantsCalls: [] as string[],
        listParticipantsError: {} as Record<string, unknown>,
        removals: [] as Array<{ room: string; identity: string; opts: unknown }>,
        removeError: {} as Record<string, unknown>,
        deleted: [] as string[],
        deleteError: {} as Record<string, unknown>,
    };

    function makeBuilder(table: string) {
        const q: Query = { table, select: null, calls: [], terminal: null };
        state.queries.push(q);
        const eqs: Array<[string, unknown]> = [];
        const ins: Array<[string, unknown[]]> = [];
        const isNulls: Array<[string, unknown]> = [];
        const settle = () => (state.tables[table] || []).filter(r => state.looseFor.has(table) ||
            eqs.every(([c, v]) => String(r[c]) === String(v)) &&
            ins.every(([c, vs]) => vs.map(String).includes(String(r[c]))) &&
            isNulls.every(([c, v]) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)));
        const result = (single: boolean) => {
            const e = state.errorFor ? state.errorFor(table) : null;
            if (e) return { data: null, error: e };
            if (state.nullDataFor.has(table)) return { data: null, error: null };
            const rows = settle();
            return { data: single ? (rows[0] ?? null) : rows, error: null };
        };
        const b: any = {
            select: (cols: string) => { q.select = cols; return b; },
            eq: (c: string, v: unknown) => { q.calls.push(['eq', c, v]); eqs.push([c, v]); return b; },
            in: (c: string, v: unknown[]) => { q.calls.push(['in', c, v]); ins.push([c, v]); return b; },
            is: (c: string, v: unknown) => { q.calls.push(['is', c, v]); isNulls.push([c, v]); return b; },
            order: (c: string, o: unknown) => { q.calls.push(['order', c, o]); return b; },
            limit: (n: number) => { q.calls.push(['limit', n]); return b; },
            maybeSingle: async () => { q.terminal = 'maybeSingle'; return result(true); },
            single: async () => { q.terminal = 'single'; return result(true); },
            then: (res: any, rej: any) => { q.terminal = 'list'; return Promise.resolve(result(false)).then(res, rej); },
        };
        return b;
    }

    return {
        state,
        lk,
        supabaseStub: { from: (t: string) => makeBuilder(t) },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
        assertUnitAccess: vi.fn(),
        assertOpVisible: vi.fn(),
        canSee: vi.fn(),
    };
});

vi.mock('../lib/db/common', () => ({ supabase: h.supabaseStub }));
vi.mock('../lib/db/system', () => ({ assertUnitAccess: h.assertUnitAccess }));
vi.mock('../lib/db/ops', () => ({ assertOpVisibleToUser: h.assertOpVisible, canUserSeeOpInList: h.canSee }));
vi.mock('../lib/log', () => ({ log: { child: () => h.logger } }));
vi.mock('../lib/secrets', () => ({
    getOrgSecret: async (key: string) => { h.state.secretReads.push(key); return h.state.secrets[key] ?? null; },
}));
vi.mock('livekit-server-sdk', () => {
    class AccessToken {
        rec: { key: string; secret: string; opts: Record<string, unknown>; grants: unknown[] };
        constructor(key: string, secret: string, opts: Record<string, unknown>) {
            this.rec = { key, secret, opts, grants: [] };
            h.lk.tokens.push(this.rec);
        }
        addGrant(g: unknown) { this.rec.grants.push(g); }
        async toJwt() { return `jwt:${String(this.rec.opts.identity)}:${String((this.rec.grants[0] as { room?: string })?.room)}`; }
    }
    class RoomServiceClient {
        constructor(url: string, key: string, secret: string) { h.lk.clients.push([url, key, secret]); }
        async createRoom(opts: unknown) { h.lk.created.push(opts); if (h.lk.createRoomError !== undefined) throw h.lk.createRoomError; return {}; }
        async listRooms() { h.lk.listRoomsCalls++; if (h.lk.listRoomsError !== undefined) throw h.lk.listRoomsError; return h.lk.rooms; }
        async listParticipants(room: string) {
            h.lk.listParticipantsCalls.push(room);
            if (room in h.lk.listParticipantsError) throw h.lk.listParticipantsError[room];
            return h.lk.participants[room] ?? [];
        }
        async removeParticipant(room: string, identity: string, opts: unknown) {
            h.lk.removals.push({ room, identity, opts });
            if (room in h.lk.removeError) throw h.lk.removeError[room];
        }
        async deleteRoom(name: string) { h.lk.deleted.push(name); if (name in h.lk.deleteError) throw h.lk.deleteError[name]; }
    }
    return { AccessToken, RoomServiceClient };
});

import {
    checkRadioRateLimit, assertRadioRateLimit, pruneRadioRateLimitBuckets, _resetRadioRateLimit,
    resolveAndAuthorizeRadioRoom, generateRadioToken, generateOpRadioToken, visibleRadioRoomNames,
    getRadioStatus, evictUserFromAllRooms, rebootRadioNetwork, type RadioUser,
} from '../lib/radio';
import { SecurityDenial } from '../lib/errors';

const CREDS = { LIVEKIT_API_KEY: 'lk-key', LIVEKIT_API_SECRET: 'lk-secret', LIVEKIT_URL: 'wss://lk.example' };
const SECRET_KEYS = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL'];
const DENY_MSG = 'You are not authorized to join this radio channel.';

const caller = (over: Partial<RadioUser> = {}): RadioUser => ({ id: 5, name: 'Caller', permissions: ['operations:view'], ...over });

beforeEach(() => {
    h.state.tables = {};
    h.state.queries = [];
    h.state.errorFor = null;
    h.state.nullDataFor = new Set();
    h.state.looseFor = new Set();
    h.state.secrets = { ...CREDS };
    h.state.secretReads = [];
    Object.assign(h.lk, {
        clients: [], created: [], createRoomError: undefined, tokens: [], rooms: [], listRoomsCalls: 0,
        listRoomsError: undefined, participants: {}, listParticipantsCalls: [], listParticipantsError: {},
        removals: [], removeError: {}, deleted: [], deleteError: {},
    });
    for (const fn of Object.values(h.logger)) fn.mockReset();
    h.assertUnitAccess.mockReset().mockResolvedValue(undefined);
    h.assertOpVisible.mockReset().mockResolvedValue(undefined);
    h.canSee.mockReset().mockReturnValue(true);
    _resetRadioRateLimit();
});

afterEach(() => {
    vi.useRealTimers();
    _resetRadioRateLimit();
});

async function denial(p: Promise<unknown>): Promise<SecurityDenial> {
    try { await p; } catch (e) { return e as SecurityDenial; }
    throw new Error('expected the call to be denied');
}

function expectDenied(e: SecurityDenial, channelId: string, reason: string) {
    expect(e).toBeInstanceOf(SecurityDenial);
    expect(e.message).toBe(DENY_MSG);
    expect(e.auditEvent).toBe('authz.radio.denied');
    expect(e.status).toBe(403);
    expect(e.fields).toEqual({ channelId, reason });
}

const tablesQueried = () => h.state.queries.map(q => q.table);

// ─────────────────────────────────────────────────────────────────────────────
describe('per-user radio rate limit', () => {
    const T0 = 1_700_000_000_000;
    const MIN = 60_000;
    const DAY = 86_400_000;

    it('reports minute and day scopes with the exact seconds to reset', () => {
        for (let i = 0; i < 20; i++) expect(checkRadioRateLimit(1, T0).ok).toBe(true);
        expect(checkRadioRateLimit(1, T0 + 20_500)).toEqual({ ok: false, retryAfter: 40, scope: 'minute' });
        let t = T0 + MIN;
        for (let w = 1; w < 25; w++, t += MIN) for (let i = 0; i < 20; i++) checkRadioRateLimit(1, t);
        expect(checkRadioRateLimit(1, t)).toEqual({ ok: false, retryAfter: Math.ceil((T0 + DAY - t) / 1000), scope: 'day' });
    });

    it('resets the day window after 24h', () => {
        let t = T0;
        for (let w = 0; w < 25; w++, t += MIN) for (let i = 0; i < 20; i++) checkRadioRateLimit(1, t);
        expect(checkRadioRateLimit(1, t).scope).toBe('day');
        expect(checkRadioRateLimit(1, T0 + DAY)).toEqual({ ok: true, retryAfter: 0 });
    });

    it('sheds a NEW id once 10 000 buckets exist; a tracked id stays capped', () => {
        for (let i = 0; i < 20; i++) checkRadioRateLimit('tracked', T0);
        for (let i = 1; i < 10_000; i++) checkRadioRateLimit(`spray-${i}`, T0);
        for (let i = 0; i < 25; i++) expect(checkRadioRateLimit('newcomer', T0)).toEqual({ ok: true, retryAfter: 0 });
        expect(checkRadioRateLimit('tracked', T0).ok).toBe(false);
        expect(pruneRadioRateLimitBuckets(T0 + DAY)).toBe(10_000);
    });

    it('assertRadioRateLimit throws a RADIO_RATE_LIMITED error naming scope and delay', () => {
        for (let i = 0; i < 20; i++) expect(() => assertRadioRateLimit(2, T0)).not.toThrow();
        let caught: (Error & { code?: string }) | undefined;
        try { assertRadioRateLimit(2, T0 + 1000); } catch (e) { caught = e as Error & { code?: string }; }
        expect(caught?.message).toBe('Radio request limit reached (per minute). Try again in 59s.');
        expect(caught?.code).toBe('RADIO_RATE_LIMITED');
    });

    it('defaults `now` to Date.now() in check / assert / prune', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        for (let i = 0; i < 20; i++) checkRadioRateLimit(3);
        expect(() => assertRadioRateLimit(3)).toThrow('(per minute). Try again in 60s.');
        expect(pruneRadioRateLimitBuckets()).toBe(0);
        vi.setSystemTime(T0 + DAY);
        expect(pruneRadioRateLimitBuckets()).toBe(1);
    });

    it.each([undefined, null, ''])('fails open for the missing id %j without creating a bucket', (id) => {
        for (let i = 0; i < 30; i++) expect(checkRadioRateLimit(id, T0)).toEqual({ ok: true, retryAfter: 0 });
        expect(pruneRadioRateLimitBuckets(T0 + DAY)).toBe(0);
    });

    it('prune keeps a bucket whose minute window is still open', () => {
        checkRadioRateLimit('a', T0);
        checkRadioRateLimit('b', T0);
        checkRadioRateLimit('b', T0 + DAY - 10); // reopens b's minute window
        expect(pruneRadioRateLimitBuckets(T0 + DAY)).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveAndAuthorizeRadioRoom — shape checks never touch the DB', () => {
    it.each([42, null, undefined, { room: 'radio-x' }])('denies the non-string room %j as malformed', async (room) => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), room as unknown as string)), String(room), 'malformed_room');
        expect(h.state.queries).toEqual([]);
    });

    it.each(['dispatch', 'Radio-dispatch', 'op-radio-x'])('denies %j (no radio- prefix) as malformed', async (room) => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), room)), room, 'malformed_room');
        expect(h.state.queries).toEqual([]);
    });

    it('denies a bare prefix as an empty channel', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-')), 'radio-', 'empty_channel');
        expect(h.state.queries).toEqual([]);
    });

    it.each(['unit-', 'unit-abc', 'unit-0', 'unit--3', 'unit-1.5'])('denies squad id %j as bad_unit_id with no lookup', async (ch) => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), `radio-${ch}`)), ch, 'bad_unit_id');
        expect(h.state.queries).toEqual([]);
    });

    it('denies an empty mission id as bad_request_id with no lookup', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-')), 'req-', 'bad_request_id');
        expect(h.state.queries).toEqual([]);
    });
});

describe('resolveAndAuthorizeRadioRoom — squad net', () => {
    beforeEach(() => { h.state.tables.units = [{ id: 7, has_radio_channel: true }]; });

    it('reads only id + has_radio_channel for the parsed unit id, then checks unit access for (unit, caller)', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7')).resolves.toBe('radio-unit-7');
        expect(h.state.queries).toEqual([
            { table: 'units', select: 'id, has_radio_channel', calls: [['eq', 'id', 7]], terminal: 'maybeSingle' },
        ]);
        expect(h.assertUnitAccess).toHaveBeenCalledWith(7, 5);
    });

    it('compares a string user id / unit id numerically', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: '5', unit: { id: '7' as unknown as number } }), 'radio-unit-7'))
            .resolves.toBe('radio-unit-7');
        expect(h.assertUnitAccess).toHaveBeenCalledWith(7, 5);
    });

    it('treats a NULL has_radio_channel as enabled (only an explicit false disables)', async () => {
        h.state.tables.units = [{ id: 7, has_radio_channel: null }];
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7')).resolves.toBe('radio-unit-7');
    });

    it('denies a missing unit as unit_not_found', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 8 } }), 'radio-unit-8')), 'unit-8', 'unit_not_found');
    });

    it('denies a failed unit read as unit_query_failed', async () => {
        h.state.errorFor = () => ({ message: 'boom' });
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7')), 'unit-7', 'unit_query_failed');
    });

    it('denies a caller with no unit (undefined unit is not unit 0 or a wildcard)', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ unit: undefined }), 'radio-unit-7')), 'unit-7', 'not_own_unit');
        expect(h.assertUnitAccess).not.toHaveBeenCalled();
    });

    it('denies a non-member BEFORE the unit-access backstop runs', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 9 } }), 'radio-unit-7')), 'unit-7', 'not_own_unit');
        expect(h.assertUnitAccess).not.toHaveBeenCalled();
    });

    it('propagates the unit-access denial for a member of a restricted unit', async () => {
        const boom = new SecurityDenial('restricted', { auditEvent: 'authz.unit.denied' });
        h.assertUnitAccess.mockRejectedValueOnce(boom);
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7')).rejects.toBe(boom);
    });

    it.each([['radio:manage'], ['admin:access']])('%s bypasses membership AND the unit-access check', async (perm) => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: [perm], unit: null }), 'radio-unit-7')).resolves.toBe('radio-unit-7');
        expect(h.assertUnitAccess).not.toHaveBeenCalled();
    });

    it('a manager still cannot reach a unit whose radio is switched off', async () => {
        h.state.tables.units = [{ id: 7, has_radio_channel: false }];
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ permissions: ['radio:manage'] }), 'radio-unit-7')), 'unit-7', 'unit_radio_disabled');
    });
});

describe('resolveAndAuthorizeRadioRoom — mission net', () => {
    beforeEach(() => {
        h.state.tables.service_requests = [{ id: 'REQ-1', client_id: 5, lead_responder_id: 6 }];
        h.state.tables.request_responders = [{ request_id: 'REQ-1', user_id: 8 }];
    });

    it('the request client is admitted on the request read alone (no responder query)', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: [] }), 'radio-req-REQ-1')).resolves.toBe('radio-req-REQ-1');
        expect(h.state.queries).toEqual([
            { table: 'service_requests', select: 'id, client_id, lead_responder_id', calls: [['eq', 'id', 'REQ-1']], terminal: 'maybeSingle' },
        ]);
    });

    it('the lead responder is admitted without a responder query', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: 6 }), 'radio-req-REQ-1')).resolves.toBe('radio-req-REQ-1');
        expect(tablesQueried()).toEqual(['service_requests']);
    });

    it('an assigned responder is admitted via a request+user scoped responder read', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: 8 }), 'radio-req-REQ-1')).resolves.toBe('radio-req-REQ-1');
        expect(h.state.queries[1]).toEqual({
            table: 'request_responders', select: 'user_id', calls: [['eq', 'request_id', 'REQ-1'], ['eq', 'user_id', 8]], terminal: 'maybeSingle',
        });
    });

    it('a non-party is denied as not_request_party', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ id: 99 }), 'radio-req-REQ-1')), 'req-REQ-1', 'not_request_party');
    });

    it('denies a failed request read and a failed responder read distinctly', async () => {
        h.state.errorFor = (t) => (t === 'service_requests' ? { message: 'x' } : null);
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1')), 'req-REQ-1', 'request_query_failed');
        h.state.errorFor = (t) => (t === 'request_responders' ? { message: 'x' } : null);
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ id: 8 }), 'radio-req-REQ-1')), 'req-REQ-1', 'responder_query_failed');
    });

    it('denies an unknown request as request_not_found', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-NOPE')), 'req-NOPE', 'request_not_found');
    });

    it('stamps the CANONICAL DB id into the room name, never the client-supplied string', async () => {
        // Model a lookup that matches under a looser comparison than byte equality (a
        // case-insensitive collation, say): the room must still be named from the row,
        // so two spellings of one request cannot fork two rooms on a metered service.
        h.state.looseFor.add('service_requests');
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: 5, permissions: [] }), 'radio-req-req-1')).resolves.toBe('radio-req-REQ-1');
    });

    it('a manager joins an existing mission net without the party check, named from the DB id', async () => {
        h.state.tables.service_requests = [{ id: 42, client_id: 1, lead_responder_id: null }];
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: 99, permissions: ['radio:manage'] }), 'radio-req-42')).resolves.toBe('radio-req-42');
        expect(tablesQueried()).toEqual(['service_requests']);
    });
});

describe('resolveAndAuthorizeRadioRoom — base net', () => {
    beforeEach(() => {
        h.state.tables.radio_channels = [{ id: 'dispatch' }];
        h.state.tables.units = [];
    });

    it('reads the channel by id, then EVERY unit linked to it (id + is_restricted, list read)', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch')).resolves.toBe('radio-dispatch');
        expect(h.state.queries).toEqual([
            { table: 'radio_channels', select: 'id', calls: [['eq', 'id', 'dispatch']], terminal: 'maybeSingle' },
            { table: 'units', select: 'id, is_restricted', calls: [['eq', 'linked_channel_id', 'dispatch']], terminal: 'list' },
        ]);
    });

    it('denies an unknown channel and a failed channel read', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-nope')), 'nope', 'unknown_channel');
        h.state.errorFor = (t) => (t === 'radio_channels' ? { message: 'x' } : null);
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch')), 'dispatch', 'channel_query_failed');
    });

    it('denies a caller with no staff permission before the linked-unit read', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ permissions: ['request:create'] }), 'radio-dispatch')), 'dispatch', 'base_channel_client');
        expect(tablesQueried()).toEqual(['radio_channels']);
    });

    it('treats a non-array permissions value as no permissions', async () => {
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller({ permissions: undefined }), 'radio-dispatch')), 'dispatch', 'base_channel_client');
    });

    it('checks unit access for each RESTRICTED linked unit only, in order', async () => {
        h.state.tables.units = [
            { id: 1, is_restricted: true, linked_channel_id: 'dispatch' },
            { id: 2, is_restricted: false, linked_channel_id: 'dispatch' },
            { id: 3, is_restricted: true, linked_channel_id: 'dispatch' },
            { id: 4, is_restricted: true, linked_channel_id: 'other' },
        ];
        await resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch');
        expect(h.assertUnitAccess.mock.calls).toEqual([[1, 5], [3, 5]]);
    });

    it('a radio manager is STILL held to the restricted-unit check on a base channel', async () => {
        h.state.tables.units = [{ id: 1, is_restricted: true, linked_channel_id: 'dispatch' }];
        const boom = new SecurityDenial('restricted');
        h.assertUnitAccess.mockRejectedValueOnce(boom);
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: ['radio:manage'] }), 'radio-dispatch')).rejects.toBe(boom);
    });

    it('a null linked-unit result (no error) admits the caller', async () => {
        h.state.nullDataFor.add('units');
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch')).resolves.toBe('radio-dispatch');
        expect(h.assertUnitAccess).not.toHaveBeenCalled();
    });

    it('denies when the linked-unit read fails (fail closed, not an empty exclusion set)', async () => {
        h.state.errorFor = (t) => (t === 'units' ? { message: 'x' } : null);
        expectDenied(await denial(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch')), 'dispatch', 'linked_units_query_failed');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('generateRadioToken', () => {
    beforeEach(() => { h.state.tables.radio_channels = [{ id: 'dispatch' }]; h.state.tables.units = []; });

    it('mints a 6h join token for exactly the server-derived room, identity from the authenticated user', async () => {
        const out = await generateRadioToken(caller(), 'radio-dispatch');
        expect(out).toEqual({ token: 'jwt:5:radio-dispatch', url: 'wss://lk.example' });
        expect(h.state.secretReads).toEqual(SECRET_KEYS);
        expect(h.lk.clients).toEqual([['wss://lk.example', 'lk-key', 'lk-secret']]);
        expect(h.lk.created).toEqual([{ name: 'radio-dispatch', emptyTimeout: 300, departureTimeout: 30 }]);
        expect(h.lk.tokens).toEqual([{
            key: 'lk-key', secret: 'lk-secret',
            opts: { identity: '5', name: 'Caller', ttl: '6h' },
            grants: [{ roomJoin: true, room: 'radio-dispatch' }],
        }]);
        expect(JSON.stringify(out)).not.toContain('lk-secret');
    });

    it('falls back to the id as display name', async () => {
        await generateRadioToken(caller({ name: undefined }), 'radio-dispatch');
        expect(h.lk.tokens[0].opts).toEqual({ identity: '5', name: '5', ttl: '6h' });
    });

    it('authorizes BEFORE reading any LiveKit credential', async () => {
        await denial(generateRadioToken(caller({ permissions: [] }), 'radio-dispatch'));
        expect(h.state.secretReads).toEqual([]);
        expect(h.lk.clients).toEqual([]);
        expect(h.lk.tokens).toEqual([]);
    });

    it.each(SECRET_KEYS)('fails closed when %s is missing — no room, no token', async (key) => {
        h.state.secrets[key] = null;
        await expect(generateRadioToken(caller(), 'radio-dispatch')).rejects.toThrow('Radio configuration missing');
        expect(h.lk.clients).toEqual([]);
        expect(h.lk.tokens).toEqual([]);
    });

    it('still mints the token when the best-effort room pre-create fails, and logs it', async () => {
        const err = new Error('livekit 503');
        h.lk.createRoomError = err;
        await expect(generateRadioToken(caller(), 'radio-dispatch')).resolves.toEqual({ token: 'jwt:5:radio-dispatch', url: 'wss://lk.example' });
        expect(h.logger.warn).toHaveBeenCalledWith('room pre-create failed', { room: 'radio-dispatch', err });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('generateOpRadioToken', () => {
    beforeEach(() => { h.state.tables.operations = [{ id: 'op-1', owner_id: 9 }]; });

    it('loads only id + owner_id for the op', async () => {
        await generateOpRadioToken(caller(), 'op-1');
        expect(h.state.queries).toEqual([
            { table: 'operations', select: 'id, owner_id', calls: [['eq', 'id', 'op-1']], terminal: 'single' },
        ]);
    });

    it('an operations:view holder must clear assertOpVisibleToUser (called with the op id and the SAME user)', async () => {
        const user = caller();
        await expect(generateOpRadioToken(user, 'op-1')).resolves.toEqual({
            token: 'jwt:5:op-radio-op-1', url: 'wss://lk.example', roomName: 'op-radio-op-1',
        });
        expect(h.assertOpVisible).toHaveBeenCalledTimes(1);
        expect(h.assertOpVisible.mock.calls[0][0]).toBe('op-1');
        expect(h.assertOpVisible.mock.calls[0][1]).toBe(user);
        expect(h.lk.created).toEqual([{ name: 'op-radio-op-1', emptyTimeout: 300, departureTimeout: 30 }]);
        expect(h.lk.tokens).toEqual([{
            key: 'lk-key', secret: 'lk-secret',
            opts: { identity: '5', name: 'Caller', ttl: '6h' },
            grants: [{ roomJoin: true, room: 'op-radio-op-1' }],
        }]);
    });

    it('a clearance / marker denial propagates and nothing is minted or read', async () => {
        const boom = new SecurityDenial('not visible');
        h.assertOpVisible.mockRejectedValueOnce(boom);
        await expect(generateOpRadioToken(caller(), 'op-1')).rejects.toBe(boom);
        expect(h.state.secretReads).toEqual([]);
        expect(h.lk.tokens).toEqual([]);
    });

    it('the op owner bypasses the view + visibility checks', async () => {
        await expect(generateOpRadioToken(caller({ id: 9, permissions: [] }), 'op-1')).resolves.toMatchObject({ roomName: 'op-radio-op-1' });
        expect(h.assertOpVisible).not.toHaveBeenCalled();
    });

    it('operations:manage bypasses the view + visibility checks', async () => {
        await expect(generateOpRadioToken(caller({ permissions: ['operations:manage'] }), 'op-1')).resolves.toMatchObject({ roomName: 'op-radio-op-1' });
        expect(h.assertOpVisible).not.toHaveBeenCalled();
    });

    it.each([
        ['radio:manage only', { permissions: ['radio:manage'] }],
        ['a forged Admin role name with no perms', { permissions: [], role: 'Admin' }],
        ['no permissions array', { permissions: undefined }],
    ])('refuses %s without operations:view, before any visibility or credential read', async (_label, over) => {
        await expect(generateOpRadioToken(caller(over as Partial<RadioUser>), 'op-1'))
            .rejects.toThrow('Insufficient clearance to join this operation channel.');
        expect(h.assertOpVisible).not.toHaveBeenCalled();
        expect(h.state.secretReads).toEqual([]);
    });

    it('refuses an op that does not exist or whose read fails, before any credential read', async () => {
        await expect(generateOpRadioToken(caller(), 'op-missing')).rejects.toThrow('Operation not found');
        h.state.errorFor = () => ({ message: 'boom' });
        await expect(generateOpRadioToken(caller(), 'op-1')).rejects.toThrow('Operation not found');
        expect(h.assertOpVisible).not.toHaveBeenCalled();
        expect(h.state.secretReads).toEqual([]);
    });

    it.each(SECRET_KEYS)('fails closed when %s is missing (after authorization)', async (key) => {
        h.state.secrets[key] = null;
        await expect(generateOpRadioToken(caller(), 'op-1')).rejects.toThrow('Radio configuration missing');
        expect(h.assertOpVisible).toHaveBeenCalledTimes(1);
        expect(h.lk.tokens).toEqual([]);
    });

    it('mints despite a failed pre-create (logged) and falls back to the id as name', async () => {
        const err = new Error('503');
        h.lk.createRoomError = err;
        await expect(generateOpRadioToken(caller({ name: '' }), 'op-1')).resolves.toMatchObject({ token: 'jwt:5:op-radio-op-1' });
        expect(h.lk.tokens[0].opts).toEqual({ identity: '5', name: '5', ttl: '6h' });
        expect(h.logger.warn).toHaveBeenCalledWith('room pre-create failed', { room: 'op-radio-op-1', err });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('visibleRadioRoomNames', () => {
    const names = async (viewer: RadioUser | null | undefined, rooms: string[]) => [...await visibleRadioRoomNames(viewer, rooms)];

    it('a radio manager sees every radio-* room with ZERO queries', async () => {
        expect(await names(caller({ permissions: ['radio:manage'] }), ['radio-dispatch', 'radio-unit-3', 'radio-req-R'])).toEqual(['radio-dispatch', 'radio-unit-3', 'radio-req-R']);
        expect(h.state.queries).toEqual([]);
    });

    it.each([null, undefined])('no viewer (%j) sees nothing and triggers no query', async (viewer) => {
        expect(await names(viewer, ['radio-dispatch', 'radio-req-R', 'op-radio-op1'])).toEqual([]);
        expect(h.state.queries).toEqual([]);
    });

    it('drops an unrecognised room class', async () => {
        expect(await names(caller({ permissions: ['radio:manage', 'admin:access'] }), ['egress-1', 'RADIO-x'])).toEqual([]);
    });

    it('squad rooms: only the viewer\'s own unit, matched numerically; a unit-less viewer never sees unit-0', async () => {
        expect(await names(caller({ unit: { id: '7' as unknown as number } }), ['radio-unit-7', 'radio-unit-8', 'radio-unit-x'])).toEqual(['radio-unit-7']);
        expect(await names(caller({ unit: null }), ['radio-unit-0'])).toEqual([]);
    });

    it('base rooms: staff only; non-array permissions count as none', async () => {
        expect(await names(caller(), ['radio-dispatch'])).toEqual(['radio-dispatch']);
        expect(await names(caller({ permissions: ['request:create'] }), ['radio-dispatch'])).toEqual([]);
        expect(await names(caller({ permissions: undefined }), ['radio-dispatch'])).toEqual([]);
    });

    describe('op-voice rooms', () => {
        beforeEach(() => {
            h.state.tables.operations = [
                { id: 'op1', owner_id: 9, clearance_level: 2, is_special: true, limiting_markers: [{ marker: { id: 1, name: 'N', code: 'C' } }, { marker: null }, {}] },
                { id: 'op2', owner_id: null, clearance_level: null, is_special: null },
            ];
            h.state.tables.operation_participants = [
                { operation_id: 'op1', user_id: 5, time_left: null },
                { operation_id: 'op2', user_id: 5, time_left: '2026-01-01T00:00:00Z' },
            ];
        });

        it('reads the ops and ONLY the viewer\'s own ACTIVE participation, ordered and capped at the room count', async () => {
            await names(caller(), ['op-radio-op1', 'op-radio-op2']);
            expect(h.state.queries).toEqual([
                {
                    table: 'operations',
                    select: 'id, owner_id, clearance_level, is_special, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code))',
                    calls: [['in', 'id', ['op1', 'op2']], ['order', 'id', { ascending: true }], ['limit', 2]],
                    terminal: 'list',
                },
                {
                    table: 'operation_participants',
                    select: 'operation_id',
                    calls: [
                        ['eq', 'user_id', 5], ['is', 'time_left', null], ['in', 'operation_id', ['op1', 'op2']],
                        ['order', 'operation_id', { ascending: true }], ['order', 'user_id', { ascending: true }], ['limit', 2],
                    ],
                    terminal: 'list',
                },
            ]);
        });

        it('hands canUserSeeOpInList the viewer and a narrowed projection (null clearance → 0, empty markers dropped)', async () => {
            const viewer = caller();
            await names(viewer, ['op-radio-op1', 'op-radio-op2']);
            expect(h.canSee).toHaveBeenCalledTimes(2);
            expect(h.canSee.mock.calls[0][0]).toBe(viewer);
            expect(h.canSee.mock.calls[0][1]).toEqual({
                clearanceLevel: 2, ownerId: 9, limitingMarkers: [{ id: 1, name: 'N', code: 'C' }], isSpecial: true,
                participants: [{ userId: 5, timeLeft: null }],
            });
            // op2: the viewer DEPARTED, so no participation is claimed for them.
            expect(h.canSee.mock.calls[1][1]).toEqual({ clearanceLevel: 0, ownerId: null, limitingMarkers: [], isSpecial: false, participants: [] });
        });

        it('lists exactly the ops the predicate admits', async () => {
            h.canSee.mockImplementation((_v: unknown, op: { ownerId: number | null }) => op.ownerId === 9);
            expect(await names(caller(), ['op-radio-op1', 'op-radio-op2'])).toEqual(['op-radio-op1']);
        });

        it('skips an op row whose id does not map back to a requested room (never admits it)', async () => {
            // e.g. Postgres canonicalising a UUID's case: the row comes back, but under an
            // id no requested room name carries — it must be dropped, not evaluated.
            h.state.looseFor.add('operations');
            expect(await names(caller(), ['op-radio-op1'])).toEqual(['op-radio-op1']);
            expect(h.canSee).toHaveBeenCalledTimes(1);
            expect(h.canSee.mock.calls[0][1]).toMatchObject({ ownerId: 9 });
        });

        it.each([['operations:manage'], ['admin:access']])('%s may list ops too', async (perm) => {
            expect(await names(caller({ permissions: [perm] }), ['op-radio-op1'])).toEqual(['op-radio-op1']);
        });

        it('a viewer without an ops read permission triggers no op query and sees no op room', async () => {
            expect(await names(caller({ permissions: ['intel:view'] }), ['op-radio-op1'])).toEqual([]);
            expect(h.state.queries).toEqual([]);
            expect(h.canSee).not.toHaveBeenCalled();
        });

        it('a bare op-radio- prefix and a non-numeric viewer id trigger no query', async () => {
            expect(await names(caller(), ['op-radio-'])).toEqual([]);
            expect(await names(caller({ id: 'abc' }), ['op-radio-op1', 'radio-req-R'])).toEqual([]);
            expect(h.state.queries).toEqual([]);
        });

        it.each(['operations', 'operation_participants'])('a failed %s read drops every op room and logs that error', async (table) => {
            const err = { message: `${table} down` };
            h.state.errorFor = (t) => (t === table ? err : null);
            expect(await names(caller(), ['op-radio-op1', 'radio-dispatch'])).toEqual(['radio-dispatch']);
            expect(h.canSee).not.toHaveBeenCalled();
            expect(h.logger.warn).toHaveBeenCalledWith('radio status op filter query failed — dropping op rooms', { err });
        });

        it('null data from both reads lists no op room and does not throw', async () => {
            h.state.nullDataFor = new Set(['operations', 'operation_participants']);
            expect(await names(caller(), ['op-radio-op1'])).toEqual([]);
            expect(h.canSee).not.toHaveBeenCalled();
        });

        it('null participation data claims no participation', async () => {
            h.state.nullDataFor = new Set(['operation_participants']);
            await names(caller(), ['op-radio-op1']);
            expect(h.canSee.mock.calls[0][1]).toMatchObject({ participants: [] });
        });
    });

    describe('mission rooms', () => {
        beforeEach(() => {
            h.state.tables.service_requests = [
                { id: 'R1', client_id: 5, lead_responder_id: null },
                { id: 'R2', client_id: 1, lead_responder_id: 5 },
                { id: 'R3', client_id: 1, lead_responder_id: 2 },
                { id: 'R4', client_id: 1, lead_responder_id: 2 },
            ];
            h.state.tables.request_responders = [{ request_id: 'R3', user_id: 5 }, { request_id: 'R4', user_id: 77 }];
        });

        it('batches the party check into two scoped reads and admits client, lead and assigned responder only', async () => {
            const rooms = ['radio-req-R1', 'radio-req-R2', 'radio-req-R3', 'radio-req-R4'];
            expect(await names(caller({ permissions: [] }), rooms)).toEqual(['radio-req-R1', 'radio-req-R2', 'radio-req-R3']);
            expect(h.state.queries).toEqual([
                { table: 'service_requests', select: 'id, client_id, lead_responder_id', calls: [['in', 'id', ['R1', 'R2', 'R3', 'R4']]], terminal: 'list' },
                { table: 'request_responders', select: 'request_id', calls: [['eq', 'user_id', 5], ['in', 'request_id', ['R1', 'R2', 'R3', 'R4']]], terminal: 'list' },
            ]);
        });

        it('matches a string viewer id numerically', async () => {
            expect(await names(caller({ id: '5', permissions: [] }), ['radio-req-R1'])).toEqual(['radio-req-R1']);
        });

        it('a bare radio-req- room triggers no query', async () => {
            expect(await names(caller(), ['radio-req-'])).toEqual([]);
            expect(h.state.queries).toEqual([]);
        });

        it('skips a request row whose id does not map back to a requested room', async () => {
            // The viewer is a party to R2 and R3 too, but only R1 was asked about.
            h.state.looseFor = new Set(['service_requests', 'request_responders']);
            expect(await names(caller({ id: 5, permissions: [] }), ['radio-req-R1'])).toEqual(['radio-req-R1']);
        });

        it.each(['service_requests', 'request_responders'])('a failed %s read drops every mission room and logs that error', async (table) => {
            const err = { message: `${table} down` };
            h.state.errorFor = (t) => (t === table ? err : null);
            expect(await names(caller(), ['radio-req-R1', 'radio-dispatch'])).toEqual(['radio-dispatch']);
            expect(h.logger.warn).toHaveBeenCalledWith('radio status party filter query failed — dropping mission rooms', { err });
        });

        it('null data from both reads admits no mission room', async () => {
            h.state.nullDataFor = new Set(['service_requests', 'request_responders']);
            expect(await names(caller(), ['radio-req-R1', 'radio-req-R3'])).toEqual([]);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getRadioStatus', () => {
    const MANAGER = caller({ permissions: ['radio:manage'] });

    beforeEach(() => {
        h.lk.rooms = [
            { name: 'radio-dispatch', numParticipants: 2 },
            { name: 'radio-empty', numParticipants: 0 },
            { name: 'radio-unknown-count' },
            { name: 'stray-room', numParticipants: 4 },
        ];
        h.lk.participants['radio-dispatch'] = [{ identity: '11', name: 'Alice' }, { identity: '12', name: 'Bob' }];
    });

    it.each(SECRET_KEYS)('returns no channels and never calls LiveKit when %s is missing', async (key) => {
        h.state.secrets[key] = null;
        await expect(getRadioStatus({ viewer: MANAGER, includeParticipants: true })).resolves.toEqual({ activeChannels: [] });
        expect(h.lk.clients).toEqual([]);
        expect(h.lk.listRoomsCalls).toBe(0);
    });

    it('with includeParticipants, lists identities only for non-empty visible rooms', async () => {
        const out = await getRadioStatus({ viewer: MANAGER, includeParticipants: true });
        expect(h.lk.clients).toEqual([['wss://lk.example', 'lk-key', 'lk-secret']]);
        expect(h.lk.listParticipantsCalls).toEqual(['radio-dispatch']);
        expect(out).toEqual({
            activeChannels: [
                { roomName: 'radio-dispatch', participantCount: 2, participants: ['11', '12'], participantNames: ['Alice', 'Bob'] },
                { roomName: 'radio-empty', participantCount: 0, participants: [], participantNames: [] },
                { roomName: 'radio-unknown-count', participantCount: 0, participants: [], participantNames: [] },
            ],
        });
    });

    it('without includeParticipants, returns presence counts and NO identities (no participant call)', async () => {
        const out = await getRadioStatus({ viewer: MANAGER });
        expect(h.lk.listParticipantsCalls).toEqual([]);
        expect(out.activeChannels[0]).toEqual({ roomName: 'radio-dispatch', participantCount: 2, participants: [], participantNames: [] });
        expect(JSON.stringify(out)).not.toContain('Alice');
    });

    it('with no options at all, shows nothing (no viewer) but still fails closed rather than throwing', async () => {
        await expect(getRadioStatus()).resolves.toEqual({ activeChannels: [] });
        expect(h.lk.listRoomsCalls).toBe(1);
    });

    it.each([
        ['a 404 code', { code: 404 }],
        ['a "not found" message', new Error('room not found')],
    ])('treats %s from listParticipants as a closed room — silently', async (_label, err) => {
        h.lk.listParticipantsError['radio-dispatch'] = err;
        const out = await getRadioStatus({ viewer: MANAGER, includeParticipants: true });
        expect(out.activeChannels[0]).toEqual({ roomName: 'radio-dispatch', participantCount: 2, participants: [], participantNames: [] });
        expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it.each([
        ['an unexpected Error', new Error('livekit 500')],
        ['an error with no message', { code: 500 }],
    ])('logs %s from listParticipants and returns no identities', async (_label, err) => {
        h.lk.listParticipantsError['radio-dispatch'] = err;
        const out = await getRadioStatus({ viewer: MANAGER, includeParticipants: true });
        expect(out.activeChannels[0].participants).toEqual([]);
        expect(h.logger.warn).toHaveBeenCalledWith('list participants failed', { room: 'radio-dispatch', err });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('evictUserFromAllRooms', () => {
    const NOW = Date.UTC(2026, 10, 2, 10, 0, 0);

    it.each(SECRET_KEYS)('returns 0 without touching LiveKit when %s is missing', async (key) => {
        h.state.secrets[key] = null;
        await expect(evictUserFromAllRooms(5)).resolves.toBe(0);
        expect(h.lk.clients).toEqual([]);
    });

    it('returns 0 and logs when the room list cannot be read (never throws into the ban path)', async () => {
        const err = new Error('unreachable');
        h.lk.listRoomsError = err;
        await expect(evictUserFromAllRooms(5)).resolves.toBe(0);
        expect(h.logger.warn).toHaveBeenCalledWith('voice eviction: listRooms failed', { err });
        expect(h.lk.removals).toEqual([]);
    });

    it('revokes with a cutoff 60s ahead, counts only real removals, and logs only unexpected failures', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        h.lk.rooms = [
            { name: 'ok', numParticipants: 2 },
            { name: 'empty', numParticipants: 0 },
            { name: 'gone404', numParticipants: 1 },
            { name: 'goneMsg', numParticipants: 1 },
            { name: 'boom', numParticipants: 1 },
            { name: 'nomsg', numParticipants: 1 },
            { name: 'nullerr', numParticipants: 1 },
        ];
        const boom = new Error('timeout');
        h.lk.removeError = { gone404: { code: 404 }, goneMsg: new Error('participant not found'), boom, nomsg: { code: 500 }, nullerr: null };

        await expect(evictUserFromAllRooms(5)).resolves.toBe(1);

        const cutoff = BigInt(Math.floor(NOW / 1000) + 60);
        expect(h.lk.removals).toEqual(
            ['ok', 'gone404', 'goneMsg', 'boom', 'nomsg', 'nullerr'].map(room => ({ room, identity: '5', opts: { revokeTokenTs: cutoff } })),
        );
        expect(h.logger.warn.mock.calls).toEqual([
            ['voice eviction failed for a room', { room: 'boom', err: boom }],
            ['voice eviction failed for a room', { room: 'nomsg', err: { code: 500 } }],
            ['voice eviction failed for a room', { room: 'nullerr', err: null }],
        ]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rebootRadioNetwork', () => {
    it.each(SECRET_KEYS)('refuses when %s is missing, without a LiveKit client', async (key) => {
        h.state.secrets[key] = null;
        await expect(rebootRadioNetwork()).rejects.toThrow('Radio configuration missing');
        expect(h.lk.clients).toEqual([]);
    });

    it('deletes every room and reports the count even if one delete fails', async () => {
        h.lk.rooms = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
        h.lk.deleteError = { b: new Error('nope') };
        await expect(rebootRadioNetwork()).resolves.toEqual({ success: true, count: 3 });
        expect(h.lk.deleted).toEqual(['a', 'b', 'c']);
        expect(h.lk.clients).toEqual([['wss://lk.example', 'lk-key', 'lk-secret']]);
    });

    it('logs and rethrows the SAME error when the room list fails', async () => {
        const err = new Error('livekit down');
        h.lk.listRoomsError = err;
        await expect(rebootRadioNetwork()).rejects.toBe(err);
        expect(h.logger.error).toHaveBeenCalledWith('radio network reboot failed', { err });
        expect(h.lk.deleted).toEqual([]);
    });
});
