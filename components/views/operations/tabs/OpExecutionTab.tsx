import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { HydratedOperation, OperationPhase, OperationScheduleEntry, OperationTask, PhaseStatus, TaskStatus, TaskPriority, OperationStatus } from '../../../../types';
import { useData } from '../../../../contexts/DataContext';

import { useFormatDate } from '../../../../contexts/AuthContext';
import { useNotification } from '../../../../contexts/NotificationContext';
import { useNow } from '../../../../hooks/useNow';

interface OpExecutionTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    onRefresh: () => void;
}

const priorityColors: Record<string, string> = {
    Low: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
    Normal: 'text-purple-300 bg-purple-500/10 border-purple-500/20',
    High: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    Critical: 'text-red-400 bg-red-500/10 border-red-500/20',
};

const statusColors: Record<string, string> = {
    Pending: 'text-slate-400 border-slate-500/20',
    Active: 'text-purple-300 border-purple-500/20',
    Completed: 'text-green-400 border-green-500/20',
    Failed: 'text-red-400 border-red-500/20',
};

const phaseStatusColors: Record<string, string> = {
    Pending: 'bg-amber-500/15 text-amber-400 border border-amber-500/25',
    Active: 'bg-green-500/15 text-green-400 border border-green-500/25',
    Completed: 'bg-purple-500/15 text-purple-300 border border-purple-500/25',
    Skipped: 'bg-slate-600/15 text-slate-400 border border-slate-600/25',
};

// Subtle background tints applied to task cards and phase containers when the
// item (or any child of a phase) is High/Critical priority. Keeps Normal/Low
// rendering unchanged so the surface stays calm by default.
const priorityCardTints: Record<string, string> = {
    Critical: 'bg-red-500/[0.07] border-red-500/25',
    High: 'bg-amber-500/[0.07] border-amber-500/25',
};

const PRIORITY_RANK: Record<string, number> = { Critical: 4, High: 3, Normal: 2, Low: 1 };
const highestPriority = (tasks: OperationTask[]): string | null => {
    let top: string | null = null;
    let topRank = 0;
    for (const t of tasks) {
        const r = PRIORITY_RANK[t.priority] || 0;
        if (r > topRank) { top = t.priority; topRank = r; }
    }
    return top;
};

const inputClass = "w-full bg-slate-900/80 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2.5 outline-hidden focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 transition-all scheme-light";
const labelClass = "text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1.5 block";

const CountdownTimer: React.FC<{ targetTime: number }> = ({ targetTime }) => {
    // `now` is the live wall-clock sample. It is seeded once at mount and then
    // re-sampled by the 1s interval below, so the clock read happens in the
    // timer callback (and lazy initialiser) rather than during render — keeping
    // the displayed T-minus updating every second exactly as before.
    const [now, setNow] = useState(() => Date.now());
    React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const diff = targetTime - now;
    if (diff <= 0) return null;
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return (
        <span className="text-[9px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-sm animate-pulse">
            T-{mins}:{secs.toString().padStart(2, '0')}
        </span>
    );
};

interface PhaseGroup {
    phase: OperationPhase | null;
    milestones: OperationScheduleEntry[];
    tasks: OperationTask[];
}

const KebabMenu: React.FC<{ children: React.ReactNode; onClose: () => void; triggerRef?: React.RefObject<HTMLButtonElement | null> }> = ({ children, onClose, triggerRef }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; flipUp: boolean }>({ top: 0, left: 0, flipUp: false });

    useEffect(() => {
        if (triggerRef?.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const menuHeight = 300; // estimated
            const flipUp = rect.bottom + menuHeight > window.innerHeight;
            setPos({
                top: flipUp ? rect.top + window.scrollY : rect.bottom + window.scrollY + 4,
                left: Math.max(8, rect.right + window.scrollX - 280),
                flipUp,
            });
        }
    }, [triggerRef]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node) && triggerRef?.current && !triggerRef.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose, triggerRef]);

    return ReactDOM.createPortal(
        <div ref={ref}
            className="fixed z-9999 bg-slate-800 border border-slate-700/50 rounded-xl shadow-2xl shadow-black/50 p-4 space-y-3 min-w-[280px] animate-fade-in"
            style={{ top: pos.flipUp ? undefined : pos.top, bottom: pos.flipUp ? window.innerHeight - pos.top + 4 : undefined, left: pos.left }}
            onClick={e => e.stopPropagation()}>
            {children}
        </div>,
        document.body
    );
};

const InlineEdit: React.FC<{
    value: string;
    onSave: (val: string) => void;
    canEdit: boolean;
    className?: string;
    placeholder?: string;
}> = ({ value, onSave, canEdit, className = '', placeholder }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

    if (!editing) {
        return (
            <span className={`${className} ${canEdit ? 'cursor-pointer hover:bg-white/5 rounded-sm px-1 -mx-1 transition-colors' : ''}`}
                onClick={() => { if (canEdit) { setDraft(value); setEditing(true); } }}>
                {value || <span className="text-slate-600 italic">{placeholder || 'Untitled'}</span>}
            </span>
        );
    }

    return (
        <input ref={inputRef} type="text" value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Enter') { if (draft.trim() && draft !== value) onSave(draft.trim()); setEditing(false); }
                if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => { if (draft.trim() && draft !== value) onSave(draft.trim()); setEditing(false); }}
            className={`bg-black/30 border border-purple-500/50 rounded-sm px-1.5 py-0.5 text-white outline-hidden focus:ring-1 focus:ring-purple-500/30 ${className}`}
        />
    );
};

