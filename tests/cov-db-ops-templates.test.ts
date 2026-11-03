import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/operation-templates.ts — saved operation plans.
//
// A template inherits the clearance of the op it was extracted from, so it is gated
// like an op (tests/operationTemplateClearance.test.ts pins the gate decisions). This
// suite pins the rest: the explicit projection and the row mapper, every fault path
// (a template read fault must surface, a missing table must not 500 the subset), the
// write-boundary sanitisation + validation, the duplicate-name mapping, extraction
// from a live op, and instantiation onto a new op.

vi.mock('../lib/db/common', async () => (await import('./cov-db-ops-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-ops-fake')).logMock);

import { fake, resetFake, on, queriesOn, writesOn, readsOn, argsOf, cols, eqs, payload } from './cov-db-ops-fake';
import {
    listOperationTemplates, getOperationTemplate, createOperationTemplate, updateOperationTemplate,
    deleteOperationTemplate, extractTemplatePayloadFromOperation, instantiateTemplateOnOperation,
    instantiatePayloadOnOperation, validateTemplatePayload,
} from '../lib/db/operation-templates';
import { validateTemplatePayload as pureValidator } from '../lib/operation-template-validate';
import { TaskPriority } from '../types';

const TEMPLATE_SELECT = 'id, name, description, created_by, created_at, updated_at, payload, classification_level, limiting_marker_ids, creator:users!operation_templates_created_by_fkey(name)';

const L0 = { clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: [] as string[] };
const L5 = { clearanceLevel: { level: 5 }, limitingMarkers: [{ id: 7 }], permissions: [] as string[] };

const row = (over: Record<string, unknown> = {}) => ({
    id: 1, name: 'Plan', description: 'Desc', created_by: 3, created_at: 'c', updated_at: 'u',
    payload: { phases: [{ name: 'P1' }] }, classification_level: 0, limiting_marker_ids: [], creator: { name: 'Author' }, ...over,
});

beforeEach(() => { resetFake(); });

describe('the re-export and the row mapper', () => {
    it('re-exports the pure validator unchanged', () => {
        expect(validateTemplatePayload).toBe(pureValidator);
    });

    it('maps a row field-by-field: creator object or array, empty description → undefined', async () => {
        on('operation_templates', { data: [row(), row({ id: 2, name: 'B', description: null, created_by: null, creator: [{ name: 'ArrAuthor' }] }), row({ id: 3, creator: null })] });
        const out = await listOperationTemplates(undefined);
        expect(out).toEqual([
            { id: 1, name: 'Plan', description: 'Desc', createdBy: 3, createdByName: 'Author', createdAt: 'c', updatedAt: 'u', payload: { phases: [{ name: 'P1' }] } },
            { id: 2, name: 'B', description: undefined, createdBy: undefined, createdByName: 'ArrAuthor', createdAt: 'c', updatedAt: 'u', payload: { phases: [{ name: 'P1' }] } },
            { id: 3, name: 'Plan', description: 'Desc', createdBy: 3, createdByName: undefined, createdAt: 'c', updatedAt: 'u', payload: { phases: [{ name: 'P1' }] } },
        ]);
        // The clearance columns are read for the gate but never mapped onto the wire.
        expect(JSON.stringify(out)).not.toContain('classification');
        expect(JSON.stringify(out)).not.toContain('limiting_marker');
    });
});

describe('listOperationTemplates', () => {
    it('reads the explicit projection ordered by name', async () => {
        on('operation_templates', { data: [] });
        await listOperationTemplates(L0);
        const q = queriesOn('operation_templates')[0];
        expect(cols(q)).toBe(TEMPLATE_SELECT);
        expect(argsOf(q, 'order')).toEqual([['name', { ascending: true }]]);
    });

    it('a missing templates table degrades to [] (the ops subset must still load)', async () => {
        on('operation_templates', { error: { code: 'PGRST205', message: 'not in schema cache' } });
        await expect(listOperationTemplates(L0)).resolves.toEqual([]);
    });

    it('null rows and null marker lists read as unclassified', async () => {
        on('operation_templates', { data: [row({ classification_level: null, limiting_marker_ids: null })] });
        await expect(listOperationTemplates(L0)).resolves.toHaveLength(1);
        on('operation_templates', { data: null });
        await expect(listOperationTemplates(L0)).resolves.toEqual([]);
    });

    it('a marker-compartmented template is hidden from a level-only viewer and shown to a holder', async () => {
        on('operation_templates', { data: [row({ classification_level: 2, limiting_marker_ids: ['7'] })] }, { data: [row({ classification_level: 2, limiting_marker_ids: ['7'] })] });
        await expect(listOperationTemplates({ ...L5, limitingMarkers: [] })).resolves.toEqual([]);
        await expect(listOperationTemplates(L5)).resolves.toHaveLength(1);
    });
});

