import React, { useState, useCallback, useEffect, useRef } from 'react';
import { IntelSubjectType, IntelThreatLevel } from '../../types';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useAuth } from '../../contexts/AuthContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface CreateIntelReportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onMinimize?: () => void;
    onSuccess: () => void;
    initialData?: {
        targetId?: string;
    };
}

const CreateIntelReportModal: React.FC<CreateIntelReportModalProps> = ({ isOpen, onClose, onMinimize, onSuccess, initialData }) => {
    const { rpcAction } = useData();
    const { securityClearances, limitingMarkers } = useMembers();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();

    const [targetId, setTargetId] = useState('');
    const [subjectType, setSubjectType] = useState<IntelSubjectType>(IntelSubjectType.Person);
    const [affiliatedOrg, setAffiliatedOrg] = useState('');
    const [threatLevel, setThreatLevel] = useState<IntelThreatLevel>(IntelThreatLevel.None);
    const [classificationLevel, setClassificationLevel] = useState('0');
    const [selectedMarkers, setSelectedMarkers] = useState<Set<number>>(() => new Set());
    const [summary, setSummary] = useState('');
    const [tagsInput, setTagsInput] = useState('');
    const [evidenceInput, setEvidenceInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    // Track previous open state to prevent resets on parent re-renders
    const wasOpenRef = useRef(false);

    useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            setTargetId(initialData?.targetId || '');
            setSubjectType(IntelSubjectType.Person);
            setAffiliatedOrg('');
            setThreatLevel(IntelThreatLevel.None);
            setClassificationLevel('0');
            setSelectedMarkers(new Set());
            setSummary('');
            setTagsInput('');
            setEvidenceInput('');
            setIsLoading(false);
        }
        wasOpenRef.current = isOpen;
    }, [isOpen, initialData]);

    const handleToggleMarker = (id: number) => {
        setSelectedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!targetId.trim() || !summary.trim() || !currentUser) return;

        setIsLoading(true);
        const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
        const evidenceUrls = evidenceInput.split('\n').map(u => u.trim()).filter(Boolean);

        try {
            await rpcAction('intel:create_report', {
                targetId: targetId.trim(),
                subjectType,
                threatLevel,
                classificationLevel: parseInt(classificationLevel),
                markerIds: Array.from(selectedMarkers),
                tags,
                summary: summary.trim(),
                evidenceUrls,
                createdById: currentUser.id,
                affiliatedOrg: subjectType === IntelSubjectType.Person ? affiliatedOrg.trim() : undefined
            });
            onSuccess();
            onClose();
        } catch (err) {
            console.error(err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to create intel report. Please try again." });
        } finally {
            setIsLoading(false);
        }
    }, [targetId, subjectType, threatLevel, classificationLevel, selectedMarkers, summary, tagsInput, evidenceInput, rpcAction, currentUser, onSuccess, onClose, affiliatedOrg, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            onMinimize={onMinimize}
            title="File Intelligence Report"
            subtitle="Tactical Entry"
            icon="fa-solid fa-file-shield"
            color="indigo"
            width="max-w-xl"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className={labelClass}>Subject Type</label>
                            <select value={subjectType} onChange={(e) => setSubjectType(e.target.value as IntelSubjectType)} className={inputClass} disabled={isLoading}>
                                {Object.values(IntelSubjectType).map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Target Handle/Tag</label>
                            <input type="text" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="RSI Handle" className={inputClass} required disabled={isLoading} />
                        </div>
                    </div>

                    <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800 space-y-4">
                        <h4 className="text-[10px] font-black text-sky-500 uppercase tracking-widest flex items-center gap-2">
                            <i className="fa-solid fa-lock"></i> Classification & Privacy
                        </h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelClass}>Classification Level</label>
                                <select value={classificationLevel} onChange={e => setClassificationLevel(e.target.value)} className={inputClass} disabled={isLoading}>
                                    {securityClearances.map(c => <option key={c.id} value={c.level}>Level {c.level} - {c.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Limiting Markers</label>
                                <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto pr-1">
                                    {limitingMarkers.map(m => (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => handleToggleMarker(m.id)}
                                            className={`text-[8px] px-1.5 py-0.5 rounded-sm border uppercase font-black transition-all ${selectedMarkers.has(m.id) ? 'bg-sky-600 text-white border-sky-400' : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-700'}`}
                                        >
                                            {m.code}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {subjectType === IntelSubjectType.Person && (
                        <div>
                            <label className={labelClass}>Affiliated Organization</label>
                            <input type="text" value={affiliatedOrg} onChange={(e) => setAffiliatedOrg(e.target.value)} placeholder="Org Code" className={inputClass} disabled={isLoading} />
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2">
                            <label className={labelClass}>Threat Level</label>
                            <div className="grid grid-cols-5 gap-1">
                                {Object.values(IntelThreatLevel).map(level => (
                                    <button
                                        key={level}
                                        type="button"
                                        onClick={() => setThreatLevel(level)}
                                        className={`py-2 text-[9px] font-black uppercase rounded border transition-all ${threatLevel === level
                                            ? 'bg-indigo-600 text-white border-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.3)]'
                                            : 'bg-slate-900 text-slate-500 border-slate-800'
                                            }`}
                                    >
                                        {level}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Incident Summary</label>
                        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="Describe the encounter..." className={`${inputClass} resize-none font-light leading-relaxed`} required disabled={isLoading} />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className={labelClass}>Tags (comma separated)</label>
                            <input type="text" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Piracy, Medic..." className={inputClass} disabled={isLoading} />
                        </div>
                        <div>
                            <label className={labelClass}>Evidence Links (one per line)</label>
                            <textarea value={evidenceInput} onChange={(e) => setEvidenceInput(e.target.value)} rows={2} placeholder="https://..." className={`${inputClass} resize-none font-mono text-[10px]`} disabled={isLoading} />
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button type="submit" disabled={isLoading} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-indigo-900/20 disabled:opacity-50">
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Publish Report'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CreateIntelReportModal;