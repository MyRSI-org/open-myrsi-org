import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// OPERATION SHIP SEATS — the guard contract.
//
// The port's whole risk profile is that hosted's version of this module reads the
// database to decide whether a write is allowed, and then swallows the read error.
// Three helpers do it — the capacity count and both structural probes — and every
// one of them degrades to the PERMISSIVE answer:
//
//   slotAssignedCount   → 0      ⇒ "0 >= capacity" is false ⇒ every slot is empty
//   slotHasChildren     → false  ⇒ "assign to a seat, not the ship" never fires
//   slotHasAssignments  → false  ⇒ seats get nested under a ship holding members,
//                                  orphaning those assignments
//
// A precondition whose read fault reads as "satisfied" is not a precondition, so
// each of the three is pinned twice: once for the guard, once for the fault.
//
// The other half is authorization. Hosted gates the member-facing seat actions on
// its own verifyOperationAccess, which is org-membership + existence. This build's
// verifyOperationAccess is existence-ONLY — the real gate moved to
// assertOpVisibleToUser (clearance + limiting markers + the special-op participant
// rule). Porting hosted's gate verbatim would reintroduce exactly the clearance
// bypass this build closed, on an action that reveals who is crewing an operation.

const h = vi.hoisted(() => ({
    resolveQuery: (() => ({ data: null as unknown, error: null as unknown, count: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: unknown },
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    emits: [] as Array<{ event: string; payload: unknown }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => { const q = { table, calls }; h.queries.push(q); return Promise.resolve(h.resolveQuery(q)); };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle().then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: unknown) => { h.emits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async () => [],
    };
});
vi.mock('../lib/db/operations-federation', () => ({
    bumpOperationVersion: vi.fn(async () => undefined),
    pushOperationToAllies: vi.fn(async () => undefined),
    scheduleAlliedPush: vi.fn(() => undefined),
}));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn(async () => undefined) }));
vi.mock('../lib/db/users', () => ({
    getUserById: vi.fn(async () => ({ id: 1, name: 'Actor' })),
    getActorLabel: vi.fn(async () => 'Actor'),
}));
vi.mock('../lib/db/notifications', () => ({ createNotification: vi.fn(async () => undefined) }));

import { addShipSlot, assignSlot, applyForSlot, decideSlotApplication, removeSlotAssignment } from '../lib/db/ops';

const OP = '11111111-1111-1111-1111-111111111111';

/**
 * Blank comments length-preservingly.
 *
 * Every ABSENCE assertion below ("no createNotification here", "no targetUserId
 * here") is about CODE, and the comment that explains each rule necessarily names
 * the thing being forbidden. Without this the tests match their own explanations
 * and pass no matter what the code does — which is the failure mode they exist to
 * catch, one level up.
 */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Route reads by table + shape. Anything unrouted resolves empty, never permissively. */