describe('getOperationTemplate', () => {
    it('fetches by id with the explicit projection', async () => {
        on('operation_templates', { data: row({ id: 4 }) });
        await expect(getOperationTemplate(4)).resolves.toMatchObject({ id: 4, name: 'Plan' });
        const q = queriesOn('operation_templates')[0];
        expect(cols(q)).toBe(TEMPLATE_SELECT);
        expect(eqs(q)).toEqual([['id', 4]]);
    });

    it('not-found (PGRST116) → null; any other fault throws', async () => {
        on('operation_templates', { error: { code: 'PGRST116' } }, { error: { code: 'XX000' } });
        await expect(getOperationTemplate(4)).resolves.toBeNull();
        await expect(getOperationTemplate(4)).rejects.toThrow('Failed to fetch operation template');
    });

    it('a null viewer is still a client viewer: an above-clearance template reads as not-found', async () => {
        on('operation_templates', { data: row({ classification_level: 1 }) });
        await expect(getOperationTemplate(4, null)).resolves.toBeNull();
    });

    it('an empty read → null', async () => {
        on('operation_templates', { data: null });
        await expect(getOperationTemplate(4, L0)).resolves.toBeNull();
    });
});

describe('createOperationTemplate', () => {
    it('refuses an empty (or markup-only) name before any write', async () => {
        await expect(createOperationTemplate(3, '  <b></b> ', null, { phases: [] })).rejects.toThrow('Template name is required.');
        expect(fake.queries).toHaveLength(0);
    });

    it('validates the payload before any write', async () => {
        await expect(createOperationTemplate(3, 'Plan', null, { phases: [{ name: '' }] } as never)).rejects.toThrow('Phase #1 requires a non-empty name.');
        expect(fake.queries).toHaveLength(0);
    });

    it('writes the sanitised name/description, the validated payload and the creator', async () => {
        on('operation_templates', { data: row({ id: 9, name: 'Plan' }) });
        const tpl = await createOperationTemplate(3, '<i>Plan</i>', '<script>x</script>Notes', { phases: [{ name: '<b>Insert</b>', tasks: [{ title: 'T', priority: TaskPriority.High }] }] });
        const ins = writesOn('operation_templates', 'insert')[0];
        expect(payload(ins)).toEqual({
            name: 'Plan', description: 'xNotes', created_by: 3,
            payload: { phases: [{ name: 'Insert', tasks: [{ title: 'T', priority: 'High' }] }] },
            classification_level: 0, limiting_marker_ids: [],
        });
        expect(cols(ins)).toBe(TEMPLATE_SELECT);
        expect(tpl).toMatchObject({ id: 9, name: 'Plan' });
    });

    it('an empty description stores NULL', async () => {
        on('operation_templates', { data: row() });
        await createOperationTemplate(3, 'Plan', '', { phases: [] });
        expect((payload(writesOn('operation_templates', 'insert')[0]) as Record<string, unknown>).description).toBeNull();
    });

    it('stamps the inherited clearance: floored, never negative, numeric marker ids only', async () => {
        on('operation_templates', { data: row() }, { data: row() }, { data: row() });
        await createOperationTemplate(3, 'A', null, { phases: [] }, { classificationLevel: 3.9, markerIds: [7, '8', 'x', Number.NaN] });
        await createOperationTemplate(3, 'B', null, { phases: [] }, { classificationLevel: -4 });
        await createOperationTemplate(3, 'C', null, { phases: [] }, { classificationLevel: Number.NaN });
        const stamps = writesOn('operation_templates', 'insert').map((q) => {
            const p = payload(q) as Record<string, unknown>;
            return [p.classification_level, p.limiting_marker_ids];
        });
        expect(stamps).toEqual([[3, [7, 8]], [0, []], [0, []]]);
    });

    it('a duplicate name maps to TEMPLATE_NAME_TAKEN; other faults throw', async () => {
        on('operation_templates', { error: { code: '23505' } }, { error: { code: 'XX000' } });
        const err = await createOperationTemplate(3, 'Plan', null, { phases: [] }).catch((e) => e);
        expect(err.message).toBe('A template named "Plan" already exists.');
        expect(err.code).toBe('TEMPLATE_NAME_TAKEN');
        await expect(createOperationTemplate(3, 'Plan', null, { phases: [] })).rejects.toThrow('Failed to create operation template');
    });
});

