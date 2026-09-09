import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// Radio room resolution + per-class authorization (lib/radio resolveAndAuthorizeRadioRoom)
// =============================================================================
//
// The UI emits THREE room shapes (components/ui/RadioWidget.tsx):
//   radio-<channelId>      base/staff net (a radio_channels row)
//   radio-unit-<unitId>    a unit's synthetic squad net
//   radio-req-<requestId>  a mission net for one service request
//
// The server only ever implemented the first: the other two were looked up as
// radio_channels primary keys, missed, and threw 'Unknown radio channel' — so squad
// and mission voice were unjoinable on every deployment. And the base net had NO
// staff gate at all: `radio:auth` maps to the user:manage:self pseudo-perm, so the
// only thing keeping a Client off the org's dispatch net was a render filter.
//
// These tests pin both halves, plus the properties that make the fix safe: the
// prefix branches run BEFORE the caller-supplied-id channel lookup, the granted room
// name is re-derived server-side, every query error denies, and the manager bypass
// keys on PERMISSIONS (never the name-derived Admin tier).
//
// Behaviour-true supabase stub: each case seeds the rows the decision reads and the
// stub applies the accumulated .eq()/.in() predicates as a WHERE.

interface Row { [col: string]: unknown }

const h = vi.hoisted(() => {
    const state = {
        units: [] as Row[],
        radio_channels: [] as Row[],
        service_requests: [] as Row[],
        request_responders: [] as Row[],
        users: [] as Row[],
        operations: [] as Row[],
        operation_participants: [] as Row[],
        /** Every table a query was opened against, in order. */
        queried: [] as string[],
        /** Inject a read failure for one query, to prove the gate fails CLOSED. */
        errorFor: null as null | ((table: string, cols: string[]) => { message: string } | null),
        /** LiveKit creds present? Off by default so authz cases stop at the config check. */
        livekitConfigured: false,
        rooms: [] as Array<{ name: string; numParticipants: number }>,
        grantedRoom: null as string | null,
        grantedIdentity: null as string | null,
        createdRoom: null as string | null,
        tokenMinted: false,
        removals: [] as Array<{ room: string; identity: string; revokeTokenTs?: bigint }>,
    };

    function makeBuilder(table: string) {
        state.queried.push(table);
        const eqs: Array<[string, unknown]> = [];
        const ins: Array<[string, unknown[]]> = [];
        const isNulls: Array<[string, unknown]> = [];
        const rows = () => ((state as unknown as Record<string, Row[]>)[table] || []);
        const settle = () => rows().filter(r =>
            eqs.every(([c, v]) => String(r[c]) === String(v)) &&
            ins.every(([c, vs]) => vs.map(String).includes(String(r[c]))) &&
            isNulls.every(([c, v]) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v)));
        const failure = () => (state.errorFor ? state.errorFor(table, eqs.map(e => e[0])) : null);
        const b: any = {
            select: () => b,
            insert: () => b,
            update: () => b,
            delete: () => b,
            order: () => b,
            limit: () => b,
            eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
            in: (c: string, v: unknown[]) => { ins.push([c, v]); return b; },
            // `.is(col, null)` is a real predicate here, not a no-op: the op-room filter
            // reads only the viewer's ACTIVE participation (`time_left IS NULL`), and a
            // stub that ignored it would let a departed participant satisfy the
            // special-op arm of canUserSeeOpInList.
            is: (c: string, v: unknown) => { isNulls.push([c, v]); return b; },
        };
        b.maybeSingle = async () => { const e = failure(); return e ? { data: null, error: e } : { data: settle()[0] ?? null, error: null }; };
        b.single = b.maybeSingle;
        b.then = (resolve: any, reject: any) => {
            const e = failure();
            return Promise.resolve(e ? { data: null, error: e } : { data: settle(), error: null }).then(resolve, reject);
        };
        return b;
    }

    return { state, supabaseStub: { from: (t: string) => makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});

vi.mock('../lib/db/common', () => ({
    supabase: h.supabaseStub,
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
    },
    broadcastToOrg: () => {},
    broadcastToChannel: () => {},
    getSystemRoles: async () => ({}),
}));

