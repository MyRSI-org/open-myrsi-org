import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { User } from '../types';

// ONE fixture, EVERY special-operation path. Owner-approved 2026-11-02: a FORMER
// participant keeps READ access; WRITES stay active-only.
//
// "Former" has a precise meaning in this codebase. Leaving or being removed DELETES the
// operation_participants row (leaveOperation); only concluding the op
// (updateOperationStatus 'Concluded') stamps time_left on every active row. So:
//
//   ACTIVE   — row, time_left NULL
//   FORMER   — row, time_left stamped (was on the roster when the op concluded)
//   REMOVED  — had a row; it was deleted when they left / were removed
//   OUTSIDER — never on the op
//
// Before this change the paths disagreed: list / slice / detail admitted FORMER (their
// embeds never selected time_left and the mapper hardcoded null) while
// assertOpVisibleToUser and the op-board realtime predicate refused them. This suite
// runs the SAME four members through every path so a future edit to any one of them
// that drifts from the others fails here:
//
//   list (getOperations) · slice (getOperationByIdLite) · detail (operation:get_details)
//   · sub-resource READS (get_latest_alert, get_participant_ships, template:from_operation)
//   · WRITES (toggle_ready, timeline_add, update_participant_live_status, rsvp,
//     add_logistics, self-leave) · add_aar_entry, the one write on the READ term (owner
//     decision: the AAR exists only after conclusion) · the op-board RLS predicate
//     (schema.sql private.rt_can_read_op_board, evaluated against the same roster).

vi.mock('../lib/db/common', async () => (await import('./cov-db-ops-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-ops-fake')).logMock);
vi.mock('../lib/db/operations-federation', async () => (await import('./cov-db-ops-fake')).fed);
vi.mock('../lib/push', async () => ({ sendPushToUsers: (await import('./cov-db-ops-fake')).collab.sendPushToUsers }));
vi.mock('../lib/db/users', async () => {
    const f = await import('./cov-db-ops-fake');
    return { getUserById: f.collab.getUserById, getActorLabel: f.collab.getActorLabel };
});
vi.mock('../lib/db/notifications', async () => ({ createNotification: (await import('./cov-db-ops-fake')).collab.createNotification }));
vi.mock('../lib/db/securityEvents', async () => ({ recordSecurityEvent: (await import('./cov-db-ops-fake')).collab.recordSecurityEvent }));
// The handlers reach the REAL lib/db/ops through the barrel; only the collaborators a
// read handler calls after its gate are stubbed (they are not under test here).
const stubs = vi.hoisted(() => ({
    getUserShipsByUserIds: vi.fn(async (ids: number[]) => ids.map((id) => ({ id: 100 + id, userId: id }))),
    extractTemplatePayloadFromOperation: vi.fn(async () => ({ phases: [] })),
}));
vi.mock('../lib/db', async () => ({ ...(await import('../lib/db/ops')), ...stubs }));
vi.mock('../lib/discord', () => ({
    createGuildScheduledEvent: vi.fn(), deleteGuildScheduledEvent: vi.fn(), updateGuildScheduledEvent: vi.fn(),
    listGuildChannels: vi.fn(), postOperationAnnouncementEmbed: vi.fn(), editOperationAnnouncementEmbed: vi.fn(),
    deleteDiscordChannelMessage: vi.fn(),
}));

import { resetFake, resetCollaborators, route, cols, eqs, argsOf, writeKind } from './cov-db-ops-fake';
import { getOperations, getOperationByIdLite } from '../lib/db/ops';
import { operationActions } from '../api/actions/operations';

const OP_ID = '0b0e7a1c-5d2f-4c3b-9a8e-7f6d5c4b3a21';
const OWNER_ID = 5;
const CONCLUDED_AT = '2026-10-01T18:00:00Z';

