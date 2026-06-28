import React, { useState, useCallback, useMemo, useEffect, useReducer } from 'react';
import {
    OperationType, TaskPriority,
    OperationTemplatePayload, OperationTemplatePhase, OperationTemplateMilestone, OperationTemplateTask,
} from '../../types';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useOperations } from '../../contexts/OperationsContext';
import WindowFrame from '../layout/WindowFrame';
import Switch from '../ui/Switch';
import LocationInput from '../ui/LocationInput';
import { useNotification } from '../../contexts/NotificationContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useNow } from '../../hooks/useNow';

interface CreateOperationWizardProps {
    isOpen: boolean;
    onClose: () => void;
}

// ---------------------------------------------------------------------------
// Form state — single reducer instead of ~17 useState calls. Mirrors the
// shape of the data the server's createOperation expects, plus a few wizard-
// only bits (additionalLocationIds, phases tree).
// ---------------------------------------------------------------------------

// Wizard-side row drafts carry a `_key` for stable React keys; it is never
// sent to the server (the submit payload re-maps to the bare template shape).
interface WizardMilestoneDraft extends OperationTemplateMilestone {
    _key: string;
}

interface WizardTaskDraft extends OperationTemplateTask {
    _key: string;
}

interface WizardPhaseDraft extends Omit<OperationTemplatePhase, 'milestones' | 'tasks'> {
    _key: string;
    milestones: WizardMilestoneDraft[];
    tasks: WizardTaskDraft[];
}

interface AdditionalLocationDraft {
    _key: string;
    text: string;
}

interface WizardState {
    // Step 1
    name: string;
    description: string;
    type: OperationType;
    unitId: string;
    maxParticipants: string;
    tracksUec: boolean;
    isTraining: boolean;
    isSpecial: boolean;
    joinCode: string;
    // Step 2 — free-text platform-location strings (LocationInput → platform_locations search)
    locationText: string;             // primary
    // Secondaries. Each carries a wizard-only `_key` for stable React keys
    // (rows can be removed/promoted, which shifts array indices); only `.text`
    // is sent to the server.
    additionalLocations: AdditionalLocationDraft[];
    // Step 3
    templateId: number | null;
    phases: WizardPhaseDraft[];
    // Step 5
    clearanceLevel: string;
    selectedMarkers: number[];
    isScheduled: boolean;
    scheduledStart: string;
    scheduledEnd: string;
    createDiscordEvent: boolean;
    // Optional embed announcement to a Discord channel (independent of the
    // server-wide Guild Scheduled Event toggle above). Channel can be picked
    // from the guild's text/announcement channels; org default pre-selects.
    postDiscordAnnouncement: boolean;
    discordAnnouncementChannelId: string;
}

type Action =
    | { type: 'set'; key: keyof WizardState; value: any }
    | { type: 'toggle_marker'; id: number }
    | { type: 'set_additional_location'; index: number; value: string }
    | { type: 'add_additional_location' }
    | { type: 'remove_additional_location'; index: number }
    | { type: 'promote_additional_to_primary'; index: number }
    | { type: 'apply_template'; templateId: number | null; payload: OperationTemplatePayload | null }
    | { type: 'add_phase' }
    | { type: 'update_phase'; key: string; patch: Partial<Omit<OperationTemplatePhase, 'milestones' | 'tasks'>> }
    | { type: 'remove_phase'; key: string }
    | { type: 'add_milestone'; phaseKey: string }
    | { type: 'update_milestone'; phaseKey: string; index: number; patch: Partial<OperationTemplateMilestone> }
    | { type: 'remove_milestone'; phaseKey: string; index: number }
    | { type: 'add_task'; phaseKey: string }
    | { type: 'update_task'; phaseKey: string; index: number; patch: Partial<OperationTemplateTask> }
    | { type: 'remove_task'; phaseKey: string; index: number };

const newKey = () => `k${Math.random().toString(36).slice(2, 9)}`;

const phaseFromTemplate = (p: OperationTemplatePhase): WizardPhaseDraft => ({
    _key: newKey(),
    name: p.name,
    description: p.description,
    phaseType: p.phaseType || 'sequential',
    color: p.color,
    milestones: p.milestones?.map(m => ({ ...m, _key: newKey() })) || [],
    tasks: p.tasks?.map(t => ({ ...t, _key: newKey() })) || [],
});

const initialState: WizardState = {
    name: '',
    description: '',
    type: OperationType.PvE,
    unitId: '',
    maxParticipants: '',
    tracksUec: false,
    isTraining: false,
    isSpecial: false,
    joinCode: '',
    locationText: '',
    additionalLocations: [],
    templateId: null,
    phases: [],
    clearanceLevel: '0',
    selectedMarkers: [],
    isScheduled: false,
    scheduledStart: '',
    scheduledEnd: '',
    createDiscordEvent: false,
    postDiscordAnnouncement: false,
    discordAnnouncementChannelId: '',
};