function route(opts: {
    slot?: { id: number; capacity: number } | null;
    parentSlot?: { id: number; parent_slot_id: number | null } | null;
    childCount?: number;
    assignedCount?: number;
    assignmentCount?: number;
    slotCount?: number;
    openApplications?: number;
    participant?: boolean;
    existingStatus?: string | null;
    shipOwner?: number | null;
    fault?: string;            // every read of this table fails
    // Only the HEAD COUNTS on this table fail. Load-bearing: assignSlot reads
    // operation_slot_assignments twice (the existing-status probe, then the capacity
    // count) and operation_ship_slots twice (loadSlotInOp, then the child probe).
    // Faulting the whole table makes the FIRST read throw, so a red-check of the
    // count guard's error handling passes for the wrong reason — the probe stays
    // green even with the guard removed. Ask me how I know.
    faultHead?: string;
} = {}) {
    h.resolveQuery = (q) => {
        const m = (name: string) => q.calls.some((c) => c.method === name);
        const eqCols = q.calls.filter((c) => c.method === 'eq').map((c) => String(c.args[0]));
        const isHead = q.calls.some((c) => c.method === 'select'
            && typeof c.args[1] === 'object' && c.args[1] !== null && (c.args[1] as { head?: boolean }).head === true);
        if (q.table === opts.fault) return { data: null, error: { message: 'connection reset' }, count: null };
        if (q.table === opts.faultHead && isHead) return { data: null, error: { message: 'connection reset' }, count: null };

        if (q.table === 'user_ships') return { data: opts.shipOwner == null ? null : { user_id: opts.shipOwner }, error: null };
        if (q.table === 'platform_ships') return { data: { id: 1 }, error: null };
        if (q.table === 'operation_participants') return { data: opts.participant ? { user_id: 9 } : null, error: null };

        if (q.table === 'operation_ship_slots') {
            if (isHead) {
                // Two head counts on this table: children-of-a-slot, and slots-per-op.
                return { data: null, error: null, count: eqCols.includes('parent_slot_id') ? (opts.childCount ?? 0) : (opts.slotCount ?? 0) };
            }
            if (m('insert')) return { data: { id: 50, label: 'x' }, error: null };
            if (m('update') || m('delete')) return { data: null, error: null };
            // A parent-slot probe selects parent_slot_id; loadSlotInOp selects capacity.
            const selectsParent = q.calls.some((c) => c.method === 'select' && String(c.args[0] ?? '').includes('parent_slot_id'));
            if (selectsParent) return { data: opts.parentSlot === undefined ? { id: 7, parent_slot_id: null } : opts.parentSlot, error: null };
            return { data: opts.slot === undefined ? { id: 5, capacity: 2 } : opts.slot, error: null };
        }

        if (q.table === 'operation_slot_assignments') {
            if (isHead) {
                if (eqCols.includes('status')) {
                    // Either the assigned-count cap or the open-application cap.
                    return { data: null, error: null, count: eqCols.includes('operation_id') ? (opts.openApplications ?? 0) : (opts.assignedCount ?? 0) };
                }
                return { data: null, error: null, count: opts.assignmentCount ?? 0 };
            }
            if (m('upsert') || m('update') || m('delete')) return { data: null, error: null };
            return { data: opts.existingStatus === undefined ? null : (opts.existingStatus === null ? null : { status: opts.existingStatus }), error: null };
        }
        return { data: null, error: null, count: 0 };
    };
}

beforeEach(() => { h.queries = []; h.emits = []; route(); });

describe('the three count guards FAIL CLOSED (hosted swallows all three)', () => {
    it('a capacity-count fault refuses the assignment instead of treating the slot as empty', async () => {
        // Hosted destructures only `count`, so this read fault would return 0 and the
        // "0 >= capacity" check would pass for EVERY caller — the cap silently off.
        // faultHead, not fault: the existing-status probe reads the same table first
        // and DOES check its error, so faulting the whole table would make this pass
        // whether or not slotAssignedCount handles its own.
        route({ participant: true, existingStatus: null, faultHead: 'operation_slot_assignments' });
        await expect(assignSlot(OP, 5, 9, 1)).rejects.toThrow();
    });

    it('a child-probe fault refuses rather than allowing a member onto the ship itself', async () => {
        // Same reasoning: loadSlotInOp reads operation_ship_slots first.
        route({ participant: true, existingStatus: null, faultHead: 'operation_ship_slots' });
        await expect(assignSlot(OP, 5, 9, 1)).rejects.toThrow();
    });

    it('an assignments-probe fault refuses rather than orphaning live assignments', async () => {
        // addShipSlot: nesting seats under a ship that already holds members would
        // strand them, and hosted's probe answers "no members" on any read fault.
        route({ faultHead: 'operation_slot_assignments' });
        await expect(addShipSlot(OP, { label: 'Gunner', parentSlotId: 7 })).rejects.toThrow();
    });

    it('…and each guard still does its job when the read SUCCEEDS', async () => {
        // The negative controls. Without these, every assertion above would pass if
        // the functions simply threw unconditionally.
        route({ participant: true, assignedCount: 2, slot: { id: 5, capacity: 2 } });
        await expect(assignSlot(OP, 5, 9, 1)).rejects.toThrow(/full/i);

        route({ participant: true, childCount: 1 });
        await expect(assignSlot(OP, 5, 9, 1)).rejects.toThrow(/seat, not the ship/i);

        route({ assignmentCount: 1 });
        await expect(addShipSlot(OP, { label: 'Gunner', parentSlotId: 7 })).rejects.toThrow(/Remove assigned members/i);
    });
});