type Member = { id: number; role: string; permissions: string[]; clearanceLevel: { level: number }; limitingMarkers: unknown[] };
const member = (id: number): Member => ({ id, role: 'Member', permissions: ['operations:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] });

const ACTIVE = member(6);
const FORMER = member(7);
const REMOVED = member(8);
const OUTSIDER = member(9);
const CAST = { ACTIVE, FORMER, REMOVED, OUTSIDER } as const;
type Who = keyof typeof CAST;
const WHO: Who[] = ['ACTIVE', 'FORMER', 'REMOVED', 'OUTSIDER'];

/** operation_participants as the database holds it. REMOVED's row was deleted. */
const ROSTER = [
    { operation_id: OP_ID, user_id: OWNER_ID, joined_at: '2026-09-30T10:00:00Z', time_left: null as string | null },
    { operation_id: OP_ID, user_id: ACTIVE.id, joined_at: '2026-09-30T10:05:00Z', time_left: null as string | null },
    { operation_id: OP_ID, user_id: FORMER.id, joined_at: '2026-09-30T10:06:00Z', time_left: CONCLUDED_AT as string | null },
];

let opClearance = 0;

/** The participant embed honours its column list, as PostgREST does: time_left only
 *  rides along when the select names it. */
function embedRows(select: string) {
    const embed = select.slice(select.indexOf('participants:operation_participants('));
    const withTimeLeft = /participants:operation_participants\([^)]*\btime_left\b/.test(embed);
    return ROSTER.map((r) => ({
        user_id: r.user_id, joined_at: r.joined_at, is_ready: false,
        ...(withTimeLeft ? { time_left: r.time_left } : {}),
        user: { id: r.user_id, name: `User ${r.user_id}`, avatar_url: 'a' },
    }));
}

function opRow(select: string) {
    return {
        id: OP_ID, name: 'Black Op', owner_id: OWNER_ID, status: 'Concluded', type: 'Combat', description: 'd',
        created_at: '2026-09-30T09:00:00Z', clearance_level: opClearance, is_special: true, join_code: 'PIN-123456',
        roe: 'weapons tight', limiting_markers: [], log: [], owner: { id: OWNER_ID, name: 'Owner', avatar_url: 'a' },
        participants: embedRows(select),
    };
}

beforeEach(() => {
    resetFake();
    resetCollaborators();
    opClearance = 0;
    route('operations', (q) => {
        const c = cols(q);
        if (writeKind(q) !== 'read') return { data: null };
        if (c === 'is_joint') return { data: { is_joint: false } };
        if (c.startsWith('id, owner_id, is_special, clearance_level')) {
            return { data: { id: OP_ID, owner_id: OWNER_ID, is_special: true, clearance_level: opClearance, limiting_markers: [] } };
        }
        if (c.includes('participants:operation_participants(')) {
            // The list read is capped (.limit) and returns rows; slice/detail return one.
            return { data: argsOf(q, 'limit').length ? [opRow(c)] : opRow(c) };
        }
        return { data: null };
    });
    route('operation_participants', (q) => {
        if (writeKind(q) !== 'read') return { data: null };
        const uid = eqs(q).find(([k]) => k === 'user_id')?.[1];
        const activeOnly = argsOf(q, 'is').some(([k, v]) => k === 'time_left' && v === null);
        const row = ROSTER.find((r) => r.user_id === uid && (!activeOnly || r.time_left === null));
        return { data: row ? { user_id: row.user_id, is_ready: false } : null };
    });
});

const asUser = (m: Member) => m as unknown as User;
const actions = operationActions as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>;
const SPECIAL_DENIAL = 'Insufficient access to act on this special operation.';

async function outcome(p: Promise<unknown>): Promise<'allow' | string> {
    try { await p; return 'allow'; } catch (e) { return (e as Error).message; }
}

// ── The board policy, evaluated against the SAME roster ─────────────────────
// Lift the special-op participation EXISTS out of private.rt_can_read_op_board and
// interpret its WHERE clause. Only conjuncts this table understands are accepted, so a
// new term (e.g. a re-added time_left filter) is evaluated, not ignored — and an
// unrecognised one fails loudly instead of being guessed at.
function boardParticipationTerm(): (viewerId: number) => boolean {
    const schema = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8').replace(/\r\n/g, '\n');
    const start = schema.indexOf('CREATE OR REPLACE FUNCTION private.rt_can_read_op_board');
    expect(start).toBeGreaterThan(-1);
    const body = schema.slice(start, schema.indexOf('$$;', start)).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
    const m = body.match(/NOT COALESCE\(o\.is_special, false\) OR EXISTS \( SELECT 1 FROM public\.operation_participants opp WHERE (.*?) \) \)/);
    expect(m, 'the special-op participation EXISTS was not found in rt_can_read_op_board').not.toBeNull();
    type Row = (typeof ROSTER)[number];
    const KNOWN: Record<string, (r: Row, viewerId: number) => boolean> = {
        'opp.operation_id = o.id': (r) => r.operation_id === OP_ID,
        'opp.user_id = u.id': (r, viewerId) => r.user_id === viewerId,
        'opp.time_left IS NULL': (r) => r.time_left === null,
    };
    const conjuncts = m![1].split(' AND ').map((s) => s.trim());
    for (const cj of conjuncts) expect(Object.keys(KNOWN), `unrecognised board participation conjunct: ${cj}`).toContain(cj);
    return (viewerId) => ROSTER.some((r) => conjuncts.every((cj) => KNOWN[cj](r, viewerId)));
}

// ── The matrix ──────────────────────────────────────────────────────────────
const READ_ALLOWED: Record<Who, boolean> = { ACTIVE: true, FORMER: true, REMOVED: false, OUTSIDER: false };
const WRITE_ALLOWED: Record<Who, boolean> = { ACTIVE: true, FORMER: false, REMOVED: false, OUTSIDER: false };

describe('special op, one roster — READ paths admit current AND former participants only', () => {
    it.each(WHO)('list (getOperations): %s', async (who) => {
        const ops = await getOperations(asUser(CAST[who]));
        expect(ops.map((o) => o.id)).toEqual(READ_ALLOWED[who] ? [OP_ID] : []);
    });

    it.each(WHO)('slice (getOperationByIdLite): %s', async (who) => {
        const op = await getOperationByIdLite(OP_ID, asUser(CAST[who]));
        expect(op?.id ?? null).toBe(READ_ALLOWED[who] ? OP_ID : null);
    });

    it.each(WHO)('detail (operation:get_details): %s', async (who) => {
        const r = await outcome(actions['operation:get_details']({ operationId: OP_ID, user: CAST[who] }));
        expect(r).toBe(READ_ALLOWED[who] ? 'allow' : 'Insufficient access to view this special operation.');
    });

    it.each(WHO)('sub-resource reads (latest alert, participant ships, template extraction): %s', async (who) => {
        const user = CAST[who];
        const results = await Promise.all([
            outcome(actions['operation:get_latest_alert']({ operationId: OP_ID, user })),
            outcome(actions['operation:get_participant_ships']({ operationId: OP_ID, userIds: [ACTIVE.id], user })),
            outcome(actions['operation:template:from_operation']({ operationId: OP_ID, user })),
        ]);
        expect(results).toEqual(Array(3).fill(READ_ALLOWED[who] ? 'allow' : SPECIAL_DENIAL));
    });

    it.each(WHO)('op-board realtime predicate (participation term): %s', (who) => {
        expect(boardParticipationTerm()(CAST[who].id)).toBe(READ_ALLOWED[who]);
    });
});

describe('special op, one roster — WRITE paths stay ACTIVE-only', () => {
    const WRITES: Array<[string, (u: Member) => Record<string, unknown>]> = [
        ['operation:toggle_ready', (u) => ({ operationId: OP_ID, userId: u.id, user: u })],
        ['operation:timeline_add', (u) => ({ operationId: OP_ID, entry: 'note', userId: u.id, user: u })],
        ['operation:update_participant_live_status', (u) => ({ operationId: OP_ID, userId: u.id, liveStatus: 'Engaged', user: u })],
        ['operation:rsvp', (u) => ({ operationId: OP_ID, userId: u.id, rsvpStatus: 'Accepted', user: u })],
        ['operation:add_logistics', (u) => ({ operationId: OP_ID, data: { itemName: 'Fuel' }, user: u })],
        ['operation:leave', (u) => ({ operationId: OP_ID, userId: u.id, user: u })],
    ];

    it.each(WHO)('%s: every write is allowed only for the ACTIVE participant', async (who) => {
        const u = CAST[who];
        for (const [action, payload] of WRITES) {
            const r = await outcome(actions[action](payload(u)));
            expect(r, `${action} as ${who}`).toBe(WRITE_ALLOWED[who] ? 'allow' : SPECIAL_DENIAL);
        }
    });
});

describe('special op, one roster — add_aar_entry is the one write on the READ term', () => {
    // Owner decision (15.7.1): the AAR exists only after an op concludes, and concluding
    // stamps time_left on every active row, so the strict term would leave no one who took
    // part able to contribute. A former participant may add an entry; a removed member or
    // an outsider still may not.
    it.each(WHO)('%s: add_aar_entry follows READ access', async (who) => {
        const u = CAST[who];
        const r = await outcome(actions['operation:add_aar_entry']({ operationId: OP_ID, data: { content: 'lesson' }, userId: u.id, user: u }));
        expect(r).toBe(READ_ALLOWED[who] ? 'allow' : SPECIAL_DENIAL);
    });
});

describe('the former participant is SHOWN as having left (time_left is mapped, not hardcoded)', () => {
    it('list and detail carry each roster row\'s real time_left', async () => {
        const [listed] = await getOperations(asUser(FORMER));
        const detail = await actions['operation:get_details']({ operationId: OP_ID, user: FORMER }) as { participants: Array<{ userId: number; timeLeft: unknown }> };
        for (const op of [listed as unknown as typeof detail, detail]) {
            expect(op.participants.map((p) => [p.userId, p.timeLeft])).toEqual([
                [OWNER_ID, null], [ACTIVE.id, null], [FORMER.id, CONCLUDED_AT],
            ]);
        }
    });
});

describe('participation never substitutes for clearance — every READ path still refuses a former participant below the op level', () => {
    it.each(['ACTIVE', 'FORMER'] as const)('%s at level 0 on a level-2 special op', async (who) => {
        opClearance = 2;
        const user = CAST[who];
        expect(await getOperations(asUser(user))).toEqual([]);
        expect(await getOperationByIdLite(OP_ID, asUser(user))).toBeNull();
        expect(await outcome(actions['operation:get_details']({ operationId: OP_ID, user }))).toBe('Insufficient clearance to view this operation.');
        expect(await outcome(actions['operation:get_latest_alert']({ operationId: OP_ID, user }))).toBe('Insufficient clearance to act on this operation.');
    });
});

// ── Per-action wiring: which handlers ask for the READ term ──────────────────
describe('api/actions/operations.ts — the READ/ACT split is pinned per action', () => {
    const src = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'operations.ts'), 'utf8').replace(/\r\n/g, '\n');
    // Every gate call, keyed by the action whose handler contains it.
    const calls: Array<{ action: string; args: string }> = [];
    const actionAt = [...src.matchAll(/^ {4}'(operation:[a-z_:]+)': /gm)].map((m) => ({ action: m[1], at: m.index! }));
    for (const m of src.matchAll(/await db\.assertOpVisibleToUser\(([^;]*?)\);/g)) {
        const owner = actionAt.filter((a) => a.at < m.index!).pop();
        calls.push({ action: owner!.action, args: m[1].replace(/\s+/g, ' ') });
    }

    it('only the four sub-resource READS and add_aar_entry pass { access: \'read\' }', () => {
        expect(calls.filter((c) => c.args.includes("access: 'read'")).map((c) => c.action).sort()).toEqual([
            'operation:add_aar_entry',
            'operation:get_latest_alert',
            'operation:get_participant_ships',
            'operation:template:create',
            'operation:template:from_operation',
        ]);
    });

    it('the join paths skip participation only via isJoinAttempt; EVERY other call uses the strict default', () => {
        const join = calls.filter((c) => c.args.includes('isJoinAttempt'));
        expect(join.map((c) => c.action).sort()).toEqual(['operation:join', 'operation:join_with_role']);
        const rest = calls.filter((c) => !c.args.includes("access: 'read'") && !c.args.includes('isJoinAttempt'));
        // The writes: two plain arguments, no options object — i.e. the ACTIVE term.
        for (const c of rest) expect(c.args, c.action).toMatch(/^(operationId|sourceOperationId), user$/);
        expect(rest.map((c) => c.action).sort()).toEqual([
            'operation:add_logistics', 'operation:apply_for_slot', 'operation:assign_slot',
            'operation:decide_slot_application', 'operation:delete_aar_entry', 'operation:delete_logistics',
            'operation:fulfill_logistics', 'operation:leave', 'operation:remove_slot_assignment', 'operation:rsvp',
            'operation:timeline_add', 'operation:toggle_ready', 'operation:update_logistics',
            'operation:update_participant_live_status', 'operation:withdraw_slot',
        ]);
        // Nothing asks for the ACT term by name either — the default is the contract.
        expect(src).not.toMatch(/access: 'act'/);
    });
});
