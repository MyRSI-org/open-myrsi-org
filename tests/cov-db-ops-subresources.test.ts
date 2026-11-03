import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SecurityDenial } from '../lib/errors';

// lib/db/ops.ts — the op-scoped CHILD resources: phases (with the completion
// cascade), schedule entries, tasks, command nodes, ship slots + seats, the tactical
// board (and its per-op channel), logistics and the AAR.
//
// The rule every child mutation is held to: it is addressed by an enumerable child
// id, so the write is ALSO scoped by operation_id (a foreign child id can't be hit by
// passing your own, verified, operationId), and a missing operationId refuses with no
// query. tests/operationSubResourceScoping.test.ts pins the UPDATE scoping; this suite
// covers the add/delete halves, the field mapping, the defaults and every fault path.
// tests/operationShipSeats.test.ts pins the seat guards' fail-closed reads; this suite
// extends around it.

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
vi.mock('../lib/ai', async () => ({ generateAARSummary: (await import('./cov-db-ops-fake')).collab.generateAARSummary }));

import {
    fake, resetFake, resetCollaborators, on, collab, queriesOn, writesOn, readsOn, argsOf, cols, eqs, payload, opUpdates,
} from './cov-db-ops-fake';
import {
    addOperationPhase, updateOperationPhase, deleteOperationPhase,
    addScheduleEntry, updateScheduleEntry, deleteScheduleEntry,
    addOperationTask, updateOperationTask, deleteOperationTask,
    addCommandNode, updateCommandNode, deleteCommandNode,
    addShipSlot, updateShipSlot, deleteShipSlot, assignSlot, applyForSlot, decideSlotApplication, removeSlotAssignment,
    clearSeatAssignmentsForUser,
    broadcastBoardAdd, broadcastBoardUpdate, broadcastBoardDelete, addBoardElement, updateBoardElement, deleteBoardElement, saveBoardLayout,
    addLogisticsItem, updateLogisticsItem, deleteLogisticsItem, fulfillLogisticsItem,
    addAAREntry, deleteAAREntry, generateAARDraftForOperation, submitAAR, reopenAAR,
} from '../lib/db/ops';

const OP = 'op-1';

beforeEach(() => {
    resetFake();
    resetCollaborators();
});

