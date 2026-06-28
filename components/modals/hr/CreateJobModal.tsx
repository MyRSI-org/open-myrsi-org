
import React, { useId, useRef, useState, useCallback } from 'react';
import { JobPosting, JobPostingStatus } from '../../../types';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth } from '../../../contexts/AuthContext';

import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

interface CreateJobModalProps {
    isOpen: boolean;
    onClose: () => void;
    job?: JobPosting;
}

// Requirements are stored as a plain string[] on the wire. Internally we wrap
// each in a stable client-only id so the editable chip list has a key that does
// not change when items are inserted/removed (an array index would). The id is
// never sent to the server — handleSubmit maps back to string[].
interface DraftRequirement {
    id: string;
    value: string;
}

const CreateJobModal: React.FC<CreateJobModalProps> = ({ isOpen, onClose, job }) => {
    const { rpcAction } = useData();
    const { units } = useMembers();
    const { hrPositions, setHrJobs } = useHR();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();

    // Stable per-mount prefix for requirement keys (pure to read during render).
    const reqKeyBaseId = useId();
    // Seeded items get a deterministic id from their position in the seed list
    // (pure — no ref/random during render). Runtime-added items get a unique id
    // from a counter read only inside event handlers (ref access is allowed there).
    const runtimeReqCounterRef = useRef(0);
    const wrapRequirements = (reqs: string[]): DraftRequirement[] =>
        reqs.map((value, index) => ({ id: `${reqKeyBaseId}-s${index}`, value }));
    const mintRuntimeReqId = () => `${reqKeyBaseId}-r${runtimeReqCounterRef.current++}`;

    // Form state seeded from the job prop (edit) or empty (create). The modal is
    // mounted fresh each time it opens (parent gates it with `isOpen &&`), so the
    // lazy initializers below run once per open — equivalent to the old on-open
    // effect. The render-time re-seed (prevIsOpen/prevJob) below preserves the
    // old effect's behavior should isOpen/job change while mounted.
    const [title, setTitle] = useState(() => (job ? job.title : ''));
    const [department, setDepartment] = useState(() => (job ? job.department : ''));
    const [description, setDescription] = useState(() => (job ? job.description : ''));
    const [reqInput, setReqInput] = useState('');
    const [requirements, setRequirements] = useState<DraftRequirement[]>(() => (job ? wrapRequirements(job.requirements) : []));
    const [positionId, setPositionId] = useState<string>(() => (job ? job.positionId?.toString() || '' : ''));
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!job;

    // Adjust-state-during-render replacement for the old on-open (re)initialization
    // effect. Re-seeds the form when the modal transitions to open or the job prop
    // changes while open — same fields, values and guard (isOpen) as before.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    const [prevJob, setPrevJob] = useState(job);
    if (isOpen && (isOpen !== prevIsOpen || job !== prevJob)) {
        setPrevIsOpen(isOpen);
        setPrevJob(job);
        if (job) {
            setTitle(job.title);
            setDepartment(job.department);
            setDescription(job.description);
            setRequirements(wrapRequirements(job.requirements));
            setPositionId(job.positionId?.toString() || '');
        } else {
            setTitle('');
            setDepartment('');
            setDescription('');
            setRequirements([]);
            setPositionId('');
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || job !== prevJob) {
        // isOpen is falsy: track the prop change without re-seeding, matching the
        // old effect which only ran its body when isOpen was truthy.
        setPrevIsOpen(isOpen);
        setPrevJob(job);
    }

    const handleAddReq = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && reqInput.trim()) {
            e.preventDefault();
            setRequirements([...requirements, { id: mintRuntimeReqId(), value: reqInput.trim() }]);
            setReqInput('');
        }
    };

    const removeReq = (index: number) => {
        setRequirements(requirements.filter((_, i) => i !== index));
    };

    const handlePositionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const id = e.target.value;
        setPositionId(id);
        if (id) {
            const pos = hrPositions.find(p => p.id === parseInt(id));
            if (pos) {
                setTitle(pos.name);
                setDepartment(pos.department || 'General Pool');
                if (pos.description && !description) setDescription(pos.description);
            }
        }
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !department.trim()) return;

        setIsLoading(true);
        const jobData = {
            title: title.trim(),
            department: department.trim(),
            description: description.trim(),
            requirements: requirements.map(r => r.value),
            status: job?.status || JobPostingStatus.Open,
            userId: currentUser?.id,
            positionId: positionId ? parseInt(positionId) : undefined
        };

        try {
            if (isEditing && job) {
                await rpcAction('hr:update_job', { ...jobData, id: job.id });
                setHrJobs(prev => prev.map(j => j.id === job.id ? { ...j, ...jobData } : j));
            } else {
                const newJob = await rpcAction('hr:create_job', jobData);
                setHrJobs(prev => [newJob, ...prev]);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save job:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred. Please try again." });
        } finally {
            setIsLoading(false);
        }
    }, [title, department, description, requirements, positionId, isEditing, job, currentUser, rpcAction, onClose, setHrJobs, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Vacancy' : 'Post New Vacancy'}
            subtitle="Recruitment Control"
            icon="fa-solid fa-briefcase"
            color="emerald"
            width="max-w-xl"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    <div>
                        <label className="block text-[10px] font-black text-emerald-300 uppercase tracking-widest mb-1.5">Linked Role (Optional)</label>
                        <select
                            value={positionId}
                            onChange={handlePositionChange}
                            className={inputClass}
                            disabled={isLoading}
                        >
                            <option value="">- Select Standard Role -</option>
                            {hrPositions.map(p => <option key={p.id} value={p.id}>{p.name} ({p.department || 'General'})</option>)}
                        </select>
                        <p className="text-[9px] text-slate-500 mt-1 italic">Selecting a role auto-fills details and enables automated assignment upon hiring.</p>
                    </div>

                    <div className="grid grid-cols-2 gap-5">
                        <div>
                            <label className={labelClass}>Job Title</label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className={inputClass}
                                required
                                disabled={isLoading}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Unit / Department</label>
                            <select
                                value={department}
                                onChange={(e) => setDepartment(e.target.value)}
                                className={inputClass}
                                required
                                disabled={isLoading}
                            >
                                <option value="">- Select Unit -</option>
                                {[...units].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)).map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                                <option value="General Pool">General Pool</option>
                                {positionId && !units.some(u => u.name === department) && department !== 'General Pool' && (
                                    <option value={department}>{department}</option>
                                )}
                            </select>
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={4}
                            className={`${inputClass} resize-none`}
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Requirements</label>
                        <div className="flex gap-2 mb-3">
                            <input
                                type="text"
                                value={reqInput}
                                onChange={(e) => setReqInput(e.target.value)}
                                onKeyDown={handleAddReq}
                                placeholder="Type and press Enter to add..."
                                className={inputClass}
                                disabled={isLoading}
                            />
                            <button type="button" onClick={() => { if (reqInput.trim()) { setRequirements([...requirements, { id: mintRuntimeReqId(), value: reqInput.trim() }]); setReqInput(''); } }} className="px-4 bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/20 transition-colors"><i className="fa-solid fa-plus"></i></button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {requirements.map((req, i) => (
                                <span key={req.id} className="bg-slate-900 text-slate-300 text-[10px] font-bold px-3 py-1 rounded-sm border border-slate-700 flex items-center">
                                    {req.value}
                                    <button type="button" onClick={() => removeReq(i)} className="ml-2 text-slate-500 hover:text-red-400 transition-colors"><i className="fa-solid fa-xmark"></i></button>
                                </span>
                            ))}
                        </div>
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
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className={`fa-solid ${isEditing ? 'fa-check' : 'fa-plus'}`}></i> {isEditing ? 'Save Changes' : 'Post Vacancy'}</>}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CreateJobModal;
