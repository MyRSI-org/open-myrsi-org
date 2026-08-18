import { supabase, handleSupabaseError, safeFetch } from './common.js';
import { validateTemplatePayload } from '../operation-template-validate.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { passesClearance, type ClearanceUser } from '../clearance.js';
import type { Tables } from './rows.js';
import type {
    OperationTemplate,
    OperationTemplatePayload,
    OperationTemplatePhase,
    OperationTemplateMilestone,
    OperationTemplateTask,
    TaskPriority,
} from '../../types.js';

// operation_templates row plus the joined creator name embed.
type TemplateRow = Tables<'operation_templates'> & {
    // PostgREST returns a to-one embed as an object at runtime, but the explicit
    // select string types it as an array — accept both shapes.
    creator?: { name?: string | null } | { name?: string | null }[] | null;
    // Generated types lag the clearance columns on operation_templates.
    classification_level?: number | null;
    limiting_marker_ids?: Array<number | string> | null;
};

// A template carries the clearance of the operation it was extracted from, so it
// is gated like an op: the viewer's clearance must cover the level and every
// marker. Operations managers / Admin bypass.
function templateVisibleTo(viewer: ClearanceUser | null | undefined, row: TemplateRow): boolean {
    return passesClearance(
        viewer,
        row.classification_level ?? 0,
        (row.limiting_marker_ids ?? []).map(id => ({ id })),
        ['operations:manage'],
    );
}

// Mutation twin of the read gate. The read paths (list/get) already hide a
// template the viewer's clearance can't cover, but the mutation paths are gated
// only by 'operations:create' — a LOWER bar than the 'operations:manage' bypass
// inside templateVisibleTo. Without this, a clearance-0 holder of
// operations:create who learns a template id (they are small serial ints, and
// every template mutation broadcasts one) could overwrite or delete a classified
// template — and, because update re-selects the row, read back the full payload
// (every phase/task/milestone of the source op) that template:get denies them.
// Same reasoning as updateWikiPage/deleteWikiPage in lib/db/wiki.ts.
//
// `viewer` undefined = server-internal caller (no gate), matching
// getOperationTemplate. A missing row soft-passes so the caller surfaces its
// normal not-found/no-op path rather than a misleading clearance error.
async function assertTemplateVisible(id: number, viewer?: ClearanceUser | null): Promise<void> {
    if (viewer === undefined) return;
    const { data, error } = await supabase
        .from('operation_templates')
        .select('classification_level, limiting_marker_ids')
        .eq('id', id)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to verify operation template clearance' });
    if (!data) return;
    if (!templateVisibleTo(viewer, data as TemplateRow)) {
        throw new Error('You are not cleared to modify this operation template.');
    }
}

// Re-export so existing call sites in lib/db.ts (`export * from './db/operation-templates.js'`)
// continue to expose validateTemplatePayload to the rest of the server.
export { validateTemplatePayload };

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function toTemplate(row: TemplateRow | null): OperationTemplate | null {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description || undefined,
        createdBy: row.created_by ?? undefined,
        createdByName: (Array.isArray(row.creator) ? row.creator[0] : row.creator)?.name || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: row.payload as unknown as OperationTemplatePayload,
    };
}

// Explicit columns (never '*'): a const-defined wildcard evades the wildcard
// ratchet + the no-select-* lint, and is "one missed mapper away" from leaking a
// future column.
const TEMPLATE_SELECT = 'id, name, description, created_by, created_at, updated_at, payload, classification_level, limiting_marker_ids, creator:users!operation_templates_created_by_fkey(name)';

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listOperationTemplates(viewer?: ClearanceUser | null): Promise<OperationTemplate[]> {
    // safeFetch swallows PGRST205 (table missing from PostgREST schema cache)
    // and 42P01 (table doesn't exist yet) so the operations subset still loads
    // when the templates migration hasn't fully propagated. The op center
    // tolerates an empty templates list; it would not tolerate the whole
    // subset request 500ing.
    const query = supabase
        .from('operation_templates')
        .select(TEMPLATE_SELECT)
        .order('name', { ascending: true });
    const data = await safeFetch<TemplateRow[]>(query, [], 'Failed to list operation templates');
    return (data || [])
        .filter(r => templateVisibleTo(viewer, r))
        .map(toTemplate)
        .filter(Boolean) as OperationTemplate[];
}