describe('assignSlot requires an ACTIVE participant and enrolls nobody', () => {
    it('refuses a target who is not on the operation', async () => {
        route({ participant: false });
        await expect(assignSlot(OP, 5, 9, 1)).rejects.toThrow();
    });

    it('writes NO operation_participants row — the whole point of not porting ensureParticipant', async () => {
        // Hosted upserts the participant row here. 'operation:add_participant' is
        // excluded from the op-owner bypass precisely so an owner without
        // operations:manage cannot enroll members; an assign_slot that writes that
        // row is a rename of add_participant that walks around the exclusion.
        route({ participant: true, assignedCount: 0, existingStatus: null });
        await assignSlot(OP, 5, 9, 1);
        const writes = h.queries.filter((q) => q.table === 'operation_participants'
            && q.calls.some((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method)));
        expect(writes, 'assignSlot must never write to operation_participants').toEqual([]);
    });

    it('the participant check requires time_left IS NULL — a member who left is not seatable', async () => {
        route({ participant: true, assignedCount: 0, existingStatus: null });
        await assignSlot(OP, 5, 9, 1);
        const probe = h.queries.find((q) => q.table === 'operation_participants')!;
        expect(probe.calls.some((c) => c.method === 'is' && c.args[0] === 'time_left' && c.args[1] === null)).toBe(true);
    });

    it('verifies the chosen ship belongs to the TARGET, not the actor', async () => {
        // user_ships.id is enumerable and its rows carry custom_name / loadout_notes.
        route({ participant: true, shipOwner: 1234 });
        await expect(assignSlot(OP, 5, 9, 1, 77)).rejects.toThrow(/does not belong/i);
    });

    it('broadcasts an id-only operation_update, never seat content', async () => {
        route({ participant: true, assignedCount: 0, existingStatus: null });
        await assignSlot(OP, 5, 9, 1);
        const emit = h.emits.find((e) => e.event === 'operation_update');
        expect(emit, 'no operation_update emitted').toBeTruthy();
        expect(Object.keys(emit!.payload as object)).toEqual(['operationId']);
    });
});

describe('deciding an application is not the same act as removing a seat', () => {
    it('refuses to "deny" a member who is already ASSIGNED', async () => {
        // Hosted only checks that a row exists, so deny-against-assigned deletes a
        // seat holder — making decide a duplicate of remove_slot_assignment while
        // carrying a different owner-bypass rule.
        route({ existingStatus: 'assigned' });
        await expect(decideSlotApplication(OP, 5, 9, 'deny', 1)).rejects.toThrow(/already seated/i);
    });

    it('approving requires the applicant to be an active participant', async () => {
        route({ existingStatus: 'applied', participant: false });
        await expect(decideSlotApplication(OP, 5, 9, 'approve', 1)).rejects.toThrow();
    });

    it('approving still respects capacity', async () => {
        route({ existingStatus: 'applied', participant: true, assignedCount: 2, slot: { id: 5, capacity: 2 } });
        await expect(decideSlotApplication(OP, 5, 9, 'approve', 1)).rejects.toThrow(/full/i);
    });

    it('denying an actual application deletes it', async () => {
        route({ existingStatus: 'applied' });
        await decideSlotApplication(OP, 5, 9, 'deny', 1);
        expect(h.queries.some((q) => q.table === 'operation_slot_assignments' && q.calls.some((c) => c.method === 'delete'))).toBe(true);
    });
});