describe('updateOperationTemplate', () => {
    it('server-internal (no viewer): patches only supplied, sanitised fields with no clearance read', async () => {
        on('operation_templates', { data: row({ name: 'New' }) });
        const tpl = await updateOperationTemplate(4, { name: ' <b>New</b> ', description: '', payload: { phases: [{ name: 'X' }] } });
        expect(readsOn('operation_templates')).toHaveLength(0);
        const up = writesOn('operation_templates', 'update')[0];
        expect(payload(up)).toEqual({ name: 'New', description: null, payload: { phases: [{ name: 'X' }] } });
        expect(eqs(up)).toEqual([['id', 4]]);
        expect(cols(up)).toBe(TEMPLATE_SELECT);
        expect(tpl.name).toBe('New');
    });

    it('description-only patch leaves name and payload untouched', async () => {
        on('operation_templates', { data: row() });
        await updateOperationTemplate(4, { description: '<p>d</p>' });
        expect(payload(writesOn('operation_templates', 'update')[0])).toEqual({ description: 'd' });
    });

    it('refuses an emptied name and an invalid payload before writing', async () => {
        await expect(updateOperationTemplate(4, { name: '   ' })).rejects.toThrow('Template name cannot be empty.');
        await expect(updateOperationTemplate(4, { payload: { phases: 'x' } as never })).rejects.toThrow('Template payload.phases must be an array.');
        expect(writesOn('operation_templates')).toHaveLength(0);
    });

    it('with a viewer, the clearance read is narrow and a read fault refuses', async () => {
        on('operation_templates', { error: { message: 'x' } });
        await expect(updateOperationTemplate(4, { name: 'N' }, L0)).rejects.toThrow('Failed to verify operation template clearance');
        expect(writesOn('operation_templates')).toHaveLength(0);
        const probe = readsOn('operation_templates')[0];
        expect(cols(probe)).toBe('classification_level, limiting_marker_ids');
        expect(eqs(probe)).toEqual([['id', 4]]);
    });

    it('a duplicate name maps to TEMPLATE_NAME_TAKEN; other faults throw', async () => {
        on('operation_templates', { error: { code: '23505' } }, { error: { code: 'XX000' } });
        const err = await updateOperationTemplate(4, { name: 'Dup' }).catch((e) => e);
        expect(err.code).toBe('TEMPLATE_NAME_TAKEN');
        expect(err.message).toBe('A template with that name already exists.');
        await expect(updateOperationTemplate(4, { name: 'Dup' })).rejects.toThrow('Failed to update operation template');
    });
});