/** Assert a delete was scoped by BOTH the child id and the operation. */
function expectScopedDelete(table: string, id: number) {
    const del = writesOn(table, 'delete');
    expect(del, table).toHaveLength(1);
    expect(eqs(del[0])).toEqual([['id', id], ['operation_id', OP]]);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('phases', () => {
    it('add applies defaults and returns the narrow row', async () => {
        on('operation_phases', { data: { id: 1, name: 'Insert' } });
        await expect(addOperationPhase(OP, { name: 'Insert' })).resolves.toEqual({ id: 1, name: 'Insert' });
        const q = writesOn('operation_phases', 'insert')[0];
        expect(payload(q)).toEqual({ operation_id: OP, name: 'Insert', description: null, phase_type: 'sequential', sort_order: 0, status: 'Pending', color: null });
        expect(cols(q)).toBe('id, operation_id, name, description, phase_type, sort_order, status, color, created_at');
    });

    it('add keeps supplied values; a fault throws', async () => {
        await addOperationPhase(OP, { name: 'X', description: 'd', phaseType: 'contingency', sortOrder: 3, status: 'Active', color: '#f00' });
        expect(payload(writesOn('operation_phases', 'insert')[0])).toMatchObject({ description: 'd', phase_type: 'contingency', sort_order: 3, status: 'Active', color: '#f00' });
        on('operation_phases', { error: { message: 'x' } });
        await expect(addOperationPhase(OP, { name: 'X' })).rejects.toThrow('Failed to add phase');
    });

    it('update maps only supplied fields and reports no cascade for a non-completion edit', async () => {
        await expect(updateOperationPhase(4, { name: 'N', description: 'D', phaseType: 'sequential', sortOrder: 2, status: 'Active', color: 'c' }, OP))
            .resolves.toEqual({ cascadedTasks: 0, cascadedMilestones: 0 });
        const q = writesOn('operation_phases', 'update')[0];
        expect(payload(q)).toEqual({ name: 'N', description: 'D', phase_type: 'sequential', sort_order: 2, status: 'Active', color: 'c' });
        expect(eqs(q)).toEqual([['id', 4], ['operation_id', OP]]);
        expect(queriesOn('operation_tasks')).toHaveLength(0);
    });

    it('completion cascades to Pending/Active tasks and to Pending/Active/NULL milestones, counting each', async () => {
        on('operation_tasks', { data: [{ id: 1 }, { id: 2 }] });
        on('operation_schedule_entries', { data: [{ id: 9 }] }, { data: [{ id: 10 }, { id: 11 }] });
        await expect(updateOperationPhase(4, { status: 'Completed' }, OP)).resolves.toEqual({ cascadedTasks: 2, cascadedMilestones: 3 });
        const t = writesOn('operation_tasks', 'update')[0];
        expect(payload(t)).toEqual({ status: 'Completed' });
        expect(eqs(t)).toEqual([['operation_id', OP], ['phase_id', 4]]);
        expect(argsOf(t, 'in')).toEqual([['status', ['Pending', 'Active']]]);
        const [act, nul] = writesOn('operation_schedule_entries', 'update');
        expect(argsOf(act, 'in')).toEqual([['status', ['Pending', 'Active']]]);
        expect(argsOf(nul, 'is')).toEqual([['status', null]]);
        expect(eqs(nul)).toEqual([['operation_id', OP], ['phase_id', 4]]);
    });

    it('a cascade that touches nothing reports zero', async () => {
        await expect(updateOperationPhase(4, { status: 'Completed' }, OP)).resolves.toEqual({ cascadedTasks: 0, cascadedMilestones: 0 });
    });

    it.each([
        ['the phase write', [['operation_phases', 1]], 'Failed to update phase'],
        ['the task cascade', [['operation_tasks', 1]], 'Failed to cascade phase completion to tasks'],
        ['the milestone cascade', [['operation_schedule_entries', 1]], 'Failed to cascade phase completion to milestones'],
        ['the NULL-milestone cascade', [['operation_schedule_entries', 2]], 'Failed to cascade phase completion to milestones'],
    ] as const)('a fault in %s throws', async (_label, faults, msg) => {
        for (const [table, nth] of faults) {
            const results = Array.from({ length: nth - 1 }, () => ({ data: [] as unknown[] }));
            on(table, ...results, { error: { message: 'x' } });
        }
        await expect(updateOperationPhase(4, { status: 'Completed' }, OP)).rejects.toThrow(msg);
    });

    it('delete is scoped by op; a fault throws; no operationId refuses without a query', async () => {
        await deleteOperationPhase(4, OP);
        expectScopedDelete('operation_phases', 4);
        on('operation_phases', { error: { message: 'x' } });
        await expect(deleteOperationPhase(4, OP)).rejects.toThrow('Failed to delete phase');
        resetFake();
        await expect(deleteOperationPhase(4)).rejects.toThrow('deleteOperationPhase: operationId is required');
        await expect(updateOperationPhase(4, {})).rejects.toThrow('updateOperationPhase: operationId is required');
        expect(fake.queries).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('schedule entries', () => {
    it('add normalises an empty time to null and applies defaults', async () => {
        on('operation_schedule_entries', { data: { id: 3 } });
        await expect(addScheduleEntry(OP, { label: 'H-hour', scheduledTime: '' })).resolves.toEqual({ id: 3 });
        const q = writesOn('operation_schedule_entries', 'insert')[0];
        expect(payload(q)).toEqual({ operation_id: OP, label: 'H-hour', scheduled_time: null, phase_id: null, notes: null, status: null, sort_order: 0 });
        expect(cols(q)).toBe('id, operation_id, label, scheduled_time, phase_id, notes, status, sort_order, created_at');
    });

    it('add keeps supplied values; a fault throws', async () => {
        await addScheduleEntry(OP, { label: 'L', scheduledTime: 't', phaseId: 2, notes: 'n', status: 'Active', sortOrder: 5 });
        expect(payload(writesOn('operation_schedule_entries', 'insert')[0])).toMatchObject({ scheduled_time: 't', phase_id: 2, notes: 'n', status: 'Active', sort_order: 5 });
        on('operation_schedule_entries', { error: { message: 'x' } });
        await expect(addScheduleEntry(OP, { label: 'L' })).rejects.toThrow('Failed to add schedule entry');
    });

    it('update maps fields (empty time / phase clear to null)', async () => {
        await updateScheduleEntry(6, { label: 'L', scheduledTime: '', phaseId: 0, notes: 'n', status: 'Completed', sortOrder: 1 }, OP);
        const q = writesOn('operation_schedule_entries', 'update')[0];
        expect(payload(q)).toEqual({ label: 'L', scheduled_time: null, phase_id: null, notes: 'n', status: 'Completed', sort_order: 1 });
        expect(eqs(q)).toEqual([['id', 6], ['operation_id', OP]]);
        on('operation_schedule_entries', { error: { message: 'x' } });
        await expect(updateScheduleEntry(6, { label: 'L' }, OP)).rejects.toThrow('Failed to update schedule entry');
    });

    it('delete is scoped by op; faults throw; no operationId refuses', async () => {
        await deleteScheduleEntry(6, OP);
        expectScopedDelete('operation_schedule_entries', 6);
        on('operation_schedule_entries', { error: { message: 'x' } });
        await expect(deleteScheduleEntry(6, OP)).rejects.toThrow('Failed to delete schedule entry');
        await expect(deleteScheduleEntry(6)).rejects.toThrow('deleteScheduleEntry: operationId is required');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tasks', () => {
    it('add applies defaults', async () => {
        on('operation_tasks', { data: { id: 8 } });
        await expect(addOperationTask(OP, { title: 'Secure LZ' })).resolves.toEqual({ id: 8 });
        const q = writesOn('operation_tasks', 'insert')[0];
        expect(payload(q)).toEqual({
            operation_id: OP, title: 'Secure LZ', description: null, task_type: 'primary', assigned_unit_id: null,
            assigned_user_id: null, phase_id: null, status: 'Pending', priority: 'Normal', sort_order: 0,
        });
        expect(cols(q)).not.toMatch(/\*/);
    });

    it('add keeps supplied values; a fault throws', async () => {
        await addOperationTask(OP, { title: 'T', description: 'd', taskType: 'secondary', assignedUnitId: 2, assignedUserId: 4, phaseId: 1, status: 'Active', priority: 'High', sortOrder: 3 });
        expect(payload(writesOn('operation_tasks', 'insert')[0])).toMatchObject({ task_type: 'secondary', assigned_unit_id: 2, assigned_user_id: 4, phase_id: 1, status: 'Active', priority: 'High', sort_order: 3 });
        on('operation_tasks', { error: { message: 'x' } });
        await expect(addOperationTask(OP, { title: 'T' })).rejects.toThrow('Failed to add task');
    });

    it('update maps every field; assignment clears to null', async () => {
        await updateOperationTask(8, { title: 'T', description: 'D', taskType: 'assignment', assignedUnitId: 0, assignedUserId: null, phaseId: '', status: 'Failed', priority: 'Low', sortOrder: 9 }, OP);
        const q = writesOn('operation_tasks', 'update')[0];
        expect(payload(q)).toEqual({ title: 'T', description: 'D', task_type: 'assignment', assigned_unit_id: null, assigned_user_id: null, phase_id: null, status: 'Failed', priority: 'Low', sort_order: 9 });
        on('operation_tasks', { error: { message: 'x' } });
        await expect(updateOperationTask(8, { title: 'T' }, OP)).rejects.toThrow('Failed to update task');
    });

    it('delete is scoped by op; faults throw; no operationId refuses', async () => {
        await deleteOperationTask(8, OP);
        expectScopedDelete('operation_tasks', 8);
        on('operation_tasks', { error: { message: 'x' } });
        await expect(deleteOperationTask(8, OP)).rejects.toThrow('Failed to delete task');
        await expect(deleteOperationTask(8)).rejects.toThrow('deleteOperationTask: operationId is required');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('command nodes', () => {
    it('add applies defaults', async () => {
        on('operation_command_nodes', { data: { id: 2 } });
        await expect(addCommandNode(OP, { label: 'Actual' })).resolves.toEqual({ id: 2 });
        expect(payload(writesOn('operation_command_nodes', 'insert')[0])).toEqual({
            operation_id: OP, parent_id: null, label: 'Actual', node_type: 'position', assigned_user_id: null,
            assigned_unit_id: null, fleet_group_id: null, pos_x: 0, pos_y: 0, color: null, icon: null, sort_order: 0,
        });
    });

    it('add keeps supplied values; a fault throws', async () => {
        await addCommandNode(OP, { parentId: 1, label: 'L', nodeType: 'squad', assignedUserId: 4, assignedUnitId: 5, fleetGroupId: 6, posX: 10, posY: 20, color: 'c', icon: 'i', sortOrder: 2 });
        expect(payload(writesOn('operation_command_nodes', 'insert')[0])).toMatchObject({ parent_id: 1, node_type: 'squad', assigned_user_id: 4, assigned_unit_id: 5, fleet_group_id: 6, pos_x: 10, pos_y: 20, color: 'c', icon: 'i', sort_order: 2 });
        on('operation_command_nodes', { error: { message: 'x' } });
        await expect(addCommandNode(OP, { label: 'L' })).rejects.toThrow('Failed to add command node');
    });

    it('update maps every field; empty references and live status clear to null', async () => {
        await updateCommandNode(2, { parentId: 0, label: 'L', nodeType: 't', assignedUserId: 0, assignedUnitId: 0, fleetGroupId: 0, posX: 0, posY: 5, color: 'c', icon: 'i', sortOrder: 1, liveStatus: '' }, OP);
        expect(payload(writesOn('operation_command_nodes', 'update')[0])).toEqual({
            parent_id: null, label: 'L', node_type: 't', assigned_user_id: null, assigned_unit_id: null, fleet_group_id: null,
            pos_x: 0, pos_y: 5, color: 'c', icon: 'i', sort_order: 1, live_status: null,
        });
        on('operation_command_nodes', { error: { message: 'x' } });
        await expect(updateCommandNode(2, { label: 'x' }, OP)).rejects.toThrow('Failed to update command node');
    });

    it('delete is scoped by op; faults throw; no operationId refuses', async () => {
        await deleteCommandNode(2, OP);
        expectScopedDelete('operation_command_nodes', 2);
        on('operation_command_nodes', { error: { message: 'x' } });
        await expect(deleteCommandNode(2, OP)).rejects.toThrow('Failed to delete command node');
        await expect(deleteCommandNode(2)).rejects.toThrow('deleteCommandNode: operationId is required');
        await expect(updateCommandNode(2, {})).rejects.toThrow('updateCommandNode: operationId is required');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ship slots — authoring', () => {
    it('adds a top-level ship with sanitised, capped text and a clamped capacity', async () => {
        on('platform_ships', { data: { id: 3 } });
        on('operation_ship_slots', { count: 0 }, { data: { id: 50 } });
        await expect(addShipSlot(OP, { shipId: '3', label: '<b>Hammerhead</b>', seatRole: '<i>Gunner</i>', capacity: 9999, sortOrder: 'x', notes: '<p>bring ammo</p>' }))
            .resolves.toEqual({ id: 50 });
        const ins = writesOn('operation_ship_slots', 'insert')[0];
        expect(payload(ins)).toEqual({ operation_id: OP, parent_slot_id: null, ship_id: 3, label: 'Hammerhead', seat_role: 'Gunner', capacity: 500, sort_order: 0, notes: 'bring ammo' });
        expect(cols(ins)).toBe('id, operation_id, parent_slot_id, ship_id, label, seat_role, capacity, sort_order, notes, created_at, updated_at');
        const ship = readsOn('platform_ships')[0];
        expect(eqs(ship)).toEqual([['id', 3]]);
        const count = readsOn('operation_ship_slots')[0];
        expect(argsOf(count, 'select')[0]).toEqual(['id', { count: 'exact', head: true }]);
        expect(eqs(count)).toEqual([['operation_id', OP]]);
    });

    it('defaults: empty label → "Slot", no role / notes, capacity 1, numeric sort order kept', async () => {
        on('operation_ship_slots', { count: 0 });
        await addShipSlot(OP, { label: '<br>', capacity: 0, sortOrder: 4 });
        expect(payload(writesOn('operation_ship_slots', 'insert')[0])).toMatchObject({ ship_id: null, label: 'Slot', seat_role: null, capacity: 1, sort_order: 4, notes: null });
        expect(queriesOn('platform_ships')).toHaveLength(0);
    });

    it('a seat under a ship that holds no members is allowed and records the parent', async () => {
        on('operation_ship_slots', { data: { id: 7, parent_slot_id: null } }, { count: 0 });
        on('operation_slot_assignments', { count: 0 });
        await addShipSlot(OP, { parentSlotId: 7, label: 'Pilot', capacity: '2' });
        expect(payload(writesOn('operation_ship_slots', 'insert')[0])).toMatchObject({ parent_slot_id: 7, capacity: 2 });
        const hasAsg = readsOn('operation_slot_assignments')[0];
        expect(eqs(hasAsg)).toEqual([['slot_id', 7]]);
    });

    it('an unparseable ship reference is a SecurityDenial with no catalog read', async () => {
        const err = await addShipSlot(OP, { shipId: 'abc' }).catch((e) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('That ship reference is not valid.');
        expect(queriesOn('platform_ships')).toHaveLength(0);
        expect(writesOn('operation_ship_slots')).toHaveLength(0);
    });

    it('an unknown catalog ship is a SecurityDenial; a catalog read fault throws', async () => {
        on('platform_ships', { data: null }, { error: { message: 'x' } });
        await expect(addShipSlot(OP, { shipId: 99 })).rejects.toBeInstanceOf(SecurityDenial);
        await expect(addShipSlot(OP, { shipId: 99 })).rejects.toThrow('addShipSlot: failed to verify ship reference');
    });

    it('a slot-count fault throws; an insert fault throws', async () => {
        on('operation_ship_slots', { error: { message: 'x' } });
        await expect(addShipSlot(OP, { label: 'L' })).rejects.toThrow('Failed to count ship slots');
        on('operation_ship_slots', { count: 0 }, { error: { message: 'x' } });
        await expect(addShipSlot(OP, { label: 'L' })).rejects.toThrow('Failed to add ship slot');
    });

    it('an invalid parent id is a SecurityDenial; a parent read fault throws', async () => {
        await expect(addShipSlot(OP, { parentSlotId: -1 })).rejects.toBeInstanceOf(SecurityDenial);
        on('operation_ship_slots', { error: { message: 'x' } });
        await expect(addShipSlot(OP, { parentSlotId: 7 })).rejects.toThrow('addShipSlot: failed to resolve parent slot');
    });

    it('update requires operationId and maps every field', async () => {
        await expect(updateShipSlot(5, {})).rejects.toThrow('updateShipSlot: operationId is required');
        expect(fake.queries).toHaveLength(0);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        try {
            on('operation_ship_slots', { data: { id: 7, parent_slot_id: null } }, { count: 0 });
            on('platform_ships', { data: { id: 3 } });
            await updateShipSlot(5, { parentSlotId: 7, shipId: 3, label: '', seatRole: '', capacity: 3, sortOrder: 'x', notes: '' }, OP);
            const up = writesOn('operation_ship_slots', 'update')[0];
            expect(payload(up)).toEqual({ updated_at: '2026-06-01T12:00:00.000Z', parent_slot_id: 7, ship_id: 3, label: 'Slot', seat_role: null, capacity: 3, sort_order: 0, notes: null });
            expect(eqs(up)).toEqual([['id', 5], ['operation_id', OP]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('update: keeps a seat role / notes / numeric sort order, and can un-parent with null', async () => {
        await updateShipSlot(5, { parentSlotId: null, seatRole: 'Gunner', notes: 'n', sortOrder: 2, shipId: null }, OP);
        expect(payload(writesOn('operation_ship_slots', 'update')[0])).toMatchObject({ parent_slot_id: null, seat_role: 'Gunner', notes: 'n', sort_order: 2, ship_id: null });
        expect(queriesOn('platform_ships')).toHaveLength(0);
    });

    it('update refuses nesting a ship that has seats, and a slot under itself', async () => {
        on('operation_ship_slots', { data: { id: 7, parent_slot_id: null } }, { count: 2 });
        await expect(updateShipSlot(5, { parentSlotId: 7 }, OP)).rejects.toThrow('This ship has seats; remove them before nesting it under another ship.');
        await expect(updateShipSlot(5, { parentSlotId: 5 }, OP)).rejects.toThrow('A slot cannot be its own parent.');
        expect(writesOn('operation_ship_slots')).toHaveLength(0);
    });

    it('update: a write fault throws', async () => {
        on('operation_ship_slots', { error: { message: 'x' } });
        await expect(updateShipSlot(5, { label: 'L' }, OP)).rejects.toThrow('Failed to update ship slot');
    });

    it('delete is scoped by op; faults throw; no operationId refuses', async () => {
        await deleteShipSlot(5, OP);
        expectScopedDelete('operation_ship_slots', 5);
        on('operation_ship_slots', { error: { message: 'x' } });
        await expect(deleteShipSlot(5, OP)).rejects.toThrow('Failed to delete ship slot');
        await expect(deleteShipSlot(5)).rejects.toThrow('deleteShipSlot: operationId is required');
    });
});

describe('ship slots — seating', () => {
    it('assign: an already-seated member is re-saved without a capacity check (a full slot is fine)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        try {
            on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
            on('operation_participants', { data: { user_id: 4 } });
            on('operation_slot_assignments', { data: { status: 'assigned' } });
            await expect(assignSlot(OP, 5, 4, 1)).resolves.toEqual({ targetUserId: 4 });
            const up = writesOn('operation_slot_assignments', 'upsert')[0];
            expect(payload(up)).toEqual({ operation_id: OP, slot_id: 5, user_id: 4, status: 'assigned', user_ship_id: null, assigned_by: 1, updated_at: '2026-06-01T12:00:00.000Z' });
            expect(argsOf(up, 'upsert')[0][1]).toEqual({ onConflict: 'slot_id,user_id', ignoreDuplicates: false });
            // existing-status probe + upsert only: no head count.
            expect(readsOn('operation_slot_assignments')).toHaveLength(1);
            expect(opUpdates()).toEqual([{ operationId: OP }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('assign: a fault reading the existing seat, or writing it, throws', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_participants', { data: { user_id: 4 } });
        on('operation_slot_assignments', { error: { message: 'x' } });
        await expect(assignSlot(OP, 5, 4, 1)).rejects.toThrow('Failed to read seat assignment');

        on('operation_ship_slots', { data: { id: 5, capacity: 2 } }, { count: 0 });
        on('operation_participants', { data: { user_id: 4 } });
        on('operation_slot_assignments', { data: null }, { count: 0 }, { error: { message: 'x' } });
        await expect(assignSlot(OP, 5, 4, 1)).rejects.toThrow('Failed to assign seat');
    });

    it('assign refuses the ship itself when it has seats', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 3 });
        await expect(assignSlot(OP, 5, 4, 1)).rejects.toThrow('Assign members to a seat, not the ship itself.');
    });

    it('a non-integer slot id is a SecurityDenial before any read', async () => {
        await expect(assignSlot(OP, 'abc' as unknown as number, 4, 1)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(removeSlotAssignment(OP, 0, 4)).rejects.toBeInstanceOf(SecurityDenial);
        expect(fake.queries).toHaveLength(0);
    });

    it('a slot read fault throws (not a denial)', async () => {
        on('operation_ship_slots', { error: { message: 'x' } });
        await expect(removeSlotAssignment(OP, 5, 4)).rejects.toThrow('removeSlotAssignment: failed to resolve slot');
    });

    it('a slot row with no capacity reads as capacity 1', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: null } }, { count: 0 });
        on('operation_participants', { data: { user_id: 4 } });
        on('operation_slot_assignments', { data: null }, { count: 1 });
        await expect(assignSlot(OP, 5, 4, 1)).rejects.toThrow('This slot is full.');
    });

    it('apply: an already-assigned member short-circuits with no write', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_slot_assignments', { data: { status: 'assigned' } });
        await expect(applyForSlot(OP, 5, 4)).resolves.toEqual({ status: 'assigned' });
        expect(writesOn('operation_slot_assignments')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
    });

    it('apply: re-applying skips the open-application cap and upserts the application', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_slot_assignments', { data: { status: 'applied' } });
        await expect(applyForSlot(OP, 5, 4)).resolves.toEqual({ status: 'applied' });
        const up = writesOn('operation_slot_assignments', 'upsert')[0];
        expect(payload(up)).toMatchObject({ operation_id: OP, slot_id: 5, user_id: 4, status: 'applied', user_ship_id: null });
        expect(payload(up)).not.toHaveProperty('assigned_by');
        expect(readsOn('operation_slot_assignments')).toHaveLength(1);
        expect(opUpdates()).toEqual([{ operationId: OP }]);
    });

    it('apply: the open-application count is per (op, user, applied)', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_slot_assignments', { data: null }, { count: 0 });
        await applyForSlot(OP, 5, 4);
        const cnt = readsOn('operation_slot_assignments')[1];
        expect(eqs(cnt)).toEqual([['operation_id', OP], ['user_id', 4], ['status', 'applied']]);
    });

    it('apply refuses the ship itself; read / count / write faults throw', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 1 });
        await expect(applyForSlot(OP, 5, 4)).rejects.toThrow('Apply to a seat, not the ship itself.');

        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_slot_assignments', { error: { message: 'x' } });
        await expect(applyForSlot(OP, 5, 4)).rejects.toThrow('Failed to read seat assignment');

        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_slot_assignments', { data: null }, { error: { message: 'x' } });
        await expect(applyForSlot(OP, 5, 4)).rejects.toThrow('Failed to count open applications');

        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: 0 });
        on('operation_slot_assignments', { data: null }, { count: 0 }, { error: { message: 'x' } });
        await expect(applyForSlot(OP, 5, 4)).rejects.toThrow('Failed to apply for seat');
    });

    it('decide: no application refuses; a read fault throws', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } });
        on('operation_slot_assignments', { data: null });
        await expect(decideSlotApplication(OP, 5, 4, 'approve', 1)).rejects.toThrow('No application found for this seat.');

        on('operation_ship_slots', { data: { id: 5, capacity: 1 } });
        on('operation_slot_assignments', { error: { message: 'x' } });
        await expect(decideSlotApplication(OP, 5, 4, 'deny', 1)).rejects.toThrow('Failed to read seat application');
    });

    it('decide approve: promotes the application, stamped with the approver', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        try {
            on('operation_ship_slots', { data: { id: 5, capacity: 2 } });
            on('operation_slot_assignments', { data: { status: 'applied' } }, { count: 1 });
            on('operation_participants', { data: { user_id: 4 } });
            await decideSlotApplication(OP, 5, 4, 'approve', 1);
            const up = writesOn('operation_slot_assignments', 'update')[0];
            expect(payload(up)).toEqual({ status: 'assigned', assigned_by: 1, updated_at: '2026-06-01T12:00:00.000Z' });
            expect(eqs(up)).toEqual([['operation_id', OP], ['slot_id', 5], ['user_id', 4]]);
            expect(opUpdates()).toEqual([{ operationId: OP }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('decide: approve / deny write faults throw', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 2 } });
        on('operation_slot_assignments', { data: { status: 'applied' } }, { count: 0 }, { error: { message: 'x' } });
        on('operation_participants', { data: { user_id: 4 } });
        await expect(decideSlotApplication(OP, 5, 4, 'approve', 1)).rejects.toThrow('Failed to approve application');

        on('operation_ship_slots', { data: { id: 5, capacity: 2 } });
        on('operation_slot_assignments', { data: { status: 'applied' } }, { error: { message: 'x' } });
        await expect(decideSlotApplication(OP, 5, 4, 'deny', 1)).rejects.toThrow('Failed to decline application');
    });

    it('remove: deletes the (op, slot, user) row and emits; a fault throws', async () => {
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } });
        await removeSlotAssignment(OP, 5, 4);
        const del = writesOn('operation_slot_assignments', 'delete')[0];
        expect(eqs(del)).toEqual([['operation_id', OP], ['slot_id', 5], ['user_id', 4]]);
        expect(opUpdates()).toEqual([{ operationId: OP }]);

        on('operation_ship_slots', { data: { id: 5, capacity: 1 } });
        on('operation_slot_assignments', { error: { message: 'x' } });
        await expect(removeSlotAssignment(OP, 5, 4)).rejects.toThrow('Failed to remove seat assignment');
    });

    it('clearSeatAssignmentsForUser deletes only that member\'s seats on that op', async () => {
        await clearSeatAssignmentsForUser(OP, 4);
        expect(eqs(writesOn('operation_slot_assignments', 'delete')[0])).toEqual([['operation_id', OP], ['user_id', 4]]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tactical board', () => {
    it('board deltas ride the per-op channel, never the org-wide stream', async () => {
        await broadcastBoardAdd(OP, { id: 1, label: 'Alpha' }, 'nonce-1');
        await broadcastBoardUpdate(OP, 1, { posX: 5 });
        await broadcastBoardDelete(OP, 1);
        expect(fake.emits).toEqual([
            { channel: `op-board-${OP}`, event: 'board_element_update', payload: { operationId: OP, op: 'add', element: { id: 1, label: 'Alpha' }, clientNonce: 'nonce-1' } },
            { channel: `op-board-${OP}`, event: 'board_element_update', payload: { operationId: OP, op: 'update', elementId: 1, changes: { posX: 5 } } },
            { channel: `op-board-${OP}`, event: 'board_element_update', payload: { operationId: OP, op: 'delete', elementId: 1 } },
        ]);
        expect(opUpdates()).toEqual([]);
    });

    it('add applies defaults; supplied values are kept; a fault throws', async () => {
        on('operation_board_elements', { data: { id: 1 } });
        await expect(addBoardElement(OP, {})).resolves.toEqual({ id: 1 });
        const q = writesOn('operation_board_elements', 'insert')[0];
        expect(payload(q)).toEqual({ operation_id: OP, element_type: 'unit', label: null, pos_x: 0, pos_y: 0, width: null, height: null, rotation: 0, color: null, data: {}, layer: 0, sort_order: 0 });
        expect(cols(q)).toBe('id, operation_id, element_type, label, pos_x, pos_y, width, height, rotation, color, data, layer, sort_order, created_at');

        await addBoardElement(OP, { elementType: 'arrow', label: 'L', posX: 1, posY: 2, width: 3, height: 4, rotation: 45, color: 'c', data: { a: 1 }, layer: 2, sortOrder: 7 });
        expect(payload(writesOn('operation_board_elements', 'insert')[1])).toMatchObject({ element_type: 'arrow', label: 'L', width: 3, height: 4, rotation: 45, data: { a: 1 }, layer: 2, sort_order: 7 });

        on('operation_board_elements', { error: { message: 'x' } });
        await expect(addBoardElement(OP, {})).rejects.toThrow('Failed to add board element');
    });

    it('update maps every field; a fault throws; delete is op-scoped', async () => {
        await updateBoardElement(3, { elementType: 't', label: 'l', posX: 1, posY: 2, width: 3, height: 4, rotation: 5, color: 'c', data: {}, layer: 1, sortOrder: 2 }, OP);
        expect(payload(writesOn('operation_board_elements', 'update')[0])).toEqual({ element_type: 't', label: 'l', pos_x: 1, pos_y: 2, width: 3, height: 4, rotation: 5, color: 'c', data: {}, layer: 1, sort_order: 2 });
        on('operation_board_elements', { error: { message: 'x' } });
        await expect(updateBoardElement(3, { label: 'l' }, OP)).rejects.toThrow('Failed to update board element');

        resetFake();
        await deleteBoardElement(3, OP);
        expectScopedDelete('operation_board_elements', 3);
        on('operation_board_elements', { error: { message: 'x' } });
        await expect(deleteBoardElement(3, OP)).rejects.toThrow('Failed to delete board element');
        await expect(deleteBoardElement(3)).rejects.toThrow('deleteBoardElement: operationId is required');
    });

    it('saveBoardLayout diffs: reaps absent ids, updates present ones, inserts new ones', async () => {
        on('operation_board_elements', { data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        await saveBoardLayout(OP, [
            { id: 1, elementType: 'unit', label: 'Alpha', posX: 10 },
            { id: 3, label: null },
            { label: 'New one' },
            { id: 0, label: 'Also new' },
            // An id this op does not hold is neither updated nor inserted (no cross-op write).
            { id: 999, label: 'Foreign' },
        ]);
        const read = readsOn('operation_board_elements')[0];
        expect(cols(read)).toBe('id');
        expect(eqs(read)).toEqual([['operation_id', OP]]);

        const del = writesOn('operation_board_elements', 'delete');
        expect(del).toHaveLength(1);
        expect(argsOf(del[0], 'in')).toEqual([['id', [2]]]);

        const ups = writesOn('operation_board_elements', 'update');
        expect(ups.map((q) => eqs(q))).toEqual([[['id', 1]], [['id', 3]]]);
        expect(payload(ups[0])).toEqual({ operation_id: OP, element_type: 'unit', label: 'Alpha', pos_x: 10, pos_y: 0, width: null, height: null, rotation: 0, color: null, data: {}, layer: 0, sort_order: 0 });

        const ins = writesOn('operation_board_elements', 'insert');
        expect(ins).toHaveLength(1);
        expect((payload(ins[0]) as Array<{ label: string; operation_id: string }>).map((r) => [r.label, r.operation_id])).toEqual([['New one', OP], ['Also new', OP]]);
    });

    it('saveBoardLayout with nothing to reap or insert issues only the read + updates', async () => {
        on('operation_board_elements', { data: [{ id: 1 }] });
        await saveBoardLayout(OP, [{ id: 1 }]);
        expect(writesOn('operation_board_elements', 'delete')).toHaveLength(0);
        expect(writesOn('operation_board_elements', 'insert')).toHaveLength(0);
        expect(writesOn('operation_board_elements', 'update')).toHaveLength(1);
    });

    it.each([
        ['the existing-layout read', [{ error: { message: 'x' } }], [{ id: 1 }], 'Failed to load existing board layout'],
        ['the reap', [{ data: [{ id: 1 }] }, { error: { message: 'x' } }], [], 'Failed to reap removed board elements'],
        ['an update', [{ data: [{ id: 1 }] }, { error: { message: 'x' } }], [{ id: 1 }], 'Failed to update board element'],
        ['the insert', [{ data: null }, { error: { message: 'x' } }], [{ label: 'n' }], 'Failed to insert new board elements'],
    ])('saveBoardLayout: a fault in %s throws', async (_l, results, elements, msg) => {
        on('operation_board_elements', ...(results as Array<Record<string, unknown>>));
        await expect(saveBoardLayout(OP, elements as Record<string, unknown>[])).rejects.toThrow(msg);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('logistics', () => {
    it('add applies defaults; supplied values kept; a fault throws', async () => {
        on('operation_logistics', { data: { id: 1 } });
        await expect(addLogisticsItem(OP, { itemName: 'Medpens' })).resolves.toEqual({ id: 1 });
        const q = writesOn('operation_logistics', 'insert')[0];
        expect(payload(q)).toEqual({ operation_id: OP, item_name: 'Medpens', quantity_needed: 1, quantity_fulfilled: 0, category: 'general', status: 'Needed', notes: null });
        expect(cols(q)).toBe('id, operation_id, item_name, quantity_needed, quantity_fulfilled, fulfilled_by_user_id, category, status, notes, created_at');
        await addLogisticsItem(OP, { itemName: 'Ammo', quantityNeeded: 10, quantityFulfilled: 2, category: 'munitions', status: 'Partial', notes: 'n' });
        expect(payload(writesOn('operation_logistics', 'insert')[1])).toMatchObject({ quantity_needed: 10, quantity_fulfilled: 2, category: 'munitions', status: 'Partial', notes: 'n' });
        on('operation_logistics', { error: { message: 'x' } });
        await expect(addLogisticsItem(OP, { itemName: 'x' })).rejects.toThrow('Failed to add logistics item');
    });

    it('update maps the writable fields; a fault throws; delete is op-scoped', async () => {
        await updateLogisticsItem(4, { itemName: 'I', quantityNeeded: 5, quantityFulfilled: 1, category: 'c', status: 'Partial', notes: 'n' }, OP);
        expect(payload(writesOn('operation_logistics', 'update')[0])).toEqual({ item_name: 'I', quantity_needed: 5, quantity_fulfilled: 1, category: 'c', status: 'Partial', notes: 'n' });
        on('operation_logistics', { error: { message: 'x' } });
        await expect(updateLogisticsItem(4, { notes: 'n' }, OP)).rejects.toThrow('Failed to update logistics item');

        resetFake();
        await deleteLogisticsItem(4, OP);
        expectScopedDelete('operation_logistics', 4);
        on('operation_logistics', { error: { message: 'x' } });
        await expect(deleteLogisticsItem(4, OP)).rejects.toThrow('Failed to delete logistics item');
        await expect(deleteLogisticsItem(4)).rejects.toThrow('deleteLogisticsItem: operationId is required');
    });

    it.each([
        [{ quantity_fulfilled: 2, quantity_needed: 5 }, 3, 5, 'Fulfilled'],
        [{ quantity_fulfilled: 1, quantity_needed: 5 }, 1, 2, 'Partial'],
        [{ quantity_fulfilled: null, quantity_needed: 5 }, 0, 0, 'Needed'],
    ])('fulfil %o + %d → %d (%s), attributed to the actor', async (item, qty, total, status) => {
        on('operation_logistics', { data: item });
        await fulfillLogisticsItem(4, qty, 77, OP);
        const read = readsOn('operation_logistics')[0];
        expect(cols(read)).toBe('quantity_fulfilled, quantity_needed');
        expect(payload(writesOn('operation_logistics', 'update')[0])).toEqual({ quantity_fulfilled: total, fulfilled_by_user_id: 77, status });
    });

    it('fulfil: a missing item refuses; a write fault throws', async () => {
        on('operation_logistics', { data: null });
        await expect(fulfillLogisticsItem(4, 1, 77, OP)).rejects.toThrow('Logistics item not found');
        on('operation_logistics', { data: { quantity_fulfilled: 0, quantity_needed: 1 } }, { error: { message: 'x' } });
        await expect(fulfillLogisticsItem(4, 1, 77, OP)).rejects.toThrow('Failed to fulfill logistics item');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('AAR', () => {
    it('add attributes the entry to the dispatcher-forced actor, never a nested authorId', async () => {
        on('operation_aar_entries', { data: { id: 1 } });
        await expect(addAAREntry(OP, { userId: 5, authorId: 999, content: 'Went well' })).resolves.toEqual({ id: 1 });
        const q = writesOn('operation_aar_entries', 'insert')[0];
        expect(payload(q)).toEqual({ operation_id: OP, author_id: 5, category: 'observation', content: 'Went well' });
        expect(cols(q)).toBe('id, operation_id, author_id, category, content, upvotes, created_at');
        on('operation_aar_entries', { error: { message: 'x' } });
        await expect(addAAREntry(OP, { userId: 5, category: 'sustain', content: 'x' })).rejects.toThrow('Failed to add AAR entry');
    });

    it('delete is op-scoped; a fault throws; no operationId refuses', async () => {
        await deleteAAREntry(2, OP);
        expectScopedDelete('operation_aar_entries', 2);
        on('operation_aar_entries', { error: { message: 'x' } });
        await expect(deleteAAREntry(2, OP)).rejects.toThrow('Failed to delete AAR entry');
        await expect(deleteAAREntry(2)).rejects.toThrow('deleteAAREntry: operationId is required');
    });

    it('submit strips markup and stamps the submitter; reopen clears only the stamps', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        try {
            await submitAAR(OP, 5, '<script>alert(1)</script>Summary', '<b>Lessons</b>');
            const sub = writesOn('operations', 'update')[0];
            expect(payload(sub)).toEqual({ aar_summary: 'alert(1)Summary', aar_lessons_learned: 'Lessons', aar_submitted_at: '2026-06-01T12:00:00.000Z', aar_submitted_by: 5 });
            expect(eqs(sub)).toEqual([['id', OP]]);
            await reopenAAR(OP);
            expect(payload(writesOn('operations', 'update')[1])).toEqual({ aar_submitted_at: null, aar_submitted_by: null });
        } finally {
            vi.useRealTimers();
        }
        on('operations', { error: { message: 'x' } }, { error: { message: 'x' } });
        await expect(submitAAR(OP, 5, 's', 'l')).rejects.toThrow('Failed to submit AAR');
        await expect(reopenAAR(OP)).rejects.toThrow('Failed to reopen AAR');
    });

    describe('generateAARDraftForOperation', () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        });
        afterEach(() => { vi.useRealTimers(); });

        const opRow = (over: Record<string, unknown> = {}) => ({
            id: OP, name: 'Op', type: 'Combat', status: 'Concluded', description: 'd', scheduled_start: 's', scheduled_end: 'e',
            aar_ai_generated_at: null, location: { name: 'Yela' }, ...over,
        });

        it('feeds the model the op summary + entries, then stamps the generation time', async () => {
            on('operations', { data: opRow() });
            on('operation_participants', { count: 6 });
            on('operation_aar_entries', { data: [{ category: 'sustain', content: 'c1', author: { name: 'A' } }, { category: 'improve', content: 'c2', author: null }] });
            collab.generateAARSummary.mockResolvedValueOnce({ summary: 'Sum', lessonsLearned: 'LL' });

            await expect(generateAARDraftForOperation(OP)).resolves.toEqual({ summary: 'Sum', lessonsLearned: 'LL', aarAiGeneratedAt: '2026-06-01T12:00:00.000Z' });
            expect(collab.generateAARSummary).toHaveBeenCalledWith({
                name: 'Op', type: 'Combat', status: 'Concluded', description: 'd', scheduledStart: 's', scheduledEnd: 'e',
                location: 'Yela', participantCount: 6,
                entries: [{ category: 'sustain', content: 'c1', authorName: 'A' }, { category: 'improve', content: 'c2', authorName: undefined }],
            });
            const read = readsOn('operations')[0];
            expect(cols(read)).toBe('id, name, type, status, description, scheduled_start, scheduled_end, aar_ai_generated_at, location:locations!operations_location_id_fkey(name)');
            const entries = readsOn('operation_aar_entries')[0];
            expect(cols(entries)).toBe('category, content, author:users!operation_aar_entries_author_id_fkey(name)');
            expect(eqs(entries)).toEqual([['operation_id', OP]]);
            const stamp = writesOn('operations', 'update')[0];
            expect(payload(stamp)).toEqual({ aar_ai_generated_at: '2026-06-01T12:00:00.000Z' });
            expect(eqs(stamp)).toEqual([['id', OP]]);
        });

        it('inside the 3h cooldown: a coded error with retry time, and the model is never called', async () => {
            on('operations', { data: opRow({ aar_ai_generated_at: '2026-06-01T11:00:00Z' }) });
            const err = await generateAARDraftForOperation(OP).catch((e) => e);
            expect(err.message).toBe('AAR_COOLDOWN_ACTIVE');
            expect(err.code).toBe('AAR_COOLDOWN_ACTIVE');
            expect(err.retryAt).toBe('2026-06-01T14:00:00.000Z');
            expect(err.cooldownMs).toBe(2 * 60 * 60 * 1000);
            expect(collab.generateAARSummary).not.toHaveBeenCalled();
            expect(writesOn('operations')).toHaveLength(0);
        });

        it('after the cooldown the draft regenerates (no location / entries / count degrade cleanly)', async () => {
            on('operations', { data: opRow({ aar_ai_generated_at: '2026-06-01T08:00:00Z', location: null }) });
            await generateAARDraftForOperation(OP);
            expect(collab.generateAARSummary).toHaveBeenCalledWith(expect.objectContaining({ location: undefined, participantCount: 0, entries: [] }));
        });

        it('a load fault throws; a missing op refuses; a stamp fault throws', async () => {
            on('operations', { error: { message: 'x' } });
            await expect(generateAARDraftForOperation(OP)).rejects.toThrow('Failed to load operation for AAR draft');
            on('operations', { data: null });
            await expect(generateAARDraftForOperation(OP)).rejects.toThrow('Operation not found');
            on('operations', { data: opRow() }, { error: { message: 'x' } });
            await expect(generateAARDraftForOperation(OP)).rejects.toThrow('Failed to record AAR generation timestamp');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('edge shapes on the child writes', () => {
    it('partial updates write only the supplied column', async () => {
        await updateScheduleEntry(6, { notes: 'n' }, OP);
        await updateOperationTask(8, { status: 'Active' }, OP);
        await updateCommandNode(2, { posX: 3 }, OP);
        await updateBoardElement(3, { posY: 4 }, OP);
        await updateLogisticsItem(4, { status: 'Needed' }, OP);
        await updateOperationPhase(1, { color: 'blue' }, OP);
        expect([
            payload(writesOn('operation_schedule_entries', 'update')[0]),
            payload(writesOn('operation_tasks', 'update')[0]),
            payload(writesOn('operation_command_nodes', 'update')[0]),
            payload(writesOn('operation_board_elements', 'update')[0]),
            payload(writesOn('operation_logistics', 'update')[0]),
            payload(writesOn('operation_phases', 'update')[0]),
        ]).toEqual([{ notes: 'n' }, { status: 'Active' }, { pos_x: 3 }, { pos_y: 4 }, { status: 'Needed' }, { color: 'blue' }]);
    });

    it('markup-only seat role / notes collapse to NULL on add and update', async () => {
        on('operation_ship_slots', { count: 0 });
        await addShipSlot(OP, { label: 'L', seatRole: '<b></b>', notes: '<p></p>' });
        expect(payload(writesOn('operation_ship_slots', 'insert')[0])).toMatchObject({ seat_role: null, notes: null });
        await updateShipSlot(5, { seatRole: '<i></i>', notes: '<br>' }, OP);
        expect(payload(writesOn('operation_ship_slots', 'update')[0])).toMatchObject({ seat_role: null, notes: null });
    });

    it('a null head count is read as zero by every slot guard (null is not an error)', async () => {
        // addShipSlot under a parent: assignments probe null, slot-count null: allowed.
        on('operation_ship_slots', { data: { id: 7, parent_slot_id: null } }, { count: null });
        on('operation_slot_assignments', { count: null });
        await addShipSlot(OP, { parentSlotId: 7, label: 'Seat' });
        expect(writesOn('operation_ship_slots', 'insert')).toHaveLength(1);

        // assignSlot: child probe null, capacity count null: seats the member.
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: null });
        on('operation_participants', { data: { user_id: 4 } });
        on('operation_slot_assignments', { data: null }, { count: null });
        await expect(assignSlot(OP, 5, 4, 1)).resolves.toEqual({ targetUserId: 4 });

        // applyForSlot: open-application count null: applies.
        on('operation_ship_slots', { data: { id: 5, capacity: 1 } }, { count: null });
        on('operation_slot_assignments', { data: null }, { count: null });
        await expect(applyForSlot(OP, 5, 4)).resolves.toEqual({ status: 'applied' });

        // updateShipSlot re-parenting: child probe null: allowed.
        on('operation_ship_slots', { data: { id: 7, parent_slot_id: null } }, { count: null });
        await updateShipSlot(5, { parentSlotId: 7 }, OP);
        expect(payload(writesOn('operation_ship_slots', 'update').at(-1)!)).toMatchObject({ parent_slot_id: 7 });
    });
});