describe('slot ids are enumerable, so every seat write proves the slot is in THIS op', () => {
    it('refuses a slot that belongs to a different operation', async () => {
        route({ slot: null });
        await expect(assignSlot(OP, 999, 9, 1)).rejects.toThrow();
        await expect(applyForSlot(OP, 999, 9)).rejects.toThrow();
        await expect(removeSlotAssignment(OP, 999, 9)).rejects.toThrow();
        await expect(decideSlotApplication(OP, 999, 9, 'approve', 1)).rejects.toThrow();
    });

    it('scopes the lookup by operation_id, not by slot id alone', async () => {
        route({ participant: true, assignedCount: 0, existingStatus: null });
        await assignSlot(OP, 5, 9, 1);
        const lookup = h.queries.find((q) => q.table === 'operation_ship_slots'
            && q.calls.some((c) => c.method === 'maybeSingle'))!;
        const eqs = lookup.calls.filter((c) => c.method === 'eq').map((c) => String(c.args[0]));
        expect(eqs).toContain('id');
        expect(eqs, 'a slot lookup by id alone is a cross-operation read').toContain('operation_id');
    });

    it('a seat cannot be parented under another seat (max depth 2, and no cycles)', async () => {
        route({ parentSlot: { id: 7, parent_slot_id: 3 } });
        await expect(addShipSlot(OP, { label: 'Gunner', parentSlotId: 7 })).rejects.toThrow(/only be added to a ship/i);
    });

    it('a parent slot from another operation is refused', async () => {
        route({ parentSlot: null });
        await expect(addShipSlot(OP, { label: 'Gunner', parentSlotId: 7 })).rejects.toThrow();
    });
});

describe('member-driven writes are bounded', () => {
    it('caps open applications per operation', async () => {
        route({ existingStatus: null, openApplications: 10 });
        await expect(applyForSlot(OP, 5, 9)).rejects.toThrow(/open seat applications/i);
    });

    it('caps organiser-authored slots per operation', async () => {
        route({ slotCount: 200 });
        await expect(addShipSlot(OP, { label: 'Perseus' })).rejects.toThrow(/Slot limit reached/i);
    });

    it('applying does NOT consume capacity — only an assignment does', async () => {
        // A full slot must still accept applications, or the approve flow can never
        // be used to replace someone.
        route({ existingStatus: null, assignedCount: 99, slot: { id: 5, capacity: 1 } });
        await expect(applyForSlot(OP, 5, 9)).resolves.toEqual({ status: 'applied' });
    });

    it('sanitises the operator free text that the panel renders', async () => {
        route({ slotCount: 0 });
        await addShipSlot(OP, { label: '<img src=x onerror=alert(1)>Perseus', notes: '<b>hi</b>' });
        const insert = h.queries.find((q) => q.table === 'operation_ship_slots'
            && q.calls.some((c) => c.method === 'insert'))!;
        const row = insert.calls.find((c) => c.method === 'insert')!.args[0] as { label: string; notes: string | null };
        expect(row.label).not.toContain('<');
        expect(row.notes).not.toContain('<');
    });
});