describe('deleteOperationTemplate', () => {
    it('deletes by id; a fault throws', async () => {
        await deleteOperationTemplate(4);
        expect(eqs(writesOn('operation_templates', 'delete')[0])).toEqual([['id', 4]]);
        on('operation_templates', { error: { message: 'x' } });
        await expect(deleteOperationTemplate(4)).rejects.toThrow('Failed to delete operation template');
    });

    it('a clearance-read fault refuses the delete', async () => {
        on('operation_templates', { error: { message: 'x' } });
        await expect(deleteOperationTemplate(4, L0)).rejects.toThrow('Failed to verify operation template clearance');
        expect(writesOn('operation_templates', 'delete')).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('extractTemplatePayloadFromOperation', () => {
    const queueOp = (start: string | null, phases: unknown[], tasks: unknown[], entries: unknown[]) => {
        on('operations', { data: { id: 'op-1', scheduled_start: start } });
        on('operation_phases', { data: phases });
        on('operation_tasks', { data: tasks });
        on('operation_schedule_entries', { data: entries });
    };

    it('reads four op-scoped, explicit projections ordered by sort_order', async () => {
        queueOp(null, [], [], []);
        await expect(extractTemplatePayloadFromOperation('op-1')).resolves.toEqual({ phases: [] });
        expect(cols(queriesOn('operations')[0])).toBe('id, scheduled_start');
        expect(eqs(queriesOn('operations')[0])).toEqual([['id', 'op-1']]);
        for (const [t, c] of [
            ['operation_phases', 'id, name, description, phase_type, color, sort_order'],
            ['operation_tasks', 'id, title, description, task_type, priority, phase_id, sort_order'],
            ['operation_schedule_entries', 'id, label, notes, scheduled_time, phase_id, sort_order'],
        ]) {
            const q = queriesOn(t)[0];
            expect(cols(q), t).toBe(c);
            expect(eqs(q), t).toEqual([['operation_id', 'op-1']]);
            expect(argsOf(q, 'order'), t).toEqual([['sort_order']]);
        }
    });

    it('shapes phases with their tasks + milestones, bundling unphased items under "General"', async () => {
        queueOp('2026-06-01T10:00:00Z',
            [{ id: 1, name: 'Insert', description: 'go', phase_type: 'sequential', color: '#0f0', sort_order: 0 },
                { id: 2, name: 'Exfil', description: null, phase_type: null, color: null, sort_order: 1 }],
            [{ id: 10, title: 'Loose task', description: null, task_type: null, priority: null, phase_id: null },
                { id: 11, title: 'Secure LZ', description: 'd', task_type: 'primary', priority: 'High', phase_id: 1 }],
            [{ id: 20, label: 'H-hour', notes: 'n', scheduled_time: '2026-06-01T10:30:00Z', phase_id: 1 },
                { id: 21, label: 'Before', notes: null, scheduled_time: '2026-06-01T09:45:00Z', phase_id: 2 },
                { id: 22, label: 'Bad time', notes: null, scheduled_time: 'not-a-date', phase_id: 2 }]);
        const out = await extractTemplatePayloadFromOperation('op-1');
        expect(out).toEqual({
            phases: [
                { name: 'General', tasks: [{ title: 'Loose task' }] },
                {
                    name: 'Insert', description: 'go', phaseType: 'sequential', color: '#0f0',
                    milestones: [{ label: 'H-hour', notes: 'n', offsetMinutes: 30 }],
                    tasks: [{ title: 'Secure LZ', description: 'd', taskType: 'primary', priority: 'High' }],
                },
                { name: 'Exfil', milestones: [{ label: 'Before', offsetMinutes: -15 }, { label: 'Bad time' }] },
            ],
        });
    });

    it('without a scheduled start, milestones carry no offset; an unphased milestone alone creates "General"', async () => {
        queueOp(null, [], [], [{ id: 20, label: 'Loose', notes: null, scheduled_time: '2026-06-01T10:30:00Z', phase_id: null }]);
        await expect(extractTemplatePayloadFromOperation('op-1')).resolves.toEqual({ phases: [{ name: 'General', milestones: [{ label: 'Loose' }] }] });
    });

    it('null child reads are treated as empty', async () => {
        on('operations', { data: null });
        on('operation_phases', { data: null });
        on('operation_tasks', { data: null });
        on('operation_schedule_entries', { data: null });
        await expect(extractTemplatePayloadFromOperation('op-1')).resolves.toEqual({ phases: [] });
    });

    it.each([
        ['operations', 'Failed to load operation for template extraction'],
        ['operation_phases', 'Failed to load phases for template extraction'],
        ['operation_tasks', 'Failed to load tasks for template extraction'],
        ['operation_schedule_entries', 'Failed to load milestones for template extraction'],
    ])('a fault reading %s throws "%s"', async (table, msg) => {
        on(table, { error: { message: 'x' } });
        await expect(extractTemplatePayloadFromOperation('op-1')).rejects.toThrow(msg);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('instantiation', () => {
    it('instantiateTemplateOnOperation: an unknown template refuses with no writes', async () => {
        on('operation_templates', { error: { code: 'PGRST116' } });
        await expect(instantiateTemplateOnOperation('op-1', 4)).rejects.toThrow('Template not found.');
        expect(writesOn('operation_phases')).toHaveLength(0);
    });

    it('instantiateTemplateOnOperation: server-internal call materialises the stored payload', async () => {
        on('operation_templates', { data: row({ payload: { phases: [{ name: 'Only' }] }, classification_level: 9 }) });
        on('operation_phases', { data: { id: 70 } });
        await expect(instantiateTemplateOnOperation('op-1', 4)).resolves.toEqual({ phases: 1, tasks: 0, milestones: 0 });
    });

    it('materialises phases → tasks → milestones in order, scheduling offsets against the start', async () => {
        on('operation_phases', { data: { id: 101 } }, { data: { id: 102 } });
        const res = await instantiatePayloadOnOperation('op-1', {
            phases: [
                {
                    name: 'Insert', description: 'go', phaseType: 'contingency', color: '#f00',
                    tasks: [{ title: 'T1', description: 'd', taskType: 'secondary', priority: TaskPriority.High }, { title: 'T2' }],
                    milestones: [{ label: 'H', notes: 'n', offsetMinutes: 30 }, { label: 'No offset' }, { label: 'Before', offsetMinutes: -10 }],
                },
                { name: 'Exfil' },
            ],
        }, { scheduledStart: '2026-06-01T10:00:00Z' });
        expect(res).toEqual({ phases: 2, tasks: 2, milestones: 2 });

        const phases = writesOn('operation_phases', 'insert');
        expect(phases.map((q) => payload(q))).toEqual([
            { operation_id: 'op-1', name: 'Insert', description: 'go', phase_type: 'contingency', color: '#f00', sort_order: 0, status: 'Pending' },
            { operation_id: 'op-1', name: 'Exfil', description: null, phase_type: 'sequential', color: null, sort_order: 1, status: 'Pending' },
        ]);
        expect(cols(phases[0])).toBe('id');

        expect(payload(writesOn('operation_tasks', 'insert')[0])).toEqual([
            { operation_id: 'op-1', phase_id: 101, title: 'T1', description: 'd', task_type: 'secondary', priority: 'High', status: 'Pending', sort_order: 0 },
            { operation_id: 'op-1', phase_id: 101, title: 'T2', description: null, task_type: 'primary', priority: 'Normal', status: 'Pending', sort_order: 1 },
        ]);
        expect(payload(writesOn('operation_schedule_entries', 'insert')[0])).toEqual([
            { operation_id: 'op-1', phase_id: 101, label: 'H', notes: 'n', scheduled_time: '2026-06-01T10:30:00.000Z', sort_order: 0 },
            { operation_id: 'op-1', phase_id: 101, label: 'Before', notes: null, scheduled_time: '2026-06-01T09:50:00.000Z', sort_order: 2 },
        ]);
        // The second phase had no children → no further child inserts.
        expect(writesOn('operation_tasks', 'insert')).toHaveLength(1);
        expect(writesOn('operation_schedule_entries', 'insert')).toHaveLength(1);
    });

    it('without a scheduled start no milestone can be materialised (scheduled_time is NOT NULL)', async () => {
        on('operation_phases', { data: { id: 101 } });
        await expect(instantiatePayloadOnOperation('op-1', { phases: [{ name: 'P', milestones: [{ label: 'H', offsetMinutes: 5 }] }] }))
            .resolves.toEqual({ phases: 1, tasks: 0, milestones: 0 });
        expect(queriesOn('operation_schedule_entries')).toHaveLength(0);
    });

    it('re-validates an in-memory payload (the wizard\'s inline tree) before writing anything', async () => {
        await expect(instantiatePayloadOnOperation('op-1', { phases: [{ name: 'P', tasks: [{ title: 'T', priority: 'Urgent' }] }] } as never))
            .rejects.toThrow('Task #1 of phase "P" has invalid priority "Urgent".');
        expect(fake.queries).toHaveLength(0);
    });

    it.each([
        ['operation_phases', 'Failed to create phase from template'],
        ['operation_tasks', 'Failed to create tasks from template'],
        ['operation_schedule_entries', 'Failed to create milestones from template'],
    ])('a fault inserting %s throws "%s"', async (table, msg) => {
        if (table !== 'operation_phases') on('operation_phases', { data: { id: 101 } });
        on(table, { error: { message: 'x' } });
        await expect(instantiatePayloadOnOperation('op-1', {
            phases: [{ name: 'P', tasks: [{ title: 'T' }], milestones: [{ label: 'M', offsetMinutes: 0 }] }],
        }, { scheduledStart: '2026-06-01T10:00:00Z' })).rejects.toThrow(msg);
    });
});