// Mutable so the authz cases stop at 'Radio configuration missing' (proving the gate
// let them through) while the token-minting cases actually reach the LiveKit mock.
vi.mock('../lib/secrets', () => ({
    getOrgSecret: async (key: string) => {
        if (!h.state.livekitConfigured) return null;
        return ({ LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'devsecret', LIVEKIT_URL: 'wss://livekit.example' } as Record<string, string>)[key] ?? null;
    },
}));

vi.mock('livekit-server-sdk', () => {
    class AccessToken {
        constructor(_k: string, _s: string, opts?: { identity?: string; name?: string }) {
            h.state.grantedIdentity = opts?.identity ?? null;
        }
        addGrant(grant: { roomJoin?: boolean; room?: string }) { h.state.grantedRoom = grant.room ?? null; }
        async toJwt() { h.state.tokenMinted = true; return 'jwt.token.value'; }
    }
    class RoomServiceClient {
        async createRoom(opts: { name: string }) { h.state.createdRoom = opts.name; }
        async listRooms() { return h.state.rooms; }
        async listParticipants() { return []; }
        async removeParticipant(room: string, identity: string, opts?: { revokeTokenTs?: bigint }) { h.state.removals.push({ room, identity, revokeTokenTs: opts?.revokeTokenTs }); }
        async deleteRoom() { return undefined; }
    }
    return { AccessToken, RoomServiceClient };
});

import { resolveAndAuthorizeRadioRoom, generateRadioToken, getRadioStatus, evictUserFromAllRooms, type RadioUser } from '../lib/radio';
import { addRadioChannel } from '../lib/db/system';
import { STAFF_VIEW_PERMS, hasAnyStaffViewPerm } from '../lib/staffPerms';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';

const STAFF = ['operations:view'];
const MANAGER = ['radio:manage'];
const CLIENT = [...CLIENT_DEFAULT_PERMS];

// `role` is no longer part of RadioUser: radio authorization is permission-only and
// op-voice authorization runs through the clearance module, which reads the stamped
// role IDENTITY. A forged tier is passed by cast where a test needs one.
const caller = (over: Partial<RadioUser> = {}): RadioUser => ({
    id: 5, name: 'Caller', permissions: [...STAFF], ...over,
});

beforeEach(() => {
    const s = h.state;
    s.units = []; s.radio_channels = []; s.service_requests = []; s.request_responders = []; s.users = [];
    s.operations = []; s.operation_participants = [];
    s.queried = []; s.errorFor = null; s.livekitConfigured = false; s.rooms = [];
    s.grantedRoom = null; s.grantedIdentity = null; s.createdRoom = null; s.tokenMinted = false;
    s.removals = [];
});

// -----------------------------------------------------------------------------
// THE REGRESSION: squad + mission nets resolve at all.
// -----------------------------------------------------------------------------
describe('squad net (radio-unit-<unitId>)', () => {
    it('resolves for a member of that unit (was: "Unknown radio channel" on every deployment)', async () => {
        h.state.units.push({ id: 7, has_radio_channel: true, is_restricted: false });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7'))
            .resolves.toBe('radio-unit-7');
    });

    it('re-derives the room name from the parsed integer (radio-unit-007 does not fork a room)', async () => {
        h.state.units.push({ id: 7, has_radio_channel: true, is_restricted: false });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-007'))
            .resolves.toBe('radio-unit-7');
    });

    it('lets a member of a RESTRICTED unit into their own squad net', async () => {
        h.state.units.push({ id: 7, has_radio_channel: true, is_restricted: true });
        h.state.users.push({ id: 5, unit_id: 7, role: { role_permissions: [] } });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7'))
            .resolves.toBe('radio-unit-7');
    });

    it("denies another unit's squad net — membership gates even a NON-restricted unit", async () => {
        h.state.units.push({ id: 8, has_radio_channel: true, is_restricted: false });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-8'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a unit with its radio channel switched off', async () => {
        h.state.units.push({ id: 7, has_radio_channel: false, is_restricted: false });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a caller with no unit at all (undefined unit fails closed)', async () => {
        h.state.units.push({ id: 7, has_radio_channel: true, is_restricted: false });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: null }), 'radio-unit-7'))
            .rejects.toThrow(/not authorized/i);
    });

    it.each(['radio-unit-abc', 'radio-unit-', 'radio-unit-0', 'radio-unit--1'])(
        'rejects %s without touching the units table', async (room) => {
            await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), room))
                .rejects.toThrow(/not authorized/i);
            expect(h.state.queried.filter(t => t === 'units')).toEqual([]);
        });

    it('denies when the unit lookup errors (a read fault must not read as "open")', async () => {
        h.state.units.push({ id: 7, has_radio_channel: true, is_restricted: false });
        h.state.errorFor = (table) => (table === 'units' ? { message: 'boom' } : null);
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-7'))
            .rejects.toThrow(/not authorized/i);
    });
});