describe('the wiring contracts', () => {
    const actions = codeOnly(readFileSync(resolve(__dirname, '..', 'api', 'actions', 'operations.ts'), 'utf8'));
    const services = codeOnly(readFileSync(resolve(__dirname, '..', 'api', 'services.ts'), 'utf8'));
    const ops = codeOnly(readFileSync(resolve(__dirname, '..', 'lib', 'db', 'ops.ts'), 'utf8'));

    const handler = (name: string) => {
        const start = actions.indexOf(`'operation:${name}': async`);
        expect(start, `handler operation:${name} not found`).toBeGreaterThan(-1);
        return actions.slice(start, actions.indexOf('\n    },', start));
    };

    it('the four MEMBER-IDENTITY seat actions use the clearance gate, not the existence check', () => {
        // verifyOperationAccess is existence-only in this build. Using it here — as
        // hosted does — lets a member who cannot see a restricted operation learn and
        // change who is crewing it.
        for (const a of ['assign_slot', 'decide_slot_application', 'remove_slot_assignment', 'apply_for_slot', 'withdraw_slot']) {
            const body = handler(a);
            expect(body, `${a} must gate on assertOpVisibleToUser`).toMatch(/await db\.assertOpVisibleToUser\(operationId, user\)/);
            expect(body, `${a} must NOT rely on the existence-only check`).not.toMatch(/verifyOperationAccess/);
        }
    });

    it('withdraw_slot acts on the FORCED userId and has no target field at all', () => {
        // targetUserId is not in ACTOR_ID_FIELDS, so reading one here would let any
        // member withdraw anyone else's seat through an operations:view action.
        const body = handler('withdraw_slot');
        expect(body).toMatch(/removeSlotAssignment\(operationId, slotId, userId\)/);
        expect(body).not.toMatch(/targetUserId/);
        const iface = actions.slice(actions.indexOf('interface WithdrawSlotPayload'), actions.indexOf('interface AddBoardElementPayload'));
        expect(iface).not.toMatch(/targetUserId/);
    });

    it('assigning notifies through the local helper, never a raw createNotification', () => {
        // notifyOperationAssignee carries the fail-closed participant precondition,
        // the self-skip and the generic body — notification rows are not
        // clearance-filtered at read time.
        const body = handler('assign_slot');
        expect(body).toMatch(/notifyOperationAssignee\(operationId, target, userId, 'seat'\)/);
        expect(body).not.toMatch(/createNotification/);
    });

    it('assign + decide are excluded from the op-owner bypass; remove is not', () => {
        // The list is a `new Set([...])`, so it closes on `]);`. Searching for `];`
        // runs past it into fullPermissionMap, where every one of these names appears
        // again — and the absence assertion below could then never fail.
        const start = services.indexOf('OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS');
        expect(start, 'the exclusion list was renamed').toBeGreaterThan(-1);
        const excl = services.slice(start, services.indexOf(']);', start));
        expect(excl, 'the slice must stop at the end of the Set').not.toContain('fullPermissionMap');
        expect(excl).toContain("'operation:assign_slot'");
        expect(excl).toContain("'operation:decide_slot_application'");
        expect(excl, 'removing a seat holder on your own op is not an escalation').not.toContain("'operation:remove_slot_assignment'");
    });

    it('all eight actions are in the permission map, split across the two tiers', () => {
        for (const a of ['add_ship_slot', 'update_ship_slot', 'delete_ship_slot', 'assign_slot', 'decide_slot_application', 'remove_slot_assignment']) {
            expect(services, `${a} tier`).toContain(`'operation:${a}': 'operations:manage'`);
        }
        for (const a of ['apply_for_slot', 'withdraw_slot']) {
            expect(services, `${a} tier`).toContain(`'operation:${a}': 'operations:view'`);
        }
    });

    it('the wire projection carries no assigned_by and no applicant embed', () => {
        // Rule 1: enumerate exactly what the consumer renders. "Which manager seated
        // whom" is rendered nowhere, and the panel resolves names from the roster it
        // is already displaying.
        const read = ops.slice(ops.indexOf("from('operation_slot_assignments').select("), ops.indexOf("'slot_assignments'"));
        expect(read).not.toMatch(/assigned_by/);
        expect(read).not.toMatch(/applicant:/);
    });

    it('the seat reads are in their OWN statement, so they cannot mask the uncapped fan-out', () => {
        // The order ratchet slices a chain from `.select(` to the next top-level `;`.
        // A capped read appended to the existing Promise.all array would appear inside
        // all ten siblings' chains and make every one of them read as capped —
        // removing ten genuinely-uncapped reads from the absolute rule.
        const fanOutEnd = ops.indexOf("'allied_participants'),");
        const seatRead = ops.indexOf("'ship_slots'),");
        expect(fanOutEnd).toBeGreaterThan(-1);
        expect(seatRead).toBeGreaterThan(fanOutEnd);
        expect(ops.slice(fanOutEnd, seatRead), 'the seat reads must start a new statement')
            .toMatch(/\]\);/);
    });
});