const OpExecutionTab: React.FC<OpExecutionTabProps> = ({ operation, canManage, onRefresh }) => {
    const { rpcAction } = useData();
    const { confirm } = useNotification();
    const fmt = useFormatDate();
    // Memoise the `|| []` fallbacks so downstream memos / callbacks that
    // depend on these only re-run when the underlying operation slice
    // actually changes (instead of every render when operation.* is empty).
    const phases = useMemo(() => operation.phases || [], [operation.phases]);
    const entries = useMemo(() => operation.scheduleEntries || [], [operation.scheduleEntries]);
    const tasks = useMemo(() => operation.tasks || [], [operation.tasks]);
    const activeParticipants = useMemo(() => (operation.participants || []).filter(p => p.timeLeft === null), [operation.participants]);
    const now = useNow();

    const [addingPhase, setAddingPhase] = useState(false);
    const [newPhaseName, setNewPhaseName] = useState('');
    const [addingMilestoneFor, setAddingMilestoneFor] = useState<string | null>(null); // phase key
    const [newMilestoneLabel, setNewMilestoneLabel] = useState('');
    const [newMilestoneTime, setNewMilestoneTime] = useState('');
    const [addingTaskFor, setAddingTaskFor] = useState<string | null>(null); // phase key
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [saving, setSaving] = useState(false);

    const [kebabOpen, setKebabOpen] = useState<string | null>(null); // e.g. "phase-3", "milestone-7", "task-12"
    const [kebabSaving, setKebabSaving] = useState(false);
    const kebabTriggerRef = useRef<HTMLButtonElement | null>(null);

    const [kebabFields, setKebabFields] = useState<Record<string, any>>({});

    const [dragItem, setDragItem] = useState<{ type: 'phase' | 'milestone' | 'task'; id: number } | null>(null);
    const [dropTarget, setDropTarget] = useState<{ type: 'phase' | 'milestone' | 'task'; id: number; position: 'before' | 'after' } | null>(null);
    const [dragOverPhase, setDragOverPhase] = useState<string | null>(null);

    const phaseInputRef = useRef<HTMLInputElement>(null);
    const milestoneInputRef = useRef<HTMLInputElement>(null);
    const taskInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { if (addingPhase) phaseInputRef.current?.focus(); }, [addingPhase]);
    useEffect(() => { if (addingMilestoneFor) milestoneInputRef.current?.focus(); }, [addingMilestoneFor]);
    useEffect(() => { if (addingTaskFor) taskInputRef.current?.focus(); }, [addingTaskFor]);

    const phaseGroups = useMemo(() => {
        const sortedPhases = [...phases].sort((a, b) => a.sortOrder - b.sortOrder);
        const groups: PhaseGroup[] = [];
        const unphasedMilestones = entries.filter(e => !e.phaseId).sort((a, b) => a.sortOrder - b.sortOrder);
        const unphasedTasks = tasks.filter(t => !t.phaseId).sort((a, b) => a.sortOrder - b.sortOrder);
        if (unphasedMilestones.length > 0 || unphasedTasks.length > 0 || sortedPhases.length === 0) {
            groups.push({ phase: null, milestones: unphasedMilestones, tasks: unphasedTasks });
        }
        sortedPhases.forEach(phase => {
            const phaseMilestones = entries.filter(e => e.phaseId === phase.id).sort((a, b) => a.sortOrder - b.sortOrder);
            const phaseTasks = tasks.filter(t => t.phaseId === phase.id).sort((a, b) => a.sortOrder - b.sortOrder);
            groups.push({ phase, milestones: phaseMilestones, tasks: phaseTasks });
        });
        return groups;
    }, [phases, entries, tasks]);

    const completedTasks = tasks.filter(t => t.status === 'Completed').length;
    const activePhasesCount = phases.filter(p => p.status === 'Active').length;


    const handleAddPhase = useCallback(async (name: string) => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            await rpcAction('operation:add_phase', {
                operationId: operation.id,
                data: { name: name.trim(), phaseType: 'sequential', color: '#3b82f6', sortOrder: phases.length },
            });
            onRefresh();
        } finally {
            setSaving(false);
        }
    }, [rpcAction, operation.id, phases.length, onRefresh]);

    const handleUpdatePhase = useCallback(async (phaseId: number, data: Record<string, any>) => {
        await rpcAction('operation:update_phase', { phaseId, data, operationId: operation.id });
        onRefresh();
    }, [rpcAction, operation.id, onRefresh]);

    // Wraps phase-status changes with a confirm dialog when the new status is
    // Completed and there are non-terminal (Pending/Active) children that will
    // be cascaded server-side. Failed/Skipped children are excluded — they are
    // already terminal and stay untouched.
    const handleUpdatePhaseStatus = useCallback(async (phaseId: number, newStatus: string) => {
        if (newStatus === 'Completed') {
            const cascadingTasks = tasks.filter(t => t.phaseId === phaseId && (t.status === 'Pending' || t.status === 'Active'));
            const cascadingMilestones = entries.filter(e =>
                e.phaseId === phaseId &&
                (e.status === 'Pending' || e.status === 'Active' || !e.status)
            );
            const totalCascade = cascadingTasks.length + cascadingMilestones.length;
            if (totalCascade > 0) {
                const parts: string[] = [];
                if (cascadingTasks.length > 0) parts.push(`${cascadingTasks.length} pending/active task${cascadingTasks.length === 1 ? '' : 's'}`);
                if (cascadingMilestones.length > 0) parts.push(`${cascadingMilestones.length} milestone${cascadingMilestones.length === 1 ? '' : 's'}`);
                const ok = await confirm({
                    title: 'Complete Phase',
                    message: `Mark ${parts.join(' and ')} as Completed? Failed or Skipped items will be left alone.`,
                    confirmText: 'Complete Phase',
                });
                if (!ok) return;
            }
        }
        await handleUpdatePhase(phaseId, { status: newStatus });
    }, [tasks, entries, confirm, handleUpdatePhase]);

    const handleDeletePhase = useCallback(async (phaseId: number) => {
        if (kebabSaving) return;
        const ok = await confirm({ title: 'Delete Phase', message: 'Delete this phase and unassign its milestones/tasks?', confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        setKebabSaving(true);
        try {
            await rpcAction('operation:delete_phase', { phaseId, operationId: operation.id });
            onRefresh();
            setKebabOpen(null);
        } finally { setKebabSaving(false); }
    }, [rpcAction, operation.id, onRefresh, confirm, kebabSaving]);

    const handleAddMilestone = useCallback(async (label: string, scheduledTime: string, phaseId?: number) => {
        if (!label.trim() || !scheduledTime) return;
        setSaving(true);
        try {
            await rpcAction('operation:add_schedule_entry', {
                operationId: operation.id,
                data: {
                    label: label.trim(),
                    scheduledTime: new Date(scheduledTime).toISOString(),
                    phaseId: phaseId || undefined,
                    sortOrder: entries.length,
                },
            });
            onRefresh();
        } finally {
            setSaving(false);
        }
    }, [rpcAction, operation.id, entries.length, onRefresh]);

    const handleUpdateMilestone = useCallback(async (entryId: number, data: Record<string, any>) => {
        if (data.scheduledTime && typeof data.scheduledTime === 'string' && !data.scheduledTime.includes('T00:00:00')) {
            data.scheduledTime = new Date(data.scheduledTime).toISOString();
        }
        await rpcAction('operation:update_schedule_entry', { entryId, data, operationId: operation.id });
        onRefresh();
    }, [rpcAction, operation.id, onRefresh]);

    const handleDeleteMilestone = useCallback(async (entryId: number) => {
        if (kebabSaving) return;
        const ok = await confirm({ title: 'Delete Milestone', message: 'Remove this milestone?', confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        setKebabSaving(true);
        try {
            await rpcAction('operation:delete_schedule_entry', { entryId, operationId: operation.id });
            onRefresh();
            setKebabOpen(null);
        } finally { setKebabSaving(false); }
    }, [rpcAction, operation.id, onRefresh, confirm, kebabSaving]);

    const handleAddTask = useCallback(async (title: string, phaseId?: number) => {
        if (!title.trim()) return;
        setSaving(true);
        try {
            await rpcAction('operation:add_task', {
                operationId: operation.id,
                data: {
                    title: title.trim(),
                    taskType: 'primary',
                    priority: TaskPriority.Normal,
                    phaseId: phaseId || undefined,
                    sortOrder: tasks.length,
                },
            });
            onRefresh();
        } finally {
            setSaving(false);
        }
    }, [rpcAction, operation.id, tasks.length, onRefresh]);

    const handleUpdateTask = useCallback(async (taskId: number, data: Record<string, any>) => {
        await rpcAction('operation:update_task', { taskId, data, operationId: operation.id });
        onRefresh();
    }, [rpcAction, operation.id, onRefresh]);

    const handleDeleteTask = useCallback(async (taskId: number) => {
        if (kebabSaving) return;
        const ok = await confirm({ title: 'Delete Task', message: 'Remove this task?', confirmText: 'Delete', variant: 'danger' });
        if (!ok) return;
        setKebabSaving(true);
        try {
            await rpcAction('operation:delete_task', { taskId, operationId: operation.id });
            onRefresh();
            setKebabOpen(null);
        } finally { setKebabSaving(false); }
    }, [rpcAction, operation.id, onRefresh, confirm, kebabSaving]);


    const handleDragStart = useCallback((e: React.DragEvent, type: 'phase' | 'milestone' | 'task', id: number) => {
        setDragItem({ type, id });
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${type}-${id}`);
        (e.target as HTMLElement).style.opacity = '0.5';
    }, []);

    const handleDragEnd = useCallback((e: React.DragEvent) => {
        (e.target as HTMLElement).style.opacity = '1';
        setDragItem(null);
        setDropTarget(null);
        setDragOverPhase(null);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, type: 'phase' | 'milestone' | 'task', id: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragItem || dragItem.type !== type) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const position = e.clientY < midY ? 'before' : 'after';
        setDropTarget({ type, id, position });
    }, [dragItem]);

    const handleDragOverPhaseZone = useCallback((e: React.DragEvent, phaseKey: string) => {
        e.preventDefault();
        if (dragItem && (dragItem.type === 'milestone' || dragItem.type === 'task')) {
            setDragOverPhase(phaseKey);
        }
    }, [dragItem]);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        if (!dragItem || !dropTarget) { setDragItem(null); setDropTarget(null); setDragOverPhase(null); return; }

        if (dragItem.type === 'phase' && dropTarget.type === 'phase') {
            const sortedPhases = [...phases].sort((a, b) => a.sortOrder - b.sortOrder);
            const dragIdx = sortedPhases.findIndex(p => p.id === dragItem.id);
            let dropIdx = sortedPhases.findIndex(p => p.id === dropTarget.id);
            if (dragIdx === -1 || dropIdx === -1 || dragIdx === dropIdx) return;
            if (dropTarget.position === 'after') dropIdx++;
            if (dragIdx < dropIdx) dropIdx--;
            const reordered = [...sortedPhases];
            const [moved] = reordered.splice(dragIdx, 1);
            reordered.splice(dropIdx, 0, moved);
            await Promise.all(reordered.map((p, i) =>
                p.sortOrder !== i ? rpcAction('operation:update_phase', { phaseId: p.id, data: { sortOrder: i }, operationId: operation.id }) : null
            ));
            onRefresh();
        }

        if (dragItem.type === 'milestone' && dropTarget.type === 'milestone') {
            const dragEntry = entries.find(e => e.id === dragItem.id);
            const dropEntry = entries.find(e => e.id === dropTarget.id);
            if (!dragEntry || !dropEntry) return;
            const targetPhaseId = dropEntry.phaseId;
            const samePhase = entries.filter(e => e.phaseId === targetPhaseId).sort((a, b) => a.sortOrder - b.sortOrder);
            const dragIdx = samePhase.findIndex(e => e.id === dragItem.id);
            let dropIdx = samePhase.findIndex(e => e.id === dropTarget.id);
            const reordered = dragIdx >= 0 ? [...samePhase] : [dragEntry, ...samePhase];
            if (dragIdx >= 0) {
                const [moved] = reordered.splice(dragIdx, 1);
                if (dropTarget.position === 'after') dropIdx++;
                if (dragIdx < dropIdx) dropIdx--;
                reordered.splice(dropIdx, 0, moved);
            }
            const updates: Promise<any>[] = [];
            reordered.forEach((e, i) => {
                const needsUpdate = e.sortOrder !== i || (e.id === dragItem.id && e.phaseId !== targetPhaseId);
                if (needsUpdate) {
                    updates.push(rpcAction('operation:update_schedule_entry', { entryId: e.id, data: { sortOrder: i, phaseId: targetPhaseId || null }, operationId: operation.id }));
                }
            });
            if (updates.length > 0) { await Promise.all(updates); onRefresh(); }
        }

        if (dragItem.type === 'task' && dropTarget.type === 'task') {
            const dragTask = tasks.find(t => t.id === dragItem.id);
            const dropTask = tasks.find(t => t.id === dropTarget.id);
            if (!dragTask || !dropTask) return;
            const targetPhaseId = dropTask.phaseId;
            const samePhase = tasks.filter(t => t.phaseId === targetPhaseId).sort((a, b) => a.sortOrder - b.sortOrder);
            const dragIdx = samePhase.findIndex(t => t.id === dragItem.id);
            let dropIdx = samePhase.findIndex(t => t.id === dropTarget.id);
            const reordered = dragIdx >= 0 ? [...samePhase] : [dragTask, ...samePhase];
            if (dragIdx >= 0) {
                const [moved] = reordered.splice(dragIdx, 1);
                if (dropTarget.position === 'after') dropIdx++;
                if (dragIdx < dropIdx) dropIdx--;
                reordered.splice(dropIdx, 0, moved);
            }
            const updates: Promise<any>[] = [];
            reordered.forEach((t, i) => {
                const needsUpdate = t.sortOrder !== i || (t.id === dragItem.id && t.phaseId !== targetPhaseId);
                if (needsUpdate) {
                    updates.push(rpcAction('operation:update_task', { taskId: t.id, data: { sortOrder: i, phaseId: targetPhaseId || null }, operationId: operation.id }));
                }
            });
            if (updates.length > 0) { await Promise.all(updates); onRefresh(); }
        }

        setDragItem(null);
        setDropTarget(null);
        setDragOverPhase(null);
    }, [dragItem, dropTarget, phases, entries, tasks, rpcAction, operation.id, onRefresh]);


    const openKebab = useCallback((key: string, fields: Record<string, any>, triggerEl?: HTMLButtonElement | null) => {
        setKebabOpen(key);
        setKebabFields(fields);
        kebabTriggerRef.current = triggerEl || null;
    }, []);

    const closeKebab = useCallback(() => {
        setKebabOpen(null);
        setKebabFields({});
        kebabTriggerRef.current = null;
    }, []);

    const saveKebabPhase = useCallback(async (phaseId: number) => {
        if (kebabSaving) return;
        setKebabSaving(true);
        try {
            await handleUpdatePhase(phaseId, kebabFields);
            closeKebab();
        } finally { setKebabSaving(false); }
    }, [handleUpdatePhase, kebabFields, closeKebab, kebabSaving]);

    const saveKebabMilestone = useCallback(async (entryId: number) => {
        if (kebabSaving) return;
        setKebabSaving(true);
        try {
            const data = { ...kebabFields };
            if (data.scheduledTime) data.scheduledTime = new Date(data.scheduledTime).toISOString();
            if (data.phaseId === '') data.phaseId = null;
            else if (data.phaseId) data.phaseId = parseInt(data.phaseId);
            await handleUpdateMilestone(entryId, data);
            closeKebab();
        } finally { setKebabSaving(false); }
    }, [handleUpdateMilestone, kebabFields, closeKebab, kebabSaving]);

    const saveKebabTask = useCallback(async (taskId: number) => {
        if (kebabSaving) return;
        setKebabSaving(true);
        try {
            const data = { ...kebabFields };
            if (data.assignedUserId === '') data.assignedUserId = null;
            else if (data.assignedUserId) data.assignedUserId = parseInt(data.assignedUserId);
            if (data.phaseId === '') data.phaseId = null;
            else if (data.phaseId) data.phaseId = parseInt(data.phaseId);
            await handleUpdateTask(taskId, data);
            closeKebab();
        } finally { setKebabSaving(false); }
    }, [handleUpdateTask, kebabFields, closeKebab, kebabSaving]);

    const toLocalDatetimeValue = (dateStr?: string | null) => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };


    return (
        <div className="p-6 lg:p-8 space-y-4">
            {/* ── Stats Bar ── */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-linear-to-r from-slate-800/60 to-slate-900/40 rounded-xl border border-slate-700/40">
                <div className="flex items-center gap-4">
                    <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                        <i className="fa-solid fa-layer-group text-purple-400/70"></i> Execution Plan
                    </p>
                    <div className="flex items-center gap-3 text-[10px] font-mono text-slate-500">
                        <span>{phases.length} <span className="text-slate-600">phases</span></span>
                        <span className="text-slate-700">&middot;</span>
                        <span>{entries.length} <span className="text-slate-600">milestones</span></span>
                        <span className="text-slate-700">&middot;</span>
                        <span>{completedTasks}/{tasks.length} <span className="text-slate-600">tasks</span></span>
                        {activePhasesCount > 0 && (
                            <>
                                <span className="text-slate-700">&middot;</span>
                                <span className="text-green-400">{activePhasesCount} active</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Phase Groups ── */}
            <div className="space-y-3" onDrop={handleDrop} onDragOver={e => e.preventDefault()}>
                {phaseGroups.map((group) => {
                    const key = group.phase ? String(group.phase.id) : 'unphased';
                    const phaseId = group.phase?.id;
                    const sortedMilestones = [...group.milestones].sort((a, b) => {
                        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
                        return new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime();
                    });
                    const sortedTasks = [...group.tasks].sort((a, b) => a.sortOrder - b.sortOrder);
                    const phaseTopPriority = highestPriority(sortedTasks);
                    const phaseTint = phaseTopPriority ? priorityCardTints[phaseTopPriority] : null;

                    return (
                        <div key={key}
                            className={`rounded-xl border overflow-hidden transition-colors ${
                                dragOverPhase === key
                                    ? 'border-purple-500/40 bg-purple-500/5'
                                    : phaseTint
                                        ? phaseTint
                                        : 'border-slate-700/30 bg-slate-900/60'
                            }`}
                            onDragOver={e => handleDragOverPhaseZone(e, key)}
                            onDragLeave={() => setDragOverPhase(null)}
                        >
                            {/* ── Phase Header ── */}
                            {group.phase ? (
                                <div
                                    className="flex items-center gap-3 px-5 py-3 bg-slate-800/40 border-b border-slate-700/30 relative"
                                    draggable={canManage}
                                    onDragStart={e => handleDragStart(e, 'phase', group.phase!.id)}
                                    onDragEnd={handleDragEnd}
                                    onDragOver={e => handleDragOver(e, 'phase', group.phase!.id)}
                                >
                                    {dropTarget?.type === 'phase' && dropTarget.id === group.phase.id && dropTarget.position === 'before' && (
                                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-purple-400 z-10"></div>
                                    )}

                                    <div className="w-1.5 h-10 rounded-full shrink-0" style={{ backgroundColor: group.phase.color || '#3b82f6' }}></div>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <InlineEdit
                                                value={group.phase.name}
                                                onSave={val => handleUpdatePhase(group.phase!.id, { name: val })}
                                                canEdit={canManage}
                                                className="text-sm font-bold text-white"
                                            />
                                            {group.phase.phaseType === 'contingency' && (
                                                <span className="text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-sm uppercase">Contingency</span>
                                            )}
                                        </div>
                                        {group.phase.description && <p className="text-xs text-slate-400 truncate mt-0.5">{group.phase.description}</p>}
                                    </div>

                                    {/* Status pills */}
                                    <div className="flex items-center gap-1 shrink-0">
                                        {Object.values(PhaseStatus).map(s => (
                                            <button key={s} onClick={() => canManage && handleUpdatePhaseStatus(group.phase!.id, s)}
                                                className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-all ${
                                                    group.phase!.status === s ? phaseStatusColors[s] : 'text-slate-600 hover:text-slate-400 border border-transparent'
                                                } ${!canManage ? 'cursor-default' : 'cursor-pointer'}`}
                                            >{s}</button>
                                        ))}
                                    </div>

                                    {/* Drag handle + Kebab */}
                                    {canManage && (
                                        <div className="flex items-center gap-1 shrink-0">
                                            <span className="cursor-grab text-slate-600 hover:text-slate-400 px-1" title="Drag to reorder">
                                                <i className="fa-solid fa-grip-vertical text-xs"></i>
                                            </span>
                                            <div className="relative">
                                                <button onClick={(e) => {
                                                    if (kebabOpen === `phase-${group.phase!.id}`) { closeKebab(); return; }
                                                    openKebab(`phase-${group.phase!.id}`, {
                                                        name: group.phase!.name,
                                                        description: group.phase!.description || '',
                                                        phaseType: group.phase!.phaseType,
                                                        color: group.phase!.color || '#3b82f6',
                                                    }, e.currentTarget);
                                                }} className="text-slate-600 hover:text-slate-300 p-1 rounded-sm hover:bg-slate-700/50 transition-colors">
                                                    <i className="fa-solid fa-ellipsis-vertical text-xs"></i>
                                                </button>
                                                {kebabOpen === `phase-${group.phase!.id}` && (
                                                    <KebabMenu onClose={closeKebab} triggerRef={kebabTriggerRef}>
                                                        <div>
                                                            <label className={labelClass}>Name</label>
                                                            <input type="text" value={kebabFields.name || ''} onChange={e => setKebabFields(f => ({ ...f, name: e.target.value }))} className={inputClass} />
                                                        </div>
                                                        <div>
                                                            <label className={labelClass}>Description</label>
                                                            <input type="text" value={kebabFields.description || ''} onChange={e => setKebabFields(f => ({ ...f, description: e.target.value }))} className={inputClass} placeholder="Optional" />
                                                        </div>
                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div>
                                                                <label className={labelClass}>Type</label>
                                                                <select value={kebabFields.phaseType || 'sequential'} onChange={e => setKebabFields(f => ({ ...f, phaseType: e.target.value }))} className={inputClass}>
                                                                    <option value="sequential">Sequential</option>
                                                                    <option value="contingency">Contingency</option>
                                                                </select>
                                                            </div>
                                                            <div>
                                                                <label className={labelClass}>Color</label>
                                                                <input type="color" value={kebabFields.color || '#3b82f6'} onChange={e => setKebabFields(f => ({ ...f, color: e.target.value }))} className="w-full h-[42px] rounded-lg cursor-pointer bg-transparent border-0" />
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center justify-between pt-2 border-t border-slate-700/50">
                                                            <button onClick={() => handleDeletePhase(group.phase!.id)} disabled={kebabSaving} className="text-[10px] text-red-400 hover:text-red-300 font-bold uppercase tracking-wider disabled:opacity-50 disabled:pointer-events-none">
                                                                {kebabSaving ? <i className="fa-solid fa-spinner animate-spin mr-1"></i> : <i className="fa-solid fa-trash mr-1"></i>} Delete
                                                            </button>
                                                            <button onClick={() => saveKebabPhase(group.phase!.id)} disabled={kebabSaving}
                                                                className="text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-1.5 rounded-lg font-bold uppercase tracking-wider transition-colors disabled:opacity-50 disabled:pointer-events-none">
                                                                {kebabSaving ? <><i className="fa-solid fa-spinner animate-spin mr-1"></i> Saving...</> : 'Save'}
                                                            </button>
                                                        </div>
                                                    </KebabMenu>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {dropTarget?.type === 'phase' && dropTarget.id === group.phase.id && dropTarget.position === 'after' && (
                                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-400 z-10"></div>
                                    )}
                                </div>
                            ) : (
                                <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">General (Unphased)</span>
                                </div>
                            )}

                            {/* ── Phase Content ── */}
                            <div className="p-4 space-y-1">
                                {/* Milestones Section */}
                                {(sortedMilestones.length > 0 || (canManage && addingMilestoneFor === key)) && (
                                    <div className="space-y-1">
                                        {sortedMilestones.length > 0 && (
                                            <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest pl-1 pb-1">Milestones</p>
                                        )}
                                        {sortedMilestones.map(entry => {
                                            const entryTime = new Date(entry.scheduledTime).getTime();
                                            const isPast = entryTime < now;
                                            const isUpcoming = !isPast && entryTime - now < 30 * 60000;
                                            const mKey = `milestone-${entry.id}`;

                                            return (
                                                <div key={mKey}
                                                    className={`flex items-center gap-3 px-3 py-2 rounded-lg group relative transition-all ${isPast && entry.status !== 'Completed' && entry.status !== 'Active' && entry.status !== 'Skipped' ? 'opacity-50' : ''} bg-slate-800/20 hover:bg-slate-800/40`}
                                                    draggable={canManage}
                                                    onDragStart={e => handleDragStart(e, 'milestone', entry.id)}
                                                    onDragEnd={handleDragEnd}
                                                    onDragOver={e => handleDragOver(e, 'milestone', entry.id)}
                                                >
                                                    {dropTarget?.type === 'milestone' && dropTarget.id === entry.id && dropTarget.position === 'before' && (
                                                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-purple-400 z-10"></div>
                                                    )}

                                                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border-2 ${
                                                        entry.status === 'Completed' ? 'bg-green-500/15 border-green-500' :
                                                        entry.status === 'Active' ? 'bg-purple-500/15 border-purple-500' :
                                                        entry.status === 'Skipped' ? 'bg-slate-600/15 border-slate-600' :
                                                        'bg-slate-800 border-slate-600'
                                                    }`}>
                                                        <i className={`fa-solid ${
                                                            entry.status === 'Completed' ? 'fa-check text-green-400' :
                                                            entry.status === 'Active' ? 'fa-play text-purple-300' :
                                                            entry.status === 'Skipped' ? 'fa-forward text-slate-400' :
                                                            'fa-minus text-slate-500'
                                                        } text-[7px]`}></i>
                                                    </div>

                                                    <div className="flex-1 min-w-0 flex items-center gap-2">
                                                        <InlineEdit
                                                            value={entry.label}
                                                            onSave={val => handleUpdateMilestone(entry.id, { label: val })}
                                                            canEdit={canManage}
                                                            className="text-sm font-bold text-white"
                                                        />
                                                        {isUpcoming && operation.status === OperationStatus.Active && <CountdownTimer targetTime={entryTime} />}
                                                        {entry.notes && <span className="text-xs text-slate-500 truncate hidden md:inline">&mdash; {entry.notes}</span>}
                                                    </div>

                                                    <span className="text-[10px] font-mono text-slate-400 shrink-0">
                                                        {fmt(entry.scheduledTime)}
                                                    </span>

                                                    {/* Status pills */}
                                                    <div className="flex items-center gap-1 shrink-0">
                                                        {Object.values(PhaseStatus).map(s => (
                                                            <button key={s} onClick={() => canManage && handleUpdateMilestone(entry.id, { status: s })}
                                                                className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase transition-all border ${
                                                                    (entry.status || 'Pending') === s ? phaseStatusColors[s] : 'text-slate-700 border-transparent hover:text-slate-500'
                                                                } ${!canManage ? 'cursor-default' : 'cursor-pointer'}`}
                                                            >{s}</button>
                                                        ))}
                                                    </div>

                                                    {canManage && (
                                                        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <span className="cursor-grab text-slate-600 hover:text-slate-400 px-0.5" title="Drag to reorder">
                                                                <i className="fa-solid fa-grip-vertical text-[10px]"></i>
                                                            </span>
                                                            <div className="relative">
                                                                <button onClick={(e) => {
                                                                    if (kebabOpen === mKey) { closeKebab(); return; }
                                                                    openKebab(mKey, {
                                                                        label: entry.label,
                                                                        scheduledTime: toLocalDatetimeValue(entry.scheduledTime),
                                                                        notes: entry.notes || '',
                                                                        status: entry.status || 'Pending',
                                                                        phaseId: entry.phaseId ? String(entry.phaseId) : '',
                                                                    }, e.currentTarget);
                                                                }} className="text-slate-600 hover:text-slate-300 p-0.5 rounded-sm hover:bg-slate-700/50 transition-colors">
                                                                    <i className="fa-solid fa-ellipsis-vertical text-[10px]"></i>
                                                                </button>
                                                                {kebabOpen === mKey && (
                                                                    <KebabMenu onClose={closeKebab} triggerRef={kebabTriggerRef}>
                                                                        <div>
                                                                            <label className={labelClass}>Label</label>
                                                                            <input type="text" value={kebabFields.label || ''} onChange={e => setKebabFields(f => ({ ...f, label: e.target.value }))} className={inputClass} />
                                                                        </div>
                                                                        <div>
                                                                            <label className={labelClass}>Scheduled Time</label>
                                                                            <input type="datetime-local" value={kebabFields.scheduledTime || ''} onChange={e => setKebabFields(f => ({ ...f, scheduledTime: e.target.value }))} className={`${inputClass} scheme-light`} />
                                                                        </div>
                                                                        <div>
                                                                            <label className={labelClass}>Notes</label>
                                                                            <input type="text" value={kebabFields.notes || ''} onChange={e => setKebabFields(f => ({ ...f, notes: e.target.value }))} className={inputClass} placeholder="Optional" />
                                                                        </div>
                                                                        <div>
                                                                            <label className={labelClass}>Status</label>
                                                                            <select value={kebabFields.status || 'Pending'} onChange={e => setKebabFields(f => ({ ...f, status: e.target.value }))} className={inputClass}>
                                                                                {['Pending', 'Active', 'Completed', 'Skipped'].map(s => <option key={s} value={s}>{s}</option>)}
                                                                            </select>
                                                                        </div>
                                                                        {phases.length > 0 && (
                                                                            <div>
                                                                                <label className={labelClass}>Phase</label>
                                                                                <select value={kebabFields.phaseId || ''} onChange={e => setKebabFields(f => ({ ...f, phaseId: e.target.value }))} className={inputClass}>
                                                                                    <option value="">- None -</option>
                                                                                    {phases.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                                                                </select>
                                                                            </div>
                                                                        )}
                                                                        <div className="flex items-center justify-between pt-2 border-t border-slate-700/50">
                                                                            <button onClick={() => handleDeleteMilestone(entry.id)} disabled={kebabSaving} className="text-[10px] text-red-400 hover:text-red-300 font-bold uppercase tracking-wider disabled:opacity-50 disabled:pointer-events-none">
                                                                                {kebabSaving ? <i className="fa-solid fa-spinner animate-spin mr-1"></i> : <i className="fa-solid fa-trash mr-1"></i>} Delete
                                                                            </button>
                                                                            <button onClick={() => saveKebabMilestone(entry.id)} disabled={kebabSaving}
                                                                                className="text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-1.5 rounded-lg font-bold uppercase tracking-wider transition-colors disabled:opacity-50 disabled:pointer-events-none">
                                                                                {kebabSaving ? <><i className="fa-solid fa-spinner animate-spin mr-1"></i> Saving...</> : 'Save'}
                                                                            </button>
                                                                        </div>
                                                                    </KebabMenu>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {dropTarget?.type === 'milestone' && dropTarget.id === entry.id && dropTarget.position === 'after' && (
                                                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-400 z-10"></div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Add milestone inline */}
                                {canManage && addingMilestoneFor !== key && (
                                    <button onClick={() => { setAddingMilestoneFor(key); setNewMilestoneLabel(''); setNewMilestoneTime(''); }}
                                        className="text-[10px] font-bold text-slate-600 hover:text-purple-300 uppercase tracking-wider pl-1 py-1 transition-colors">
                                        <i className="fa-solid fa-plus mr-1"></i> Milestone
                                    </button>
                                )}
                                {canManage && addingMilestoneFor === key && (
                                    <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/30 rounded-lg border border-purple-500/20">
                                        <input ref={milestoneInputRef} type="text" value={newMilestoneLabel} onChange={e => setNewMilestoneLabel(e.target.value)}
                                            placeholder="Milestone label..."
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && newMilestoneLabel.trim() && newMilestoneTime) {
                                                    handleAddMilestone(newMilestoneLabel, newMilestoneTime, phaseId);
                                                    setNewMilestoneLabel(''); setNewMilestoneTime('');
                                                }
                                                if (e.key === 'Escape') setAddingMilestoneFor(null);
                                            }}
                                            className="flex-1 bg-transparent text-white text-sm outline-hidden placeholder:text-slate-600" />
                                        <input type="datetime-local" value={newMilestoneTime} onChange={e => setNewMilestoneTime(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && newMilestoneLabel.trim() && newMilestoneTime) {
                                                    handleAddMilestone(newMilestoneLabel, newMilestoneTime, phaseId);
                                                    setNewMilestoneLabel(''); setNewMilestoneTime('');
                                                }
                                                if (e.key === 'Escape') setAddingMilestoneFor(null);
                                            }}
                                            className="bg-transparent text-white text-sm outline-hidden scheme-light max-w-[200px]" />
                                        <button onClick={() => setAddingMilestoneFor(null)} className="text-slate-600 hover:text-slate-400 text-xs">
                                            <i className="fa-solid fa-xmark"></i>
                                        </button>
                                        {saving && <i className="fa-solid fa-spinner animate-spin text-purple-300 text-xs"></i>}
                                    </div>
                                )}

                                {/* Separator between milestones and tasks */}
                                {sortedMilestones.length > 0 && sortedTasks.length > 0 && (
                                    <div className="border-t border-slate-700/20 my-1"></div>
                                )}

                                {/* Tasks Section */}
                                {(sortedTasks.length > 0 || (canManage && addingTaskFor === key)) && (
                                    <div className="space-y-1">
                                        {sortedTasks.length > 0 && (
                                            <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest pl-1 pb-1">Tasks</p>
                                        )}
                                        {sortedTasks.map(task => {
                                            const tKey = `task-${task.id}`;
                                            const priorityTint = priorityCardTints[task.priority];

                                            return (
                                                <div key={tKey}
                                                    className={`flex items-start gap-3 px-3 py-2 rounded-lg group relative transition-colors border ${
                                                        priorityTint
                                                            ? `${priorityTint} hover:brightness-125`
                                                            : 'bg-slate-800/20 hover:bg-slate-800/40 border-transparent'
                                                    }`}
                                                    draggable={canManage}
                                                    onDragStart={e => handleDragStart(e, 'task', task.id)}
                                                    onDragEnd={handleDragEnd}
                                                    onDragOver={e => handleDragOver(e, 'task', task.id)}
                                                >
                                                    {dropTarget?.type === 'task' && dropTarget.id === task.id && dropTarget.position === 'before' && (
                                                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-purple-400 z-10"></div>
                                                    )}

                                                    {/* Checkbox-style icon */}
                                                    <div className="w-6 h-6 rounded-sm flex items-center justify-center shrink-0 border mt-0.5" style={{
                                                        borderColor: task.status === 'Completed' ? 'rgba(34,197,94,0.4)' : task.status === 'Active' ? 'rgba(56,189,248,0.4)' : task.status === 'Failed' ? 'rgba(239,68,68,0.4)' : 'rgba(100,116,139,0.3)',
                                                        backgroundColor: task.status === 'Completed' ? 'rgba(34,197,94,0.08)' : 'transparent',
                                                    }}>
                                                        <i className={`fa-solid ${task.status === 'Completed' ? 'fa-check text-green-400' : task.status === 'Active' ? 'fa-play text-purple-300' : task.status === 'Failed' ? 'fa-xmark text-red-400' : 'fa-minus text-slate-500'} text-[7px]`}></i>
                                                    </div>

                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <InlineEdit
                                                                value={task.title}
                                                                onSave={val => handleUpdateTask(task.id, { title: val })}
                                                                canEdit={canManage}
                                                                className="text-sm font-bold text-white"
                                                            />
                                                            <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                                                                task.taskType === 'primary' ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                                                                task.taskType === 'secondary' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' :
                                                                'text-purple-300 bg-purple-500/10 border-purple-500/20'
                                                            }`}>{task.taskType}</span>
                                                            <span className={`text-[8px] px-1.5 py-0.5 rounded-sm border font-bold uppercase ${priorityColors[task.priority] || priorityColors.Normal}`}>
                                                                {task.priority}
                                                            </span>
                                                        </div>
                                                        {task.description && <p className="text-xs text-slate-400 mt-0.5">{task.description}</p>}
                                                        <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
                                                            {task.assignedUser && (
                                                                <span className="flex items-center gap-1">
                                                                    {task.assignedUser.avatarUrl && <img src={task.assignedUser.avatarUrl} className="w-4 h-4 rounded-full object-cover shrink-0" alt="" />}
                                                                    {task.assignedUser.name}
                                                                </span>
                                                            )}
                                                            {task.assignedUnit && (
                                                                <span className="flex items-center gap-1"><i className="fa-solid fa-people-group"></i> {task.assignedUnit.name}</span>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Status pills */}
                                                    <div className="flex items-center gap-1 shrink-0">
                                                        {Object.values(TaskStatus).map(s => (
                                                            <button key={s} onClick={() => canManage && handleUpdateTask(task.id, { status: s })}
                                                                className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase transition-all border ${
                                                                    task.status === s ? statusColors[s] : 'text-slate-700 border-transparent hover:text-slate-500'
                                                                } ${!canManage ? 'cursor-default' : 'cursor-pointer'}`}
                                                            >{s}</button>
                                                        ))}
                                                    </div>

                                                    {/* Drag handle + Kebab */}
                                                    {canManage && (
                                                        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <span className="cursor-grab text-slate-600 hover:text-slate-400 px-0.5" title="Drag to reorder">
                                                                <i className="fa-solid fa-grip-vertical text-[10px]"></i>
                                                            </span>
                                                            <div className="relative">
                                                                <button onClick={(e) => {
                                                                    if (kebabOpen === tKey) { closeKebab(); return; }
                                                                    openKebab(tKey, {
                                                                        title: task.title,
                                                                        description: task.description || '',
                                                                        taskType: task.taskType,
                                                                        priority: task.priority,
                                                                        assignedUserId: task.assignedUserId ? String(task.assignedUserId) : '',
                                                                        phaseId: task.phaseId ? String(task.phaseId) : '',
                                                                    }, e.currentTarget);
                                                                }} className="text-slate-600 hover:text-slate-300 p-0.5 rounded-sm hover:bg-slate-700/50 transition-colors">
                                                                    <i className="fa-solid fa-ellipsis-vertical text-[10px]"></i>
                                                                </button>
                                                                {kebabOpen === tKey && (
                                                                    <KebabMenu onClose={closeKebab} triggerRef={kebabTriggerRef}>
                                                                        <div>
                                                                            <label className={labelClass}>Title</label>
                                                                            <input type="text" value={kebabFields.title || ''} onChange={e => setKebabFields(f => ({ ...f, title: e.target.value }))} className={inputClass} />
                                                                        </div>
                                                                        <div>
                                                                            <label className={labelClass}>Description</label>
                                                                            <textarea value={kebabFields.description || ''} onChange={e => setKebabFields(f => ({ ...f, description: e.target.value }))} rows={2} className={`${inputClass} resize-none`} placeholder="Optional" />
                                                                        </div>
                                                                        <div className="grid grid-cols-2 gap-3">
                                                                            <div>
                                                                                <label className={labelClass}>Type</label>
                                                                                <select value={kebabFields.taskType || 'primary'} onChange={e => setKebabFields(f => ({ ...f, taskType: e.target.value }))} className={inputClass}>
                                                                                    <option value="primary">Primary</option>
                                                                                    <option value="secondary">Secondary</option>
                                                                                    <option value="assignment">Assignment</option>
                                                                                </select>
                                                                            </div>
                                                                            <div>
                                                                                <label className={labelClass}>Priority</label>
                                                                                <select value={kebabFields.priority || 'Normal'} onChange={e => setKebabFields(f => ({ ...f, priority: e.target.value }))} className={inputClass}>
                                                                                    {Object.values(TaskPriority).map(p => <option key={p} value={p}>{p}</option>)}
                                                                                </select>
                                                                            </div>
                                                                        </div>
                                                                        <div>
                                                                            <label className={labelClass}>Assignee</label>
                                                                            <select value={kebabFields.assignedUserId || ''} onChange={e => setKebabFields(f => ({ ...f, assignedUserId: e.target.value }))} className={inputClass}>
                                                                                <option value="">- None -</option>
                                                                                {activeParticipants.map(p => <option key={p.userId} value={p.userId}>{p.user?.name}</option>)}
                                                                            </select>
                                                                        </div>
                                                                        {phases.length > 0 && (
                                                                            <div>
                                                                                <label className={labelClass}>Phase</label>
                                                                                <select value={kebabFields.phaseId || ''} onChange={e => setKebabFields(f => ({ ...f, phaseId: e.target.value }))} className={inputClass}>
                                                                                    <option value="">- None -</option>
                                                                                    {phases.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                                                                </select>
                                                                            </div>
                                                                        )}
                                                                        <div className="flex items-center justify-between pt-2 border-t border-slate-700/50">
                                                                            <button onClick={() => handleDeleteTask(task.id)} disabled={kebabSaving} className="text-[10px] text-red-400 hover:text-red-300 font-bold uppercase tracking-wider disabled:opacity-50 disabled:pointer-events-none">
                                                                                {kebabSaving ? <i className="fa-solid fa-spinner animate-spin mr-1"></i> : <i className="fa-solid fa-trash mr-1"></i>} Delete
                                                                            </button>
                                                                            <button onClick={() => saveKebabTask(task.id)} disabled={kebabSaving}
                                                                                className="text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-1.5 rounded-lg font-bold uppercase tracking-wider transition-colors disabled:opacity-50 disabled:pointer-events-none">
                                                                                {kebabSaving ? <><i className="fa-solid fa-spinner animate-spin mr-1"></i> Saving...</> : 'Save'}
                                                                            </button>
                                                                        </div>
                                                                    </KebabMenu>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {dropTarget?.type === 'task' && dropTarget.id === task.id && dropTarget.position === 'after' && (
                                                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-400 z-10"></div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Add task inline */}
                                {canManage && addingTaskFor !== key && (
                                    <button onClick={() => { setAddingTaskFor(key); setNewTaskTitle(''); }}
                                        className="text-[10px] font-bold text-slate-600 hover:text-purple-300 uppercase tracking-wider pl-1 py-1 transition-colors">
                                        <i className="fa-solid fa-plus mr-1"></i> Task
                                    </button>
                                )}
                                {canManage && addingTaskFor === key && (
                                    <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/30 rounded-lg border border-purple-500/20">
                                        <input ref={taskInputRef} type="text" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                                            placeholder="Task title... (Enter to add, Esc to close)"
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && newTaskTitle.trim()) {
                                                    handleAddTask(newTaskTitle, phaseId);
                                                    setNewTaskTitle('');
                                                }
                                                if (e.key === 'Escape') setAddingTaskFor(null);
                                            }}
                                            className="flex-1 bg-transparent text-white text-sm outline-hidden placeholder:text-slate-600" />
                                        <button onClick={() => setAddingTaskFor(null)} className="text-slate-600 hover:text-slate-400 text-xs">
                                            <i className="fa-solid fa-xmark"></i>
                                        </button>
                                        {saving && <i className="fa-solid fa-spinner animate-spin text-purple-300 text-xs"></i>}
                                    </div>
                                )}

                                {/* Empty state */}
                                {group.milestones.length === 0 && group.tasks.length === 0 && !canManage && (
                                    <p className="text-xs text-slate-600 italic py-3 text-center">No milestones or tasks in this phase.</p>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* ── Add Phase (bottom) ── */}
            {canManage && !addingPhase && (
                <button onClick={() => { setAddingPhase(true); setNewPhaseName(''); }}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-slate-700/30 text-slate-600 hover:text-purple-300 hover:border-purple-500/30 transition-colors text-[10px] font-bold uppercase tracking-wider">
                    <i className="fa-solid fa-plus"></i> Add Phase
                </button>
            )}
            {canManage && addingPhase && (
                <div className="flex items-center gap-2 px-4 py-3 bg-slate-800/30 rounded-xl border border-purple-500/20">
                    <input ref={phaseInputRef} type="text" value={newPhaseName} onChange={e => setNewPhaseName(e.target.value)}
                        placeholder="Phase name... (Enter to add, Esc to close)"
                        onKeyDown={e => {
                            if (e.key === 'Enter' && newPhaseName.trim()) {
                                handleAddPhase(newPhaseName);
                                setNewPhaseName('');
                            }
                            if (e.key === 'Escape') setAddingPhase(false);
                        }}
                        className="flex-1 bg-transparent text-white text-sm font-bold outline-hidden placeholder:text-slate-600" />
                    <button onClick={() => setAddingPhase(false)} className="text-slate-600 hover:text-slate-400 text-xs">
                        <i className="fa-solid fa-xmark"></i>
                    </button>
                    {saving && <i className="fa-solid fa-spinner animate-spin text-purple-300 text-xs"></i>}
                </div>
            )}

            {/* Empty state when no content at all */}
            {phases.length === 0 && entries.length === 0 && tasks.length === 0 && !canManage && (
                <div className="flex flex-col items-center justify-center py-16 text-slate-600">
                    <i className="fa-solid fa-clipboard text-4xl mb-3 opacity-40"></i>
                    <p className="text-sm font-medium opacity-60">No execution plan defined yet.</p>
                </div>
            )}
        </div>
    );
};

export default OpExecutionTab;