describe('mission net (radio-req-<requestId>)', () => {
    const seedReq = (over: Row = {}) => h.state.service_requests.push({ id: 'REQ-1', client_id: 99, lead_responder_id: null, ...over });

    it("resolves for the request's client — a Client with only CLIENT_DEFAULT_PERMS gets in", async () => {
        seedReq({ client_id: 5 });
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: CLIENT }), 'radio-req-REQ-1'))
            .resolves.toBe('radio-req-REQ-1');
    });

    it('resolves for the lead responder (a lead is not guaranteed a responder row)', async () => {
        seedReq({ lead_responder_id: 5 });
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1'))
            .resolves.toBe('radio-req-REQ-1');
    });

    it('resolves for an assigned responder', async () => {
        seedReq();
        h.state.request_responders.push({ request_id: 'REQ-1', user_id: 5 });
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1'))
            .resolves.toBe('radio-req-REQ-1');
    });

    it('re-derives the room name from the DB row id', async () => {
        seedReq({ id: 'REQ-1', client_id: 5 });
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1'))
            .resolves.toBe('radio-req-REQ-1');
    });

    it('matches the party ids numerically (RadioUser.id is number|string)', async () => {
        seedReq({ client_id: 5 });
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: '5' }), 'radio-req-REQ-1'))
            .resolves.toBe('radio-req-REQ-1');
    });

    it('denies an unrelated staff member', async () => {
        seedReq();
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a request:dispatch holder who is not a party (deliberate divergence from assertRequestResponderOrDuty)', async () => {
        // lib/db/requests.ts:340 admits any request-duty holder. Live voice is
        // narrower: party membership only. A dispatcher reaches every mission net
        // through radio:manage, which the seeded Dispatcher role holds.
        seedReq();
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: ['request:dispatch', 'request:triage'] }), 'radio-req-REQ-1'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a request that does not exist', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-NOPE'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies when the request lookup errors', async () => {
        seedReq({ client_id: 5 });
        h.state.errorFor = (table) => (table === 'service_requests' ? { message: 'boom' } : null);
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies when the responder lookup errors', async () => {
        seedReq();
        h.state.errorFor = (table) => (table === 'request_responders' ? { message: 'boom' } : null);
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-req-REQ-1'))
            .rejects.toThrow(/not authorized/i);
    });
});

// -----------------------------------------------------------------------------
// Base/staff nets — the gate that only ever existed in the browser.
// -----------------------------------------------------------------------------
describe('base net (radio-<channelId>) staff gate', () => {
    beforeEach(() => { h.state.radio_channels.push({ id: 'dispatch' }); });

    it('denies a Client holding only CLIENT_DEFAULT_PERMS the org dispatch net', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: CLIENT }), 'radio-dispatch'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a caller with NO permissions', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: [] }), 'radio-dispatch'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a role-tier "Admin" holding zero permissions (the tier is derived from the role NAME)', async () => {
        await expect(resolveAndAuthorizeRadioRoom({ ...caller({ permissions: [] }), role: 'Admin' } as unknown as RadioUser, 'radio-dispatch'))
            .rejects.toThrow(/not authorized/i);
    });

    it('admits a staff member holding operations:view', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch')).resolves.toBe('radio-dispatch');
    });

    it('admits admin:access alone', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: ['admin:access'] }), 'radio-dispatch'))
            .resolves.toBe('radio-dispatch');
    });

    it('denies an unknown channel with the SAME message as an unauthorized one (no existence oracle)', async () => {
        const denied = await resolveAndAuthorizeRadioRoom(caller(), 'radio-nope').catch(e => (e as Error).message);
        const unauth = await resolveAndAuthorizeRadioRoom(caller({ permissions: CLIENT }), 'radio-dispatch').catch(e => (e as Error).message);
        expect(denied).toBe(unauth);
    });

    it('still closes the multi-linked-unit dodge (every restricted linked unit is checked)', async () => {
        h.state.units.push({ id: 5, is_restricted: true, linked_channel_id: 'dispatch' });
        h.state.units.push({ id: 6, is_restricted: false, linked_channel_id: 'dispatch' });
        h.state.users.push({ id: 9, unit_id: 6, role: { role_permissions: [] } });
        await expect(resolveAndAuthorizeRadioRoom(caller({ id: 9, unit: { id: 6 } }), 'radio-dispatch'))
            .rejects.toThrow(/restricted/i);
    });

    it('denies when the linked-units lookup errors (was a fail-OPEN: an empty exclusion set)', async () => {
        h.state.units.push({ id: 5, is_restricted: true, linked_channel_id: 'dispatch' });
        h.state.errorFor = (table, cols) => (table === 'units' && cols.includes('linked_channel_id') ? { message: 'boom' } : null);
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies when the channel lookup errors', async () => {
        h.state.errorFor = (table) => (table === 'radio_channels' ? { message: 'boom' } : null);
        await expect(resolveAndAuthorizeRadioRoom(caller(), 'radio-dispatch'))
            .rejects.toThrow(/not authorized/i);
    });
});