describe('seat visibility and egress', () => {
    const actions = codeOnly(readFileSync(resolve(__dirname, '..', 'api', 'actions', 'operations.ts'), 'utf8'));
    const fed = codeOnly(readFileSync(resolve(__dirname, '..', 'lib', 'db', 'operations-federation.ts'), 'utf8'));
    const ops = codeOnly(readFileSync(resolve(__dirname, '..', 'lib', 'db', 'ops.ts'), 'utf8'));

    it('pending applications are redacted in the HANDLER, not the db function', () => {
        // getFullOperationDetails takes no viewer and has three other callers: the
        // dispatcher's owner probe, the federation snapshot builder, and
        // get_participant_ships. A viewer-dependent filter inside it would break the
        // probe or leak into federation input.
        const details = actions.slice(actions.indexOf("'operation:get_details': async"), actions.indexOf("'operation:delete': async"));
        expect(details).toMatch(/a\.status !== 'applied' \|\| a\.userId === user\?\.id/);
        expect(details).toMatch(/\(slot\.assignments \|\| \[\]\)/);
        expect(ops.slice(ops.indexOf('export async function getFullOperationDetails'), ops.indexOf('export async function deleteOperation')))
            .not.toMatch(/status !== 'applied'/);
    });

    it('an inbound federation mirror cannot carry seats', () => {
        // The outbound projection is a construct-fresh allowlist, but the INBOUND side
        // has only a size bound — every HydratedOperation field is peer-injectable.
        // Seat rows hold bare LOCAL user ids that the panel resolves against the LOCAL
        // roster, so a hostile peer could invent seats and have our own UI render real
        // members' names in them.
        const fn = fed.slice(fed.indexOf('function boundedInboundSnapshot'), fed.indexOf('export async function receiveMirrorInvite'));
        expect(fn).toMatch(/delete \(snapshot as \{ shipSlots\?: unknown \}\)\.shipSlots/);
    });

    it('seats are dropped on BOTH departure paths, not just the rare one', () => {
        // The panel resolves names against ACTIVE participants. Concluding an
        // operation stamps time_left on everyone, so it — not an individual leave —
        // is the common way every seat would start rendering "User #N".
        const leaveStart = ops.indexOf('export async function leaveOperation');
        expect(leaveStart, 'leaveOperation was renamed').toBeGreaterThan(-1);
        const leave = ops.slice(leaveStart, ops.indexOf('export async function ', leaveStart + 10));
        expect(leave).toMatch(/clearSeatAssignmentsForUser\(operationId, userId\)/);
        const statusStart = ops.indexOf('export async function updateOperationStatus');
        expect(statusStart, 'updateOperationStatus was renamed').toBeGreaterThan(-1);
        const status = ops.slice(statusStart, ops.indexOf('export async function ', statusStart + 10));
        expect(status).toMatch(/clearSeatAssignmentsForOperation\(operationId\)/);
    });

    it('neither table is realtime-published — the seating chart is not an id-only nudge', () => {
        // postgres_changes ships the FULL row. An operation_slot_assignments row IS
        // the seating chart, keyed by user_id.
        const schema = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');
        const clientTables = schema.slice(schema.indexOf('rt_client_tables'), schema.indexOf('rt_client_tables') + 1200);
        expect(clientTables).not.toMatch(/operation_ship_slots|operation_slot_assignments/);
        // …and both carry an explicit deny-all, stated inline so a PARTIAL paste of
        // this file cannot leave them with RLS off.
        expect(schema).toMatch(/ALTER TABLE public\.operation_ship_slots ENABLE ROW LEVEL SECURITY/);
        expect(schema).toMatch(/ALTER TABLE public\.operation_slot_assignments ENABLE ROW LEVEL SECURITY/);
        expect(schema).toMatch(/CREATE POLICY "Service role only" ON public\.operation_slot_assignments FOR ALL TO public USING \(false\)/);
    });
});