// `viewer` undefined = server-internal caller (no clearance gate). When a viewer
// is passed (the client get path), a template the viewer's clearance can't cover
// reads as not-found.
export async function getOperationTemplate(id: number, viewer?: ClearanceUser | null): Promise<OperationTemplate | null> {
    const { data, error } = await supabase
        .from('operation_templates')
        .select(TEMPLATE_SELECT)
        .eq('id', id)
        .single();
    if (error?.code === 'PGRST116') return null;
    handleSupabaseError({ error, message: 'Failed to fetch operation template' });
    if (data && viewer !== undefined && !templateVisibleTo(viewer, data as TemplateRow)) return null;
    return toTemplate(data);
}

export async function createOperationTemplate(
    userId: number,
    name: string,
    description: string | null,
    payload: OperationTemplatePayload,
    // Clearance the template inherits (from the source op when extracted, derived
    // server-side). Omitted for hand-authored/imported templates → unclassified.
    clearance?: { classificationLevel?: number; markerIds?: Array<number | string> },
): Promise<OperationTemplate> {
    // Strip markup + cap the template name/description too (the validator covers
    // the payload; these arrive as separate args).
    const trimmed = stripHtmlSingleLine(name, 200);
    if (!trimmed) throw new Error('Template name is required.');
    const validated = validateTemplatePayload(payload);

    const { data, error } = await supabase
        .from('operation_templates')
        .insert({
            name: trimmed,
            description: stripHtml(description, 4000) || null,
            created_by: userId,
            payload: validated,
            classification_level: Math.max(0, Math.floor(Number(clearance?.classificationLevel ?? 0))) || 0,
            limiting_marker_ids: (clearance?.markerIds ?? []).map(m => Number(m)).filter(n => Number.isFinite(n)),
        })
        .select(TEMPLATE_SELECT)
        .single();
    if (error?.code === '23505') {
        const err: Error & { code?: string } = new Error(`A template named "${trimmed}" already exists.`);
        err.code = 'TEMPLATE_NAME_TAKEN';
        throw err;
    }
    handleSupabaseError({ error, message: 'Failed to create operation template' });
    return toTemplate(data) as OperationTemplate;
}

export async function updateOperationTemplate(
    id: number,
    updates: { name?: string; description?: string | null; payload?: OperationTemplatePayload },
    viewer?: ClearanceUser | null,
): Promise<OperationTemplate> {
    await assertTemplateVisible(id, viewer);
    const patch: { name?: string; description?: string | null; payload?: OperationTemplatePayload } = {};
    if (updates.name !== undefined) {
        const trimmed = stripHtmlSingleLine(updates.name, 200);
        if (!trimmed) throw new Error('Template name cannot be empty.');
        patch.name = trimmed;
    }
    if (updates.description !== undefined) patch.description = stripHtml(updates.description, 4000) || null;
    if (updates.payload !== undefined) patch.payload = validateTemplatePayload(updates.payload);

    const { data, error } = await supabase
        .from('operation_templates')
        .update(patch)
        
        .eq('id', id)
        .select(TEMPLATE_SELECT)
        .single();
    if (error?.code === '23505') {
        const err: Error & { code?: string } = new Error(`A template with that name already exists.`);
        err.code = 'TEMPLATE_NAME_TAKEN';
        throw err;
    }
    handleSupabaseError({ error, message: 'Failed to update operation template' });
    return toTemplate(data) as OperationTemplate;
}

export async function deleteOperationTemplate(id: number, viewer?: ClearanceUser | null): Promise<void> {
    await assertTemplateVisible(id, viewer);
    const { error } = await supabase
        .from('operation_templates')
        .delete()
        
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete operation template' });
}