// -----------------------------------------------------------------------------
// Manager bypass, branch order, malformed input.
// -----------------------------------------------------------------------------
describe('manager bypass and branch precedence', () => {
    it("a radio:manage holder joins another unit's squad net", async () => {
        h.state.units.push({ id: 8, has_radio_channel: true, is_restricted: true });
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: MANAGER, unit: { id: 7 } }), 'radio-unit-8'))
            .resolves.toBe('radio-unit-8');
    });

    it('a radio:manage holder joins a mission net they are not a party to', async () => {
        h.state.service_requests.push({ id: 'REQ-1', client_id: 99, lead_responder_id: null });
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: MANAGER }), 'radio-req-REQ-1'))
            .resolves.toBe('radio-req-REQ-1');
    });

    it('a radio:manage holder still cannot mint a room for a request that does not exist', async () => {
        await expect(resolveAndAuthorizeRadioRoom(caller({ permissions: MANAGER }), 'radio-req-NOPE'))
            .rejects.toThrow(/not authorized/i);
    });

    it('a radio_channels row named "unit-9" cannot launder a caller past the unit gate', async () => {
        // radio_channels.id is a caller-supplied text PK. If the base lookup ran
        // before the prefix branches, a radio:manage holder could create this row and
        // hand every staff member a bypass into unit 9's squad net.
        h.state.radio_channels.push({ id: 'unit-9' });
        h.state.units.push({ id: 9, has_radio_channel: true, is_restricted: false });
        await expect(resolveAndAuthorizeRadioRoom(caller({ unit: { id: 7 } }), 'radio-unit-9'))
            .rejects.toThrow(/not authorized/i);
    });

    it.each(['op-radio-123', '', 'radio-', 'radio', 'unit-7', null, 123])(
        'rejects the malformed room %p', async (room) => {
            await expect(resolveAndAuthorizeRadioRoom(caller(), room as unknown as string))
                .rejects.toThrow(/not authorized/i);
        });
});

// -----------------------------------------------------------------------------
// The grant itself: never the raw client string.
// -----------------------------------------------------------------------------
describe('generateRadioToken stamps only the SERVER-derived room name', () => {
    it('mints radio-unit-7 for a request of radio-unit-007', async () => {
        h.state.livekitConfigured = true;
        h.state.units.push({ id: 7, has_radio_channel: true, is_restricted: false });
        await expect(generateRadioToken(caller({ unit: { id: 7 } }), 'radio-unit-007')).resolves.toMatchObject({ token: 'jwt.token.value' });
        expect(h.state.grantedRoom).toBe('radio-unit-7');
        expect(h.state.createdRoom).toBe('radio-unit-7');
        expect(h.state.grantedIdentity).toBe('5');
    });

    it('mints no token at all for a denied channel', async () => {
        h.state.livekitConfigured = true;
        h.state.radio_channels.push({ id: 'dispatch' });
        await expect(generateRadioToken(caller({ permissions: CLIENT }), 'radio-dispatch'))
            .rejects.toThrow(/not authorized/i);
        expect(h.state.tokenMinted).toBe(false);
        expect(h.state.grantedRoom).toBeNull();
        expect(h.state.createdRoom).toBeNull();
    });
});

