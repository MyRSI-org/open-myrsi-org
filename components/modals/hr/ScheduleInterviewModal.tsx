
import React, { useState, useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth } from '../../../contexts/AuthContext';

import { HydratedHRApplication, HydratedHRInterview } from '../../../types';
import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

interface ScheduleInterviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    applicant: HydratedHRApplication | null;
    editingInterview?: HydratedHRInterview;
}

const ScheduleInterviewModal: React.FC<ScheduleInterviewModalProps> = ({ isOpen, onClose, applicant, editingInterview }) => {
    const { rpcAction, refreshHR } = useData();
    const { members } = useMembers();
    const { hrTemplates, hrApplicants } = useHR();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();

    const isEditMode = !!editingInterview;

    const [mode, setMode] = useState<'existing' | 'adhoc'>('existing');
    const [templateId, setTemplateId] = useState('');
    const [interviewerId, setInterviewerId] = useState('');
    const [scheduledAt, setScheduledAt] = useState('');
    const [selectedApplicantId, setSelectedApplicantId] = useState('');
    const [adHocHandle, setAdHocHandle] = useState('');
    const [adHocName, setAdHocName] = useState('');
    const [adHocContext, setAdHocContext] = useState('');
    const [panelMemberIds, setPanelMemberIds] = useState<number[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const toDatetimeLocal = (isoStr: string) => {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return '';
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    // Populate / reset the form each time the modal opens (or the source props
    // change while open), depending on whether we're editing an existing
    // interview or creating a new one. This is the React "adjust state during
    // render" pattern with previous-value trackers: it reproduces the old
    // effect's behavior (which depended on [isOpen, applicant, editingInterview]
    // and re-seeded whenever any of those changed while open) without a
    // synchronous set-in-effect. prevIsOpen starts at false so that a modal
    // that mounts already-open (the parent mounts this component only when
    // open) seeds on its first render, matching the old mount-time effect.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevApplicant, setPrevApplicant] = useState(applicant);
    const [prevEditingInterview, setPrevEditingInterview] = useState(editingInterview);
    if (isOpen !== prevIsOpen || applicant !== prevApplicant || editingInterview !== prevEditingInterview) {
        setPrevIsOpen(isOpen);
        setPrevApplicant(applicant);
        setPrevEditingInterview(editingInterview);
        if (isOpen) {
            if (editingInterview) {
                setTemplateId(String(editingInterview.template.id));
                setInterviewerId(String(editingInterview.interviewerId));
                setScheduledAt(editingInterview.scheduledAt ? toDatetimeLocal(editingInterview.scheduledAt) : '');
                // Defensive: never keep the lead interviewer in the panel list (mirrors
                // the dedup the original seed effect applied on load).
                setPanelMemberIds((editingInterview.panelMembers || []).map(m => m.id).filter(id => id !== editingInterview.interviewerId));
                setSelectedApplicantId('');
                setMode('existing');
            } else {
                setTemplateId('');
                setInterviewerId('');
                setScheduledAt('');
                setPanelMemberIds([]);
                setSelectedApplicantId(applicant ? applicant.id : '');
                setMode('existing');
            }

            setAdHocHandle('');
            setAdHocName('');
            setAdHocContext('');
            setIsLoading(false);
        }
    }

    const availableInterviewers = useMemo(() => {
        return members.filter(m => m.permissions.includes('hr:recruiter') || m.permissions.includes('hr:admin'));
    }, [members]);

    // Panel member options: eligible interviewers excluding the selected lead
    const availablePanelMembers = useMemo(() => {
        const leadId = interviewerId ? parseInt(interviewerId) : -1;
        return availableInterviewers.filter(m => m.id !== leadId);
    }, [availableInterviewers, interviewerId]);

    const addPanelMember = (id: number) => {
        if (!panelMemberIds.includes(id)) {
            setPanelMemberIds(prev => [...prev, id]);
        }
    };

    const removePanelMember = (id: number) => {
        setPanelMemberIds(prev => prev.filter(mid => mid !== id));
    };

    // If the lead interviewer changes, drop them from the panel if present.
    // Handled in the change handler (rather than an effect) so the state update
    // happens at the point of user interaction, not as a synchronous set-in-effect.
    const handleInterviewerChange = (value: string) => {
        setInterviewerId(value);
        if (value) {
            const leadId = parseInt(value);
            setPanelMemberIds(prev => prev.filter(id => id !== leadId));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);

        try {
            if (isEditMode) {
                if (!templateId || !interviewerId || !scheduledAt) {
                    addToast("Validation Error", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "All fields are required." });
                    setIsLoading(false);
                    return;
                }

                await rpcAction('hr:update_interview', {
                    interviewId: editingInterview!.id,
                    updates: {
                        templateId: parseInt(templateId),
                        interviewerId: parseInt(interviewerId),
                        scheduledAt: new Date(scheduledAt).toISOString(),
                        panelMemberIds
                    }
                });
                await refreshHR();
                addToast("Interview Updated", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "Interview details saved successfully." });
                onClose();
                return;
            }

            // Create mode
            let targetAppId = applicant ? applicant.id : selectedApplicantId;

            if (!applicant && mode === 'adhoc') {
                if (!adHocHandle.trim()) {
                    addToast("Validation Error", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "RSI Handle is required for ad-hoc interviews." });
                    setIsLoading(false);
                    return;
                }

                const newApp = await rpcAction('hr:create_application', {
                    name: adHocName.trim() || adHocHandle.trim(),
                    rsiHandle: adHocHandle.trim(),
                    referral: adHocContext.trim() || 'Ad-hoc Interview',
                    notes: 'Automatically created for ad-hoc interview scheduling.',
                    userId: currentUser?.id
                });

                targetAppId = newApp.id;
            }

            if (!templateId || !interviewerId || !scheduledAt || !targetAppId) {
                addToast("Validation Error", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "All fields are required." });
                setIsLoading(false);
                return;
            }

            await rpcAction('hr:create_interview', {
                applicationId: targetAppId,
                templateId: parseInt(templateId),
                interviewerId: parseInt(interviewerId),
                scheduledAt: new Date(scheduledAt).toISOString(),
                panelMemberIds
            });
            await refreshHR();
            onClose();
        } catch (err) {
            console.error("Failed to schedule interview:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all scheme-light";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditMode ? "Edit Interview" : "Schedule Interview"}
            subtitle={isEditMode ? "Reschedule / Reassign" : "Protocol Assignment"}
            icon={isEditMode ? "fa-solid fa-pen-to-square" : "fa-solid fa-calendar-plus"}
            color="emerald"
            width="max-w-md"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar max-h-[70vh]">
                    {/* scheme-light on inputClass handles calendar icon visibility */}

                    {/* Edit mode: show subject as read-only info */}
                    {isEditMode && editingInterview && (
                        <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
                            <label className={labelClass}>Subject</label>
                            <p className="text-white font-bold text-sm">{editingInterview.applicantName || 'Unknown Applicant'}</p>
                        </div>
                    )}

                    {/* If no pre-selected applicant and not editing, allow switching modes */}
                    {!applicant && !isEditMode && (
                        <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-700 mb-4">
                            <button
                                type="button"
                                onClick={() => setMode('existing')}
                                className={`flex-1 py-1.5 text-xs font-bold uppercase rounded-sm transition-colors ${mode === 'existing' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30' : 'text-slate-500 hover:text-white'}`}
                            >
                                Existing File
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode('adhoc')}
                                className={`flex-1 py-1.5 text-xs font-bold uppercase rounded-sm transition-colors ${mode === 'adhoc' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30' : 'text-slate-500 hover:text-white'}`}
                            >
                                Ad-hoc Entry
                            </button>
                        </div>
                    )}

                    {/* Applicant Selection Logic (create mode only) */}
                    {!applicant && !isEditMode && mode === 'existing' && (
                        <div>
                            <label className={labelClass}>Subject / Candidate</label>
                            <select
                                value={selectedApplicantId}
                                onChange={(e) => setSelectedApplicantId(e.target.value)}
                                className={inputClass}
                                required={mode === 'existing'}
                                disabled={isLoading}
                            >
                                <option value="">- Select Subject -</option>
                                {hrApplicants.filter(a => a.status !== 'Hired' && a.status !== 'Rejected').map(a => (
                                    <option key={a.id} value={a.id}>{a.applicantName} ({a.rsiHandle})</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {!applicant && !isEditMode && mode === 'adhoc' && (
                        <div className="space-y-4 bg-emerald-500/5 p-4 rounded-lg border border-emerald-500/30">
                            <div>
                                <label className={labelClass}>RSI Handle <span className="text-red-400">*</span></label>
                                <input
                                    type="text"
                                    value={adHocHandle}
                                    onChange={(e) => setAdHocHandle(e.target.value)}
                                    placeholder="e.g. StarCitizen123"
                                    className={inputClass}
                                    required={mode === 'adhoc'}
                                    disabled={isLoading}
                                />
                            </div>
                            <div>
                                <label className={labelClass}>Subject Name (Optional)</label>
                                <input
                                    type="text"
                                    value={adHocName}
                                    onChange={(e) => setAdHocName(e.target.value)}
                                    placeholder="Discord Name or Alias"
                                    className={inputClass}
                                    disabled={isLoading}
                                />
                            </div>
                            <div>
                                <label className={labelClass}>Context / File Type</label>
                                <input
                                    type="text"
                                    value={adHocContext}
                                    onChange={(e) => setAdHocContext(e.target.value)}
                                    placeholder="e.g. Recruitment, Investigation"
                                    className={inputClass}
                                    disabled={isLoading}
                                />
                            </div>
                            <p className="text-[10px] text-emerald-300/80 italic">
                                <i className="fa-solid fa-circle-info mr-1"></i> A case file will be auto-generated.
                            </p>
                        </div>
                    )}

                    <div>
                        <label className={labelClass}>Protocol Template</label>
                        <select
                            value={templateId}
                            onChange={(e) => setTemplateId(e.target.value)}
                            className={inputClass}
                            required
                            disabled={isLoading}
                        >
                            <option value="">- Select Protocol -</option>
                            {hrTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                    </div>

                    <div>
                        <label className={labelClass}>Lead Interviewer</label>
                        <select
                            value={interviewerId}
                            onChange={(e) => handleInterviewerChange(e.target.value)}
                            className={inputClass}
                            required
                            disabled={isLoading}
                        >
                            <option value="">- Select Lead -</option>
                            {availableInterviewers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                    </div>

                    {/* Panel Members */}
                    <div>
                        <label className={labelClass}>Panel Members <span className="text-slate-600">(Optional)</span></label>

                        {/* Selected panel members as chips */}
                        {panelMemberIds.length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-2">
                                {panelMemberIds.map(id => {
                                    const member = members.find(m => m.id === id);
                                    if (!member) return null;
                                    return (
                                        <span
                                            key={id}
                                            className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold px-2.5 py-1 rounded-full"
                                        >
                                            <img src={member.avatarUrl} className="h-4 w-4 rounded-full" alt="" />
                                            {member.name}
                                            <button
                                                type="button"
                                                onClick={() => removePanelMember(id)}
                                                className="text-emerald-300 hover:text-white ml-0.5 transition-colors"
                                                disabled={isLoading}
                                            >
                                                <i className="fa-solid fa-xmark text-[10px]"></i>
                                            </button>
                                        </span>
                                    );
                                })}
                            </div>
                        )}

                        {/* Add panel member dropdown */}
                        <select
                            value=""
                            onChange={(e) => {
                                const id = parseInt(e.target.value);
                                if (id) addPanelMember(id);
                            }}
                            className={inputClass}
                            disabled={isLoading || availablePanelMembers.filter(m => !panelMemberIds.includes(m.id)).length === 0}
                        >
                            <option value="">- Add Panel Member -</option>
                            {availablePanelMembers
                                .filter(m => !panelMemberIds.includes(m.id))
                                .map(m => <option key={m.id} value={m.id}>{m.name}</option>)
                            }
                        </select>
                        <p className="text-[10px] text-slate-500 mt-1.5">
                            Panel members can view and participate in this interview.
                        </p>
                    </div>

                    <div>
                        <label className={labelClass}>Date & Time</label>
                        <input
                            type="datetime-local"
                            value={scheduledAt}
                            onChange={(e) => setScheduledAt(e.target.value)}
                            className={inputClass}
                            required
                            disabled={isLoading}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : isEditMode ? 'Save Changes' : 'Confirm Schedule'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default ScheduleInterviewModal;