// ---------------------------------------------------------------------------
// Extract from existing operation
// ---------------------------------------------------------------------------
// Reads an existing operation's phases, tasks, and schedule entries and shapes
// them into a template payload. Unphased tasks/milestones are bundled under a
// synthetic phase named "General" so the template stays a flat list of phases.
// Milestone offsets are computed relative to the operation's scheduled_start,
// if it has one — otherwise milestones are stored without offsetMinutes.

export async function extractTemplatePayloadFromOperation(
    operationId: string,
): Promise<OperationTemplatePayload> {
    const [opRes, phasesRes, tasksRes, entriesRes] = await Promise.all([
        supabase.from('operations').select('id, scheduled_start').eq('id', operationId).single(),
        supabase.from('operation_phases').select('id, name, description, phase_type, color, sort_order').eq('operation_id', operationId).order('sort_order'),
        supabase.from('operation_tasks').select('id, title, description, task_type, priority, phase_id, sort_order').eq('operation_id', operationId).order('sort_order'),
        supabase.from('operation_schedule_entries').select('id, label, notes, scheduled_time, phase_id, sort_order').eq('operation_id', operationId).order('sort_order'),
    ]);
    handleSupabaseError({ error: opRes.error, message: 'Failed to load operation for template extraction' });
    handleSupabaseError({ error: phasesRes.error, message: 'Failed to load phases for template extraction' });
    handleSupabaseError({ error: tasksRes.error, message: 'Failed to load tasks for template extraction' });
    handleSupabaseError({ error: entriesRes.error, message: 'Failed to load milestones for template extraction' });

    const startMs = opRes.data?.scheduled_start ? new Date(opRes.data.scheduled_start).getTime() : null;
    const offsetFor = (whenIso: string): number | undefined => {
        if (!startMs) return undefined;
        const ms = new Date(whenIso).getTime() - startMs;
        if (!Number.isFinite(ms)) return undefined;
        return Math.round(ms / 60000);
    };

    const phaseRows = phasesRes.data || [];
    const taskRows = tasksRes.data || [];
    const entryRows = entriesRes.data || [];

    const buildPhase = (name: string, source: { id?: number | null; description?: string | null; phase_type?: string | null; color?: string | null } | null): OperationTemplatePhase => {
        const phaseId = source?.id ?? null;
        const milestones: OperationTemplateMilestone[] = entryRows
            .filter(e => (e.phase_id ?? null) === phaseId)
            .map(e => {
                const m: OperationTemplateMilestone = { label: e.label };
                if (e.notes) m.notes = e.notes;
                const off = offsetFor(e.scheduled_time);
                if (off !== undefined) m.offsetMinutes = off;
                return m;
            });
        const tasks: OperationTemplateTask[] = taskRows
            .filter(t => (t.phase_id ?? null) === phaseId)
            .map(t => {
                const tk: OperationTemplateTask = { title: t.title };
                if (t.description) tk.description = t.description;
                if (t.task_type) tk.taskType = t.task_type;
                if (t.priority) tk.priority = t.priority as TaskPriority;
                return tk;
            });
        const out: OperationTemplatePhase = { name };
        if (source?.description) out.description = source.description;
        if (source?.phase_type) out.phaseType = source.phase_type as OperationTemplatePhase['phaseType'];
        if (source?.color) out.color = source.color;
        if (milestones.length) out.milestones = milestones;
        if (tasks.length) out.tasks = tasks;
        return out;
    };

    const phases: OperationTemplatePhase[] = [];
    const hasUnphased =
        taskRows.some(t => t.phase_id == null) ||
        entryRows.some(e => e.phase_id == null);
    if (hasUnphased) phases.push(buildPhase('General', null));
    for (const p of phaseRows) phases.push(buildPhase(p.name, p));

    return validateTemplatePayload({ phases });
}