// -----------------------------------------------------------------------------
// The read side: radio:status must not enumerate rooms the caller can't join.
// -----------------------------------------------------------------------------
describe('getRadioStatus room-name visibility', () => {
    const ROOMS = [
        { name: 'radio-dispatch', numParticipants: 2 },
        { name: 'radio-unit-7', numParticipants: 1 },
        { name: 'radio-req-REQ-1', numParticipants: 3 },
        { name: 'op-radio-op1', numParticipants: 1 },
    ];
    beforeEach(() => {
        h.state.livekitConfigured = true;
        h.state.rooms = [...ROOMS];
        h.state.service_requests.push({ id: 'REQ-1', client_id: 5, lead_responder_id: null });
        // An ORDINARY op: clearance 0, not special, no markers. It is visible to anyone
        // who may list operations at all, which is the point — the gate being tested is
        // 'may this viewer enumerate operations', not 'is this op secret'.
        h.state.operations.push({ id: 'op1', owner_id: 99, clearance_level: 0, is_special: false });
    });
    const names = async (viewer: RadioUser | null) =>
        (await getRadioStatus({ viewer })).activeChannels.map(c => c.roomName);

    it('a Client sees only their own mission net (not the staff net, not a squad net)', async () => {
        expect(await names(caller({ permissions: CLIENT }))).toEqual(['radio-req-REQ-1']);
    });

    it('a staff member sees base + their own squad, but not a mission they are not on', async () => {
        h.state.service_requests[0].client_id = 99;
        expect(await names(caller({ unit: { id: 7 } }))).toEqual(['radio-dispatch', 'radio-unit-7', 'op-radio-op1']);
    });

    it("a staff member does not see another unit's squad net", async () => {
        h.state.service_requests[0].client_id = 99;
        expect(await names(caller({ unit: { id: 8 } }))).toEqual(['radio-dispatch', 'op-radio-op1']);
    });

    it('a radio:manage holder sees every RADIO room — op rooms need the ops gate', async () => {
        // radio:manage administers the radio system; it is not a licence to enumerate
        // which operations are running. The op room needs operations:view like the ops
        // list does, so the dispatch board keeps every radio-* room and loses only the
        // op-voice rooms its holder was never entitled to see.
        expect(await names(caller({ permissions: MANAGER })))
            .toEqual(['radio-dispatch', 'radio-unit-7', 'radio-req-REQ-1']);
    });

    it('no viewer drops every radio-* room (fails closed)', async () => {
        expect(await names(null)).toEqual([]);
    });

    // ── op-voice room enumeration ──────────────────────────────────────────────
    // op-radio-<uuid> rooms used to fall through the 'not a radio- room' branch and be
    // admitted unconditionally, handing ANY authenticated caller the operation UUID and
    // live headcount of every op on voice. For a special or clearance-gated op that is
    // exactly the existence fact the rest of the ops module withholds; joining already
    // required assertOpVisibleToUser, only the LIST was open.

    it('a Client cannot enumerate op-voice rooms at all', async () => {
        // No operations:view — the same gate the 'operations' query subset carries.
        expect(await names(caller({ permissions: CLIENT }))).not.toContain('op-radio-op1');
    });

    it('an op ABOVE the viewer clearance is not listed', async () => {
        h.state.operations[0].clearance_level = 3;
        expect(await names(caller({ unit: { id: 7 }, clearanceLevel: { level: 1 } })))
            .not.toContain('op-radio-op1');
    });

    it('a SPECIAL op is not listed to a non-participant, even at clearance 0', async () => {
        h.state.operations[0].is_special = true;
        expect(await names(caller({ unit: { id: 7 } }))).not.toContain('op-radio-op1');
    });

    it('...but IS listed to an active participant', async () => {
        h.state.operations[0].is_special = true;
        h.state.operation_participants.push({ operation_id: 'op1', user_id: 5, time_left: null });
        expect(await names(caller({ unit: { id: 7 } }))).toContain('op-radio-op1');
    });

    it('a DEPARTED participant does not count', async () => {
        h.state.operations[0].is_special = true;
        h.state.operation_participants.push({ operation_id: 'op1', user_id: 5, time_left: '2026-01-01T00:00:00Z' });
        expect(await names(caller({ unit: { id: 7 } }))).not.toContain('op-radio-op1');
    });

    it('the op owner sees their own special op', async () => {
        h.state.operations[0].is_special = true;
        h.state.operations[0].owner_id = 5;
        expect(await names(caller({ unit: { id: 7 } }))).toContain('op-radio-op1');
    });

    it('a failed op lookup drops the op rooms rather than widening the list', async () => {
        h.state.errorFor = (table) => (table === 'operations' ? { message: 'boom' } : null);
        expect(await names(caller({ unit: { id: 7 } }))).not.toContain('op-radio-op1');
    });

    it('an unrecognised room class is dropped, not admitted', async () => {
        h.state.rooms = [...ROOMS, { name: 'something-else', numParticipants: 1 }];
        expect(await names(caller({ unit: { id: 7 } }))).not.toContain('something-else');
    });

    it('a failed party lookup drops the mission rooms rather than widening the list', async () => {
        h.state.errorFor = (table) => (table === 'service_requests' ? { message: 'boom' } : null);
        expect(await names(caller({ permissions: CLIENT }))).toEqual([]);
    });
});