function reducer(state: WizardState, action: Action): WizardState {
    switch (action.type) {
        case 'set':
            return { ...state, [action.key]: action.value } as WizardState;
        case 'toggle_marker': {
            const set = new Set(state.selectedMarkers);
            if (set.has(action.id)) set.delete(action.id); else set.add(action.id);
            return { ...state, selectedMarkers: Array.from(set) };
        }
        case 'set_additional_location': {
            const next = [...state.additionalLocations];
            next[action.index] = { ...next[action.index], text: action.value };
            return { ...state, additionalLocations: next };
        }
        case 'add_additional_location':
            return { ...state, additionalLocations: [...state.additionalLocations, { _key: newKey(), text: '' }] };
        case 'remove_additional_location':
            return { ...state, additionalLocations: state.additionalLocations.filter((_, i) => i !== action.index) };
        case 'promote_additional_to_primary': {
            // Promote one of the secondaries to primary; demote the existing
            // primary into its slot (or drop it if blank).
            const promoted = state.additionalLocations[action.index]?.text || '';
            if (!promoted) return state;
            const next = [...state.additionalLocations];
            next.splice(action.index, 1);
            if (state.locationText.trim()) next.unshift({ _key: newKey(), text: state.locationText });
            return { ...state, locationText: promoted, additionalLocations: next };
        }
        case 'apply_template':
            return {
                ...state,
                templateId: action.templateId,
                phases: action.payload ? action.payload.phases.map(phaseFromTemplate) : [],
            };
        case 'add_phase':
            return {
                ...state,
                phases: [...state.phases, { _key: newKey(), name: `Phase ${state.phases.length + 1}`, phaseType: 'sequential', milestones: [], tasks: [] }],
            };
        case 'update_phase':
            return { ...state, phases: state.phases.map(p => p._key === action.key ? { ...p, ...action.patch } : p) };
        case 'remove_phase':
            return { ...state, phases: state.phases.filter(p => p._key !== action.key) };
        case 'add_milestone':
            return {
                ...state,
                phases: state.phases.map(p => p._key === action.phaseKey
                    ? { ...p, milestones: [...(p.milestones || []), { _key: newKey(), label: '' }] }
                    : p),
            };
        case 'update_milestone':
            return {
                ...state,
                phases: state.phases.map(p => p._key === action.phaseKey
                    ? { ...p, milestones: (p.milestones || []).map((m, i) => i === action.index ? { ...m, ...action.patch } : m) }
                    : p),
            };
        case 'remove_milestone':
            return {
                ...state,
                phases: state.phases.map(p => p._key === action.phaseKey
                    ? { ...p, milestones: (p.milestones || []).filter((_, i) => i !== action.index) }
                    : p),
            };
        case 'add_task':
            return {
                ...state,
                phases: state.phases.map(p => p._key === action.phaseKey
                    ? { ...p, tasks: [...(p.tasks || []), { _key: newKey(), title: '', priority: TaskPriority.Normal }] }
                    : p),
            };
        case 'update_task':
            return {
                ...state,
                phases: state.phases.map(p => p._key === action.phaseKey
                    ? { ...p, tasks: (p.tasks || []).map((t, i) => i === action.index ? { ...t, ...action.patch } : t) }
                    : p),
            };
        case 'remove_task':
            return {
                ...state,
                phases: state.phases.map(p => p._key === action.phaseKey
                    ? { ...p, tasks: (p.tasks || []).filter((_, i) => i !== action.index) }
                    : p),
            };
        default:
            return state;
    }
}

// Wizard-wide form classes lifted from the original CreateOperationModal.
const inputClass = "w-full bg-slate-900/60 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/50 outline-hidden transition-all scheme-light";
const labelClass = "block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5";

// Step metadata
const STEPS = [
    { key: 'basics',    label: 'Basics',    icon: 'fa-circle-info' },
    { key: 'locations', label: 'Locations', icon: 'fa-map-pin' },
    { key: 'phases',    label: 'Phases',    icon: 'fa-layer-group' },
    { key: 'security',  label: 'Security & Schedule', icon: 'fa-lock' },
    { key: 'review',    label: 'Review',    icon: 'fa-clipboard-check' },
] as const;
type StepKey = typeof STEPS[number]['key'];