// ---------------------------------------------------------------------------
// Instantiate template onto a freshly-created operation
// ---------------------------------------------------------------------------
// Inserts the template's phases/milestones/tasks against the given operation
// id. Assumes the operation row already exists (template instantiation is a
// post-create step). When `scheduledStart` is supplied, milestones with an
// offsetMinutes are scheduled relative to it; milestones without an offset are
// inserted with status null (UI treats null as Pending) and no scheduled_time.
//
// scheduled_time is NOT NULL on operation_schedule_entries, so milestones that
// lack both a scheduled start and an offset are skipped — the template can't
// represent them as a real schedule entry yet.

export async function instantiateTemplateOnOperation(
    operationId: string,
    templateId: number,
    options: { scheduledStart?: string | null } = {},
    // The op creator: a template they can't see resolves to not-found, so a
    // classified plan can't be instantiated onto (and read back from) a new op.
    viewer?: ClearanceUser | null,
): Promise<{ phases: number; tasks: number; milestones: number }> {
    const tpl = await getOperationTemplate(templateId, viewer);
    if (!tpl) throw new Error('Template not found.');
    return instantiatePayloadOnOperation(operationId, tpl.payload, options);
}

// Same instantiation logic as instantiateTemplateOnOperation, but operates on
// an in-memory payload (e.g. the wizard's inline phase tree). Public so the
// op-create path can use it without round-tripping through the templates table.
export async function instantiatePayloadOnOperation(
    operationId: string,
    payload: OperationTemplatePayload,
    options: { scheduledStart?: string | null } = {},
): Promise<{ phases: number; tasks: number; milestones: number }> {
    const tpl = { payload: validateTemplatePayload(payload) };
    const startMs = options.scheduledStart ? new Date(options.scheduledStart).getTime() : null;

    let phaseCount = 0;
    let taskCount = 0;
    let milestoneCount = 0;

    for (let i = 0; i < tpl.payload.phases.length; i++) {
        const tplPhase = tpl.payload.phases[i];

        const { data: phaseRow, error: phaseErr } = await supabase
            .from('operation_phases')
            .insert({
                operation_id: operationId,
                name: tplPhase.name,
                description: tplPhase.description || null,
                phase_type: tplPhase.phaseType || 'sequential',
                color: tplPhase.color || null,
                sort_order: i,
                status: 'Pending',
            })
            .select('id')
            .single();
        handleSupabaseError({ error: phaseErr, message: 'Failed to create phase from template' });
        const newPhaseId = phaseRow!.id;
        phaseCount++;

        if (tplPhase.tasks?.length) {
            const taskRows = tplPhase.tasks.map((t, ti) => ({
                operation_id: operationId,
                phase_id: newPhaseId,
                title: t.title,
                description: t.description || null,
                task_type: t.taskType || 'primary',
                priority: t.priority || 'Normal',
                status: 'Pending',
                sort_order: ti,
            }));
            const { error: taskErr } = await supabase.from('operation_tasks').insert(taskRows);
            handleSupabaseError({ error: taskErr, message: 'Failed to create tasks from template' });
            taskCount += taskRows.length;
        }

        if (tplPhase.milestones?.length) {
            // scheduled_time is currently NOT NULL — only milestones with an
            // offsetMinutes AND a scheduled start can be materialized today.
            // Other milestones are intentionally skipped (see comment above).
            const insertable = tplPhase.milestones
                .map((m, mi) => {
                    if (m.offsetMinutes === undefined || startMs === null) return null;
                    const when = new Date(startMs + m.offsetMinutes * 60000).toISOString();
                    return {
                        operation_id: operationId,
                        phase_id: newPhaseId,
                        label: m.label,
                        notes: m.notes || null,
                        scheduled_time: when,
                        sort_order: mi,
                    };
                })
                .filter((m): m is NonNullable<typeof m> => m !== null);
            if (insertable.length) {
                const { error: entryErr } = await supabase.from('operation_schedule_entries').insert(insertable);
                handleSupabaseError({ error: entryErr, message: 'Failed to create milestones from template' });
                milestoneCount += insertable.length;
            }
        }
    }

    return { phases: phaseCount, tasks: taskCount, milestones: milestoneCount };
}