// -----------------------------------------------------------------------------
// Write-side reservation + the staff-permission set itself.
// -----------------------------------------------------------------------------
describe('addRadioChannel reserves the synthetic-channel prefixes', () => {
    it.each(['unit-9', 'req-REQ-1'])('refuses the reserved id %s', async (id) => {
        await expect(addRadioChannel({ id, name: 'Sneaky' })).rejects.toThrow(/reserved/i);
    });
    it('requires an id', async () => {
        await expect(addRadioChannel({ id: '  ', name: 'x' })).rejects.toThrow(/required/i);
    });
    it('still accepts an ordinary channel id', async () => {
        await expect(addRadioChannel({ id: 'dispatch', name: 'Dispatch' })).resolves.toBeUndefined();
    });
});

describe('hasAnyStaffViewPerm', () => {
    it('is false for an empty or absent permission set', () => {
        expect(hasAnyStaffViewPerm([])).toBe(false);
        expect(hasAnyStaffViewPerm(undefined)).toBe(false);
        expect(hasAnyStaffViewPerm(null)).toBe(false);
    });
    it.each([...CLIENT_DEFAULT_PERMS])('is false for the client-default permission %s alone', (p) => {
        expect(hasAnyStaffViewPerm([p])).toBe(false);
    });
    it('is true for a single staff read permission', () => {
        expect(hasAnyStaffViewPerm(['operations:view'])).toBe(true);
    });
    it('stays disjoint from CLIENT_DEFAULT_PERMS — widening this list mints staff-net tokens', () => {
        expect(STAFF_VIEW_PERMS.filter(p => (CLIENT_DEFAULT_PERMS as readonly string[]).includes(p))).toEqual([]);
    });
});

describe('evictUserFromAllRooms REVOKES the grant, not just the connection', () => {
    // ban:place calls this so a banned member stops hearing operational comms. A bare
    // removeParticipant only drops the CONNECTION and leaves the join token valid — and
    // this module mints them with ttl '6h', so the client reconnects on its own and the
    // eviction is cosmetic on exactly the path it was added for.
    beforeEach(() => {
        h.state.livekitConfigured = true;
        h.state.rooms = [
            { name: 'radio-dispatch', numParticipants: 2 },
            { name: 'op-radio-op1', numParticipants: 1 },
            { name: 'radio-empty', numParticipants: 0 },
        ];
    });

    it('passes a revocation cutoff for every room it evicts from', async () => {
        const before = Math.floor(Date.now() / 1000);
        const removed = await evictUserFromAllRooms(5);
        expect(removed).toBe(2);
        expect(h.state.removals.map(r => r.room)).toEqual(['radio-dispatch', 'op-radio-op1']);
        for (const r of h.state.removals) {
            expect(r.identity).toBe('5');
            expect(typeof r.revokeTokenTs, 'a bare kick leaves the 6h join token usable').toBe('bigint');
            // Forward of now, so a token minted in the same instant as the ban is caught.
            expect(Number(r.revokeTokenTs)).toBeGreaterThanOrEqual(before);
        }
    });

    it('skips empty rooms rather than calling the API for them', async () => {
        await evictUserFromAllRooms(5);
        expect(h.state.removals.some(r => r.room === 'radio-empty')).toBe(false);
    });
});