const CreateOperationWizard: React.FC<CreateOperationWizardProps> = ({ isOpen, onClose }) => {
    const { addToast } = useNotification();
    const { viewOperationDetails } = useNavigation();
    const {
        securityClearances, limitingMarkers, units,
    } = useMembers();
    const { discordConfig } = useConfig();
    const { createOperation, operationTemplates } = useOperations();

    const [state, dispatch] = useReducer(reducer, initialState);
    const [stepKey, setStepKey] = useState<StepKey>('basics');
    const [isLoading, setIsLoading] = useState(false);
    const now = useNow();

    // Reset the wizard to the first step when the modal is closed so a re-open
    // starts fresh. Done during render (with a guard to avoid a render loop)
    // instead of in an effect — same end state, no extra render. Reducer state
    // isn't reset here; the WindowFrame remounts its own subtree via its key.
    if (!isOpen && stepKey !== 'basics') {
        setStepKey('basics');
    }

    // ---- Validation per step ----
    const stepIndex = STEPS.findIndex(s => s.key === stepKey);
    const validation: Record<StepKey, string | null> = useMemo(() => {
        const v: Record<StepKey, string | null> = {
            basics: null, locations: null, phases: null, security: null, review: null,
        };
        if (!state.name.trim()) v.basics = 'Operation name is required.';
        else if (!state.description.trim()) v.basics = 'Briefing description is required.';
        else if (state.isSpecial && !state.joinCode.trim()) v.basics = 'Special Operations require a Join Code/PIN.';

        if (state.isScheduled && !state.scheduledStart) v.security = 'Scheduled operations require a start time.';
        if (state.createDiscordEvent && (!state.scheduledStart || !state.scheduledEnd)) v.security = 'Discord events need a start AND end time.';
        // Discord rejects scheduled events whose start is in the past or whose end is
        // not strictly after start. Catch both client-side so the user gets a clear
        // message instead of Discord's generic "Invalid Form Body" response.
        if (state.createDiscordEvent && state.scheduledStart && state.scheduledEnd) {
            const startMs = new Date(state.scheduledStart).getTime();
            const endMs = new Date(state.scheduledEnd).getTime();
            if (Number.isFinite(startMs) && startMs <= now) {
                v.security = 'Discord events need a start time in the future.';
            } else if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
                v.security = 'Discord event end time must be after the start time.';
            }
        }
        if (state.postDiscordAnnouncement && !state.discordAnnouncementChannelId) v.security = 'Pick a Discord channel for the announcement embed.';

        return v;
    }, [state, now]);

    const canAdvance = !validation[stepKey];
    const isLastStep = stepIndex === STEPS.length - 1;

    const goNext = () => { if (canAdvance && !isLastStep) setStepKey(STEPS[stepIndex + 1].key); };
    const goBack = () => { if (stepIndex > 0) setStepKey(STEPS[stepIndex - 1].key); };

    const handleSubmit = useCallback(async () => {
        // Re-check all validation gates before submit so a back-skip can't slip
        // an invalid field through.
        for (const step of STEPS) {
            if (validation[step.key]) {
                addToast('Validation Error', <i className="fa-solid fa-triangle-exclamation"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: validation[step.key]! });
                setStepKey(step.key);
                return;
            }
        }

        setIsLoading(true);
        try {
            const phasesPayload: OperationTemplatePayload | null = state.phases.length > 0
                ? { phases: state.phases.map(p => ({
                        name: p.name.trim() || 'Phase',
                        description: p.description?.trim() || undefined,
                        phaseType: p.phaseType,
                        color: p.color,
                        milestones: (p.milestones || []).filter(m => m.label?.trim()).map(m => ({
                            label: m.label.trim(),
                            notes: m.notes?.trim() || undefined,
                            offsetMinutes: m.offsetMinutes,
                        })),
                        tasks: (p.tasks || []).filter(t => t.title?.trim()).map(t => ({
                            title: t.title.trim(),
                            description: t.description?.trim() || undefined,
                            taskType: t.taskType,
                            priority: t.priority,
                        })),
                    })) }
                : null;

            const newOp = await createOperation({
                name: state.name.trim(),
                description: state.description.trim(),
                type: state.type,
                tracksUec: state.tracksUec,
                isSpecial: state.isSpecial,
                isTraining: state.isTraining,
                isScheduled: state.isScheduled,
                scheduledStart: state.scheduledStart ? new Date(state.scheduledStart).toISOString() : null,
                scheduledEnd: state.scheduledEnd ? new Date(state.scheduledEnd).toISOString() : null,
                joinCode: state.isSpecial ? state.joinCode.trim() : undefined,
                clearanceLevel: parseInt(state.clearanceLevel) || 0,
                markerIds: state.selectedMarkers,
                unitId: state.unitId ? parseInt(state.unitId) : undefined,
                // Free-text platform-location strings (LocationInput → platform_locations).
                // The legacy locationId/additionalLocationIds fields are no longer sent —
                // the server writes location_text + additional_location_texts instead.
                locationText: state.locationText.trim() || undefined,
                additionalLocationTexts: state.additionalLocations.map(l => l.text.trim()).filter(Boolean),
                maxParticipants: state.maxParticipants ? parseInt(state.maxParticipants) : undefined,
                createDiscordEvent: state.createDiscordEvent,
                postDiscordAnnouncement: state.postDiscordAnnouncement,
                discordAnnouncementChannelId: state.postDiscordAnnouncement ? state.discordAnnouncementChannelId : undefined,
                // Pass either the picked template ID OR the inline phases payload.
                // Inline phases take precedence — a user who applied a template and
                // then edited the tree expects their edits to persist.
                templateId: !phasesPayload && state.templateId ? state.templateId : undefined,
                inlinePhases: phasesPayload,
            } as any);
            if (newOp?.discordEventFailed) {
                addToast('Discord Event Failed', <i className="fa-brands fa-discord"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: typeof newOp.discordEventFailed === 'string' ? newOp.discordEventFailed : 'Failed to create Discord event.' });
            }
            if (newOp?.discordAnnouncementFailed) {
                addToast('Discord Announcement Failed', <i className="fa-brands fa-discord"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: typeof newOp.discordAnnouncementFailed === 'string' ? newOp.discordAnnouncementFailed : 'Failed to post Discord announcement.' });
            }
            onClose();
            viewOperationDetails(newOp);
        } catch (err: any) {
            console.error('Failed to create operation:', err);
            addToast('Operation Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'An error occurred while creating the operation.' });
        } finally {
            setIsLoading(false);
        }
    }, [state, validation, createOperation, addToast, onClose, viewOperationDetails]);

    const renderStepBody = () => {
        switch (stepKey) {
            case 'basics':    return <BasicsStep state={state} dispatch={dispatch} units={units} disabled={isLoading} />;
            case 'locations': return <LocationsStep state={state} dispatch={dispatch} disabled={isLoading} />;
            case 'phases':    return <PhasesStep state={state} dispatch={dispatch} templates={operationTemplates} disabled={isLoading} />;
            case 'security':  return <SecurityStep state={state} dispatch={dispatch} securityClearances={securityClearances} limitingMarkers={limitingMarkers} discordConfigured={!!discordConfig?.clientId} defaultAnnounceChannelId={discordConfig?.defaultOperationAnnounceChannelId} disabled={isLoading} />;
            case 'review':    return <ReviewStep state={state} units={units} securityClearances={securityClearances} limitingMarkers={limitingMarkers} validation={validation} setStepKey={setStepKey} />;
        }
    };

    // Remount on close to reset reducer state cleanly.
    return (
        <WindowFrame
            key={isOpen ? 'open' : 'closed'}
            isOpen={isOpen}
            onClose={onClose}
            title="Create New Operation"
            subtitle="Mission Planning"
            icon="fa-solid fa-chess-board"
            color="purple"
            width="max-w-3xl"
        >
            <div className="flex flex-col h-full">
                {/* Stepper */}
                <div className="px-5 pt-4 pb-3 border-b border-white/5 bg-slate-900/40">
                    <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar pb-1">
                        {STEPS.map((s, i) => {
                            const isActive = s.key === stepKey;
                            const isPast = i < stepIndex;
                            const hasError = validation[s.key];
                            return (
                                <React.Fragment key={s.key}>
                                    {i > 0 && <div className={`h-px w-3 sm:w-6 shrink-0 ${isPast ? 'bg-purple-500/50' : 'bg-slate-800'}`}></div>}
                                    <button
                                        onClick={() => setStepKey(s.key)}
                                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all whitespace-nowrap ${
                                            isActive
                                                ? 'bg-purple-500/15 text-purple-300 border-purple-500/40'
                                                : isPast
                                                    ? 'text-purple-300/70 border-purple-500/30 bg-purple-500/5 hover:text-purple-200'
                                                    : 'text-slate-500 border-slate-800 bg-slate-900/40 hover:text-slate-300'
                                        } ${hasError && !isActive ? 'border-red-500/40 text-red-400' : ''}`}
                                    >
                                        <i className={`fa-solid ${s.icon} text-[9px]`}></i>
                                        <span className="hidden sm:inline">{i + 1}. {s.label}</span>
                                        <span className="sm:hidden">{i + 1}</span>
                                    </button>
                                </React.Fragment>
                            );
                        })}
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 sm:p-6">
                    {renderStepBody()}
                </div>

                {/* Inline validation message */}
                {validation[stepKey] && (
                    <div className="px-5 py-2 border-t border-amber-500/20 bg-amber-500/5 text-amber-300 text-[11px] flex items-center gap-2">
                        <i className="fa-solid fa-triangle-exclamation"></i> {validation[stepKey]}
                    </div>
                )}

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex items-center justify-between gap-3 rounded-b-xl">
                    <button onClick={onClose} className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <div className="flex items-center gap-2">
                        {stepIndex > 0 && (
                            <button onClick={goBack} disabled={isLoading} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50">
                                <i className="fa-solid fa-arrow-left"></i> Back
                            </button>
                        )}
                        {!isLastStep ? (
                            <button onClick={goNext} disabled={!canAdvance || isLoading}
                                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 border border-purple-500/40 text-white text-[11px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                Next <i className="fa-solid fa-arrow-right"></i>
                            </button>
                        ) : (
                            <button onClick={handleSubmit} disabled={isLoading || !canAdvance || Object.values(validation).some(v => !!v)}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 border border-purple-500/40 text-white text-[11px] font-bold uppercase tracking-wider shadow-lg shadow-purple-900/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                {isLoading ? <><i className="fa-solid fa-spinner animate-spin"></i> Creating</> : <><i className="fa-solid fa-plus"></i> Create Operation</>}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

// ===========================================================================
// Step components
// ===========================================================================

const BasicsStep: React.FC<{
    state: WizardState;
    dispatch: React.Dispatch<Action>;
    units: any[];
    disabled: boolean;
}> = ({ state, dispatch, units, disabled }) => (
    <div className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
                <label className={labelClass}>Operation Name</label>
                <input type="text" value={state.name} onChange={e => dispatch({ type: 'set', key: 'name', value: e.target.value })}
                    placeholder="e.g., Operation Silent Blade" className={inputClass} required disabled={disabled} />
            </div>
            <div>
                <label className={labelClass}>Operation Type</label>
                <select value={state.type} onChange={e => {
                    const t = e.target.value as OperationType;
                    dispatch({ type: 'set', key: 'type', value: t });
                    if (t === OperationType.Training) dispatch({ type: 'set', key: 'isTraining', value: true });
                    else dispatch({ type: 'set', key: 'isTraining', value: false });
                }} className={inputClass} disabled={disabled}>
                    {Object.values(OperationType).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
            </div>
        </div>
        <div>
            <label className={labelClass}>Description / Briefing</label>
            <textarea value={state.description} onChange={e => dispatch({ type: 'set', key: 'description', value: e.target.value })}
                rows={4} placeholder="Provide a detailed description of the operation's objectives..."
                className={`${inputClass} resize-none`} required disabled={disabled} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
                <label className={labelClass}>Hosting Unit (Optional)</label>
                <select value={state.unitId} onChange={e => dispatch({ type: 'set', key: 'unitId', value: e.target.value })}
                    className={inputClass} disabled={disabled}>
                    <option value="">- Global / Public -</option>
                    {[...units].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)).map(u =>
                        <option key={u.id} value={u.id}>{u.name}</option>
                    )}
                </select>
            </div>
            <div>
                <label className={labelClass}>Max Participants (Optional)</label>
                <input type="number" min="0" value={state.maxParticipants}
                    onChange={e => dispatch({ type: 'set', key: 'maxParticipants', value: e.target.value })}
                    onKeyDown={e => { if (e.key === '-' || e.key === '+' || e.key === 'e') e.preventDefault(); }}
                    className={inputClass} placeholder="Unlimited" disabled={disabled} />
            </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-slate-800 pt-4">
            <Switch label="Track aUEC Earnings" hint="Enable financial ledger" checked={state.tracksUec}
                onChange={v => dispatch({ type: 'set', key: 'tracksUec', value: v })} accent="purple" disabled={disabled} />
            <Switch label="Special Operation" hint="Standard members cannot see/join" checked={state.isSpecial}
                onChange={v => dispatch({ type: 'set', key: 'isSpecial', value: v })} accent="amber" disabled={disabled} />
        </div>
        {state.isSpecial && (
            <div className="bg-amber-950/20 p-3 rounded-lg border border-amber-500/20 animate-fade-in">
                <label className="block text-[10px] font-black text-amber-300 uppercase tracking-widest mb-2">Access PIN Code</label>
                <input type="text" value={state.joinCode} onChange={e => dispatch({ type: 'set', key: 'joinCode', value: e.target.value })}
                    placeholder="e.g. 1234"
                    className="w-full bg-slate-950/50 border border-amber-500/30 rounded-lg p-2 text-white font-mono text-center tracking-widest outline-hidden focus:ring-1 focus:ring-amber-500"
                    required disabled={disabled} />
            </div>
        )}
    </div>
);

// Locations step — uses the platform-locations search (LocationInput) instead
// of the legacy org-managed locations dropdown. Same component the service
// request flow uses; resolves against the platform_locations table via the
// system:search_locations RPC and stores the chosen path as a free-text string.
const LocationsStep: React.FC<{
    state: WizardState;
    dispatch: React.Dispatch<Action>;
    disabled: boolean;
}> = ({ state, dispatch, disabled }) => {
    const hasPrimary = state.locationText.trim().length > 0;
    return (
        <div className="space-y-5">
            <p className="text-xs text-slate-400">
                Search the Star Citizen platform location index. Pick a primary location, then add secondary locations if the operation spans multiple sites. The primary is shown on operation cards and headers; secondaries appear on the detail view.
            </p>

            {/* Primary */}
            <div>
                <label className={labelClass}>Primary Location</label>
                <LocationInput
                    value={state.locationText}
                    onChange={(v) => dispatch({ type: 'set', key: 'locationText', value: v })}
                    disabled={disabled}
                />
            </div>

            {/* Additional */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <label className={labelClass} style={{ marginBottom: 0 }}>Additional Locations</label>
                    <button type="button"
                        onClick={() => dispatch({ type: 'add_additional_location' })}
                        className="text-[10px] font-bold text-purple-300 hover:text-purple-200 uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={disabled}>
                        <i className="fa-solid fa-plus mr-1"></i> Add Location
                    </button>
                </div>
                {state.additionalLocations.length === 0 ? (
                    <p className="text-[11px] text-slate-600 italic">None — this op happens at the primary location only.</p>
                ) : (
                    <ul className="space-y-2">
                        {state.additionalLocations.map((loc, idx) => (
                            <li key={loc._key} className="flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                    <LocationInput
                                        value={loc.text}
                                        onChange={(v) => dispatch({ type: 'set_additional_location', index: idx, value: v })}
                                        disabled={disabled}
                                    />
                                </div>
                                <button type="button"
                                    onClick={() => dispatch({ type: 'promote_additional_to_primary', index: idx })}
                                    className="shrink-0 mt-1.5 text-[10px] text-amber-400 hover:text-amber-300 px-2 py-1.5 rounded-sm hover:bg-slate-800 uppercase tracking-wider font-bold disabled:opacity-30 disabled:cursor-not-allowed"
                                    title="Promote this location to primary"
                                    disabled={disabled || !loc.text.trim()}>
                                    <i className="fa-solid fa-star"></i>
                                </button>
                                <button type="button"
                                    onClick={() => dispatch({ type: 'remove_additional_location', index: idx })}
                                    className="shrink-0 mt-1.5 text-slate-500 hover:text-red-400 p-2 rounded-sm hover:bg-slate-800"
                                    title="Remove"
                                    disabled={disabled}>
                                    <i className="fa-solid fa-xmark text-xs"></i>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {hasPrimary && (
                <p className="text-[10px] text-slate-600 italic">
                    <i className="fa-solid fa-circle-info mr-1"></i>
                    Primary stays on the operation card and timeline; additional locations are listed on the detail view.
                </p>
            )}
        </div>
    );
};

const PhasesStep: React.FC<{
    state: WizardState;
    dispatch: React.Dispatch<Action>;
    templates: any[];
    disabled: boolean;
}> = ({ state, dispatch, templates, disabled }) => {
    const sortedTemplates = useMemo(() => [...templates].sort((a, b) => a.name.localeCompare(b.name)), [templates]);
    return (
        <div className="space-y-5">
            <p className="text-xs text-slate-400">
                Optional execution plan. Pick a template to seed phases, milestones, and tasks — then edit inline. Or skip
                this step and build the plan later from the operation detail view.
            </p>

            <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-700/40">
                <label className={labelClass}>Start From Template</label>
                <div className="flex items-center gap-2">
                    <select value={state.templateId ?? ''}
                        onChange={e => {
                            const id = e.target.value ? parseInt(e.target.value) : null;
                            const tpl = id ? sortedTemplates.find(t => t.id === id) : null;
                            dispatch({ type: 'apply_template', templateId: id, payload: tpl ? tpl.payload : null });
                        }}
                        className={inputClass} disabled={disabled}>
                        <option value="">- Build from scratch -</option>
                        {sortedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    {state.phases.length > 0 && (
                        <button type="button" onClick={() => dispatch({ type: 'apply_template', templateId: null, payload: null })}
                            className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-400 border border-slate-700 rounded-lg hover:border-red-500/40"
                            disabled={disabled} title="Clear all phases">
                            Clear
                        </button>
                    )}
                </div>
                {state.templateId && state.phases.length > 0 && (
                    <p className="text-[10px] text-slate-500 italic mt-2">
                        Edits below override the template. Use the operation's Administer tab later to save the edited plan as a new template.
                    </p>
                )}
            </div>

            {/* Phase tree */}
            <div className="space-y-3">
                {state.phases.map((phase, phaseIdx) => (
                    <div key={phase._key} className="rounded-xl border border-slate-700/40 bg-slate-900/40 overflow-hidden">
                        <div className="px-4 py-2.5 bg-slate-800/50 border-b border-slate-700/40 flex items-center gap-2">
                            <span className="text-[10px] font-mono text-slate-500 w-6">P{phaseIdx + 1}</span>
                            <input type="text" value={phase.name}
                                onChange={e => dispatch({ type: 'update_phase', key: phase._key, patch: { name: e.target.value } })}
                                placeholder="Phase name"
                                className="flex-1 bg-transparent text-white text-sm font-bold outline-hidden placeholder:text-slate-600"
                                disabled={disabled} />
                            <select value={phase.phaseType || 'sequential'}
                                onChange={e => dispatch({ type: 'update_phase', key: phase._key, patch: { phaseType: e.target.value as any } })}
                                className="bg-slate-900/60 text-white text-[10px] font-bold uppercase rounded-sm px-2 py-1 border border-slate-700"
                                disabled={disabled}>
                                <option value="sequential">Sequential</option>
                                <option value="contingency">Contingency</option>
                            </select>
                            <button type="button" onClick={() => dispatch({ type: 'remove_phase', key: phase._key })}
                                className="text-slate-500 hover:text-red-400 p-1.5 rounded-sm hover:bg-slate-800/60"
                                title="Remove phase" disabled={disabled}>
                                <i className="fa-solid fa-trash text-xs"></i>
                            </button>
                        </div>
                        <div className="p-3 space-y-3">
                            {/* Milestones */}
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Milestones</p>
                                    <button type="button" onClick={() => dispatch({ type: 'add_milestone', phaseKey: phase._key })}
                                        className="text-[10px] text-purple-300 hover:text-purple-200 uppercase tracking-wider font-bold"
                                        disabled={disabled}>
                                        <i className="fa-solid fa-plus mr-1"></i> Milestone
                                    </button>
                                </div>
                                {(phase.milestones || []).length === 0 ? (
                                    <p className="text-[10px] text-slate-600 italic">None.</p>
                                ) : (
                                    <ul className="space-y-1.5">
                                        {(phase.milestones || []).map((m, i) => (
                                            <li key={m._key} className="flex items-center gap-2 bg-slate-900/40 rounded-sm p-2 border border-slate-800">
                                                <input type="text" value={m.label}
                                                    onChange={e => dispatch({ type: 'update_milestone', phaseKey: phase._key, index: i, patch: { label: e.target.value } })}
                                                    placeholder="Milestone label"
                                                    className="flex-1 bg-transparent text-white text-xs outline-hidden placeholder:text-slate-600"
                                                    disabled={disabled} />
                                                <input type="number" value={m.offsetMinutes ?? ''}
                                                    onChange={e => dispatch({ type: 'update_milestone', phaseKey: phase._key, index: i, patch: { offsetMinutes: e.target.value === '' ? undefined : parseInt(e.target.value) } })}
                                                    placeholder="±min"
                                                    title="Minutes offset from operation start. Optional — leave blank to time it later."
                                                    className="w-20 bg-slate-950/40 text-white text-[11px] outline-hidden border border-slate-800 rounded-sm px-2 py-1 text-right"
                                                    disabled={disabled} />
                                                <button type="button" onClick={() => dispatch({ type: 'remove_milestone', phaseKey: phase._key, index: i })}
                                                    className="text-slate-600 hover:text-red-400 p-1 rounded-sm"
                                                    disabled={disabled}>
                                                    <i className="fa-solid fa-xmark text-[10px]"></i>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            {/* Tasks */}
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Tasks</p>
                                    <button type="button" onClick={() => dispatch({ type: 'add_task', phaseKey: phase._key })}
                                        className="text-[10px] text-purple-300 hover:text-purple-200 uppercase tracking-wider font-bold"
                                        disabled={disabled}>
                                        <i className="fa-solid fa-plus mr-1"></i> Task
                                    </button>
                                </div>
                                {(phase.tasks || []).length === 0 ? (
                                    <p className="text-[10px] text-slate-600 italic">None.</p>
                                ) : (
                                    <ul className="space-y-1.5">
                                        {(phase.tasks || []).map((t, i) => (
                                            <li key={t._key} className="flex items-center gap-2 bg-slate-900/40 rounded-sm p-2 border border-slate-800">
                                                <input type="text" value={t.title}
                                                    onChange={e => dispatch({ type: 'update_task', phaseKey: phase._key, index: i, patch: { title: e.target.value } })}
                                                    placeholder="Task title"
                                                    className="flex-1 bg-transparent text-white text-xs outline-hidden placeholder:text-slate-600"
                                                    disabled={disabled} />
                                                <select value={t.priority || TaskPriority.Normal}
                                                    onChange={e => dispatch({ type: 'update_task', phaseKey: phase._key, index: i, patch: { priority: e.target.value as TaskPriority } })}
                                                    className="bg-slate-950/40 text-white text-[10px] uppercase font-bold rounded-sm px-2 py-1 border border-slate-800"
                                                    disabled={disabled}>
                                                    {Object.values(TaskPriority).map(p => <option key={p} value={p}>{p}</option>)}
                                                </select>
                                                <button type="button" onClick={() => dispatch({ type: 'remove_task', phaseKey: phase._key, index: i })}
                                                    className="text-slate-600 hover:text-red-400 p-1 rounded-sm"
                                                    disabled={disabled}>
                                                    <i className="fa-solid fa-xmark text-[10px]"></i>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                <button type="button" onClick={() => dispatch({ type: 'add_phase' })}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-slate-700/40 text-slate-500 hover:text-purple-300 hover:border-purple-500/40 text-[10px] font-bold uppercase tracking-wider transition-colors"
                    disabled={disabled}>
                    <i className="fa-solid fa-plus"></i> Add Phase
                </button>
            </div>
        </div>
    );
};

const SecurityStep: React.FC<{
    state: WizardState;
    dispatch: React.Dispatch<Action>;
    securityClearances: any[];
    limitingMarkers: any[];
    discordConfigured: boolean;
    defaultAnnounceChannelId?: string;
    disabled: boolean;
}> = ({ state, dispatch, securityClearances, limitingMarkers, discordConfigured, defaultAnnounceChannelId, disabled }) => {
    const { rpcAction } = useData();
    const [channels, setChannels] = useState<{ id: string; name: string; type: number }[]>([]);
    const [channelsLoading, setChannelsLoading] = useState(false);
    const [channelsError, setChannelsError] = useState<string | null>(null);

    // Async core of the channel fetch. Performs no *synchronous* setState: the
    // loading flag is raised by the caller (event handler, or the render-time
    // seed below) before this runs, so the only setState calls here happen
    // after the `await` boundary. That keeps the lazy-load effect free of the
    // synchronous-set-in-effect anti-pattern.
    const fetchChannels = useCallback(async (forceRefresh: boolean) => {
        try {
            const result = await rpcAction('discord:list_guild_channels', { forceRefresh });
            // Keep text (0) and announcement (5) channels — voice/stage aren't usable
            // for posting embeds.
            const filtered = (result?.channels || []).filter((c: any) => c.type === 0 || c.type === 5);
            setChannels(filtered);
            setChannelsError(result?.error || null);
        } catch (err: any) {
            setChannels([]);
            setChannelsError(err?.message || 'Failed to load Discord channels.');
        } finally {
            setChannelsLoading(false);
        }
    }, [rpcAction]);

    // Manual (button) trigger: raise the loading flag synchronously — fine in an
    // event handler — then run the async fetch.
    const loadChannels = useCallback((forceRefresh = false) => {
        setChannelsLoading(true);
        setChannelsError(null);
        void fetchChannels(forceRefresh);
    }, [fetchChannels]);

    // Lazy initial load: when the announcement panel needs channels and none are
    // loaded yet, seed the loading flag DURING render (the React "adjust state
    // during render" pattern — re-renders before paint, so no extra paint and no
    // loading flash) and arm the fetch. The effect below then performs only the
    // async request, with no synchronous setState in its body.
    const needsChannelLoad = state.postDiscordAnnouncement && channels.length === 0 && !channelsError && !channelsLoading;
    const [channelFetchArmed, setChannelFetchArmed] = useState(false);
    if (needsChannelLoad && !channelFetchArmed) {
        setChannelFetchArmed(true);
        setChannelsLoading(true);
    }

    // Pre-select the org default channel when nothing is picked yet, and run the
    // armed async fetch. Re-toggling the panel off doesn't clear the channel — a
    // user who toggles back on within the same wizard keeps their pick.
    useEffect(() => {
        if (state.postDiscordAnnouncement && !state.discordAnnouncementChannelId && defaultAnnounceChannelId) {
            dispatch({ type: 'set', key: 'discordAnnouncementChannelId', value: defaultAnnounceChannelId });
        }
    }, [state.postDiscordAnnouncement, state.discordAnnouncementChannelId, defaultAnnounceChannelId, dispatch]);

    useEffect(() => {
        if (!channelFetchArmed) return;
        let cancelled = false;
        void (async () => {
            await fetchChannels(false);
            if (!cancelled) setChannelFetchArmed(false);
        })();
        return () => { cancelled = true; };
    }, [channelFetchArmed, fetchChannels]);

    return (
    <div className="space-y-5">
        <div className="bg-slate-900/40 p-4 rounded-xl border border-red-500/15">
            <h4 className="text-xs font-black text-red-400 uppercase tracking-widest mb-3 flex items-center">
                <i className="fa-solid fa-lock mr-2"></i> Access Control
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>Minimum Clearance Level</label>
                    <select value={state.clearanceLevel}
                        onChange={e => dispatch({ type: 'set', key: 'clearanceLevel', value: e.target.value })}
                        className={inputClass} disabled={disabled}>
                        {securityClearances.map(c => (
                            <option key={c.id} value={c.level}>Level {c.level} - {c.name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={labelClass}>Required Markers</label>
                    {limitingMarkers.length === 0 ? (
                        <p className="text-xs text-slate-500 italic">No markers defined.</p>
                    ) : (
                        <div className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar pr-1 bg-slate-950/40 rounded-lg border border-slate-800 p-2">
                            {limitingMarkers.map(m => (
                                <label key={m.id} className="flex items-center justify-between gap-2 text-xs text-slate-300 cursor-pointer hover:text-white p-1 rounded-sm hover:bg-slate-800/50">
                                    <div className="flex items-center gap-2">
                                        <input type="checkbox" checked={state.selectedMarkers.includes(m.id)}
                                            onChange={() => dispatch({ type: 'toggle_marker', id: m.id })}
                                            disabled={disabled}
                                            className="rounded-sm bg-slate-800 border-slate-600 text-purple-500 focus:ring-0" />
                                        <span className="font-mono">{m.code}</span>
                                    </div>
                                    {m.syncRestricted && (
                                        <span className="text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-bold" title="Sync Restricted — blocks Joint Operation sharing">
                                            Sync Restricted
                                        </span>
                                    )}
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>

        <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-700/40">
            <div className="mb-3">
                <Switch
                    label="Schedule for Later"
                    hint={state.createDiscordEvent ? 'Required for Discord event' : undefined}
                    checked={state.isScheduled}
                    disabled={disabled || state.createDiscordEvent}
                    accent="purple"
                    onChange={(v) => dispatch({ type: 'set', key: 'isScheduled', value: v })}
                />
            </div>
            {state.isScheduled && (
                <div className="space-y-3 animate-fade-in">
                    <p className="text-[10px] text-slate-500 italic flex items-center gap-1.5">
                        <i className="fa-solid fa-globe text-purple-400/60"></i>
                        Times are in your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className={labelClass}>Start Time</label>
                            <input type="datetime-local" value={state.scheduledStart}
                                onChange={e => dispatch({ type: 'set', key: 'scheduledStart', value: e.target.value })}
                                className={inputClass} disabled={disabled} />
                        </div>
                        <div>
                            <label className={labelClass}>End Time {state.createDiscordEvent ? '(Required)' : '(Approx)'}</label>
                            <input type="datetime-local" value={state.scheduledEnd}
                                onChange={e => dispatch({ type: 'set', key: 'scheduledEnd', value: e.target.value })}
                                className={`${inputClass} ${state.createDiscordEvent && !state.scheduledEnd ? 'border-amber-500/50' : ''}`}
                                required={state.createDiscordEvent} disabled={disabled} />
                        </div>
                    </div>
                </div>
            )}
            {discordConfigured && (
                <Switch label="Create Discord Event" hint="Post a scheduled event to your server" checked={state.createDiscordEvent}
                    onChange={v => {
                        dispatch({ type: 'set', key: 'createDiscordEvent', value: v });
                        if (v) dispatch({ type: 'set', key: 'isScheduled', value: true });
                    }}
                    accent="discord" disabled={disabled} className="mt-3" />
            )}
            {discordConfigured && (
                <div className="mt-3">
                    <Switch
                        label="Post Announcement Embed"
                        hint="Posts an embed with ✅ ❌ ❓ reactions to a channel of your choice — useful for role-restricted comms."
                        checked={state.postDiscordAnnouncement}
                        onChange={v => dispatch({ type: 'set', key: 'postDiscordAnnouncement', value: v })}
                        accent="discord"
                        disabled={disabled}
                    />
                    {state.postDiscordAnnouncement && (
                        <div className="mt-3 space-y-2 animate-fade-in">
                            <div className="flex items-center justify-between gap-2">
                                <label className={labelClass}>Channel</label>
                                <button
                                    type="button"
                                    onClick={() => loadChannels(true)}
                                    disabled={disabled || channelsLoading}
                                    className="text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
                                    title="Refresh channel list"
                                >
                                    <i className={`fa-solid fa-rotate ${channelsLoading ? 'fa-spin' : ''}`}></i>
                                </button>
                            </div>
                            {channelsError ? (
                                <p className="text-[11px] text-amber-400 italic">{channelsError}</p>
                            ) : (
                                <select
                                    value={state.discordAnnouncementChannelId}
                                    onChange={e => dispatch({ type: 'set', key: 'discordAnnouncementChannelId', value: e.target.value })}
                                    className={inputClass}
                                    disabled={disabled || channelsLoading || channels.length === 0}
                                >
                                    <option value="">{channelsLoading ? 'Loading channels…' : 'Select a channel…'}</option>
                                    {channels.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.type === 5 ? '📢 ' : '# '}{c.name}
                                        </option>
                                    ))}
                                </select>
                            )}
                            {defaultAnnounceChannelId && state.discordAnnouncementChannelId === defaultAnnounceChannelId && (
                                <p className="text-[10px] text-slate-500 italic">Pre-selected from your org's default announcement channel.</p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    </div>
    );
};

const ReviewStep: React.FC<{
    state: WizardState;
    units: any[];
    securityClearances: any[];
    limitingMarkers: any[];
    validation: Record<StepKey, string | null>;
    setStepKey: (s: StepKey) => void;
}> = ({ state, units, securityClearances, limitingMarkers, validation, setStepKey }) => {
    const unit = units.find(u => String(u.id) === state.unitId);
    const primaryLocationLabel = state.locationText.trim() || 'Unknown';
    const additionalLocationLabels = state.additionalLocations.map(l => l.text.trim()).filter(Boolean);
    const clearance = securityClearances.find(c => String(c.level) === state.clearanceLevel);
    const markers = state.selectedMarkers.map(id => limitingMarkers.find(m => m.id === id)).filter(Boolean);

    const phaseTotals = useMemo(() => {
        let tasks = 0, milestones = 0;
        for (const p of state.phases) {
            tasks += (p.tasks || []).filter(t => t.title?.trim()).length;
            milestones += (p.milestones || []).filter(m => m.label?.trim()).length;
        }
        return { phases: state.phases.length, tasks, milestones };
    }, [state.phases]);

    const blockingErrors = (Object.keys(validation) as StepKey[]).filter(k => !!validation[k]);

    return (
        <div className="space-y-4">
            {blockingErrors.length > 0 && (
                <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-red-300 flex items-center gap-2">
                        <i className="fa-solid fa-triangle-exclamation"></i> Fix before creating
                    </p>
                    {blockingErrors.map(k => (
                        <button key={k} type="button" onClick={() => setStepKey(k)}
                            className="w-full text-left text-xs text-red-200 hover:text-white bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg p-2.5 transition-colors">
                            <span className="font-bold uppercase tracking-wider text-[10px] mr-2">{STEPS.find(s => s.key === k)?.label}:</span>
                            {validation[k]}
                        </button>
                    ))}
                </div>
            )}

            <ReviewBlock title="Basics">
                <ReviewRow label="Name" value={state.name || '—'} />
                <ReviewRow label="Type" value={state.type} />
                <ReviewRow label="Hosting Unit" value={unit?.name || 'Global / Public'} />
                <ReviewRow label="Max Participants" value={state.maxParticipants || 'Unlimited'} />
                <ReviewRow label="Tracks aUEC" value={state.tracksUec ? 'Yes' : 'No'} />
                <ReviewRow label="Special Op" value={state.isSpecial ? `Yes (PIN: ${state.joinCode || '—'})` : 'No'} />
                <ReviewRow label="Briefing" value={state.description || '—'} multiline />
            </ReviewBlock>

            <ReviewBlock title="Locations">
                <ReviewRow label="Primary" value={primaryLocationLabel} />
                <ReviewRow label="Additional"
                    value={additionalLocationLabels.length === 0 ? 'None' : additionalLocationLabels.join(', ')} />
            </ReviewBlock>

            <ReviewBlock title="Plan">
                <ReviewRow label="Phases / Tasks / Milestones" value={`${phaseTotals.phases} / ${phaseTotals.tasks} / ${phaseTotals.milestones}`} />
                {state.templateId && phaseTotals.phases > 0 && (
                    <ReviewRow label="Source" value="Template (with edits)" />
                )}
            </ReviewBlock>

            <ReviewBlock title="Security & Schedule">
                <ReviewRow label="Clearance" value={clearance ? `Level ${clearance.level} — ${clearance.name}` : `Level ${state.clearanceLevel}`} />
                <ReviewRow label="Markers"
                    value={markers.length === 0
                        ? 'None'
                        : markers.map((m: any) => m.syncRestricted ? `${m.code} (sync-restricted)` : m.code).join(', ')} />
                <ReviewRow label="Scheduled"
                    value={state.isScheduled ? `${state.scheduledStart || '—'} → ${state.scheduledEnd || '—'}` : 'No'} />
                <ReviewRow label="Discord Event" value={state.createDiscordEvent ? 'Yes' : 'No'} />
            </ReviewBlock>
        </div>
    );
};

// ===========================================================================
// Small presentational helpers
// ===========================================================================

const ReviewBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 overflow-hidden">
        <div className="px-4 py-2 bg-slate-800/40 border-b border-slate-700/40">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{title}</p>
        </div>
        <div className="p-3 space-y-1.5">
            {children}
        </div>
    </div>
);

const ReviewRow: React.FC<{ label: string; value: string; multiline?: boolean }> = ({ label, value, multiline }) => (
    <div className="flex items-start gap-3">
        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold w-32 shrink-0 mt-0.5">{label}</span>
        <span className={`text-xs text-white ${multiline ? 'whitespace-pre-wrap' : ''}`}>{value}</span>
    </div>
);

export default CreateOperationWizard;
