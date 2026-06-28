import React, { useState, useMemo } from 'react';
import { HydratedIntelligenceReport, IntelThreatLevel, IntelSubjectType } from '../../types';
import { useAuth, useFormatDate } from '../../contexts/AuthContext';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useConfig } from '../../contexts/ConfigContext';

import WindowFrame, { WindowColor } from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface IntelReportDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    onMinimize?: () => void;
    report: HydratedIntelligenceReport;
    onViewDossier: (targetId: string) => void;
    onDelete?: () => void;
    onUpdate?: () => void;
    initialOffset?: number;
}

/** Paranoid string coercion — guarantees a primitive string for JSX rendering */
const s = (v: unknown, fallback = ''): string => {
    if (v == null) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback;
};

const getWindowColor = (level: unknown): WindowColor => {
    const l = s(level);
    switch (l) {
        case IntelThreatLevel.Critical: return 'red';
        case IntelThreatLevel.High: return 'amber';
        case IntelThreatLevel.Medium: return 'amber';
        case IntelThreatLevel.Low: return 'green';
        default: return 'slate';
    }
};

const SectionHeader: React.FC<{ title: string; icon: string }> = ({ title, icon }) => (
    <div className="flex items-center space-x-2 mb-3 border-b border-slate-700/50 pb-2">
        <i className={`${icon} text-slate-500 text-sm`}></i>
        <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">{title}</h3>
    </div>
);

const IntelReportDetailModal: React.FC<IntelReportDetailModalProps> = ({ isOpen, onClose, onMinimize, report, onViewDossier, onDelete, onUpdate, initialOffset }) => {
    const { currentUser, hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { rpcAction } = useData();
    const { securityClearances, limitingMarkers } = useMembers();
    const { aiConfig } = useConfig();
    const { addToast } = useNotification();

    const isAuthor = currentUser?.id === report.createdBy?.id;
    const canEdit = hasPermission('intel:manage') || isAuthor;
    const canDelete = hasPermission('intel:manage');

    const [isEditing, setIsEditing] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Form state — all initialized as safe primitives
    const [summary, setSummary] = useState('');
    const [threatLevel, setThreatLevel] = useState<IntelThreatLevel>(IntelThreatLevel.None);
    const [classificationLevel, setClassificationLevel] = useState('0');
    const [selectedMarkers, setSelectedMarkers] = useState<Set<number>>(() => new Set());
    const [tagsInput, setTagsInput] = useState('');
    const [evidenceInput, setEvidenceInput] = useState('');
    const [affiliatedOrg, setAffiliatedOrg] = useState('');

    // Safe extraction of all report fields
    const targetId = s(report.targetId);
    const reportId = s(report.id);
    const subjectType = s(report.subjectType);
    const isOrg = subjectType === IntelSubjectType.Organization;
    const authorName = s(report.createdBy?.name) || s(report.externalAuthor) || 'SYSTEM';
    const createdAt = fmt(s(report.createdAt));
    // Memoise the conditional `? : []` derivations so the empty-array branch
    // doesn't allocate a fresh array every render — keeps the form-reset
    // effect's deps stable so it only re-runs when `report` actually changes.
    const reportMarkers = useMemo(() => Array.isArray(report.limitingMarkers) ? report.limitingMarkers : [], [report.limitingMarkers]);
    const reportTags = useMemo(() => Array.isArray(report.tags) ? report.tags : [], [report.tags]);
    const reportEvidence = useMemo(() => Array.isArray(report.evidenceUrls) ? report.evidenceUrls : [], [report.evidenceUrls]);

    // Build collision-safe React keys for the read-only free-text lists (tags,
    // evidence URLs). The list value is the primary identity; an occurrence
    // suffix disambiguates empty/duplicate strings so we never fall back to the
    // bare array index. These keys are render-only and never reach the server —
    // the save path serialises tagsInput/evidenceInput, not these objects.
    const keyedTags = useMemo(() => {
        const seen = new Map<string, number>();
        return reportTags.map(tag => {
            const value = s(tag);
            const n = seen.get(value) ?? 0;
            seen.set(value, n + 1);
            return { value, key: `${value}#${n}` };
        });
    }, [reportTags]);
    const keyedEvidence = useMemo(() => {
        const seen = new Map<string, number>();
        return reportEvidence.map(url => {
            const value = s(url);
            const n = seen.get(value) ?? 0;
            seen.set(value, n + 1);
            return { value, key: `${value}#${n}` };
        });
    }, [reportEvidence]);

    // Hydrate the edit form from the selected report whenever the modal opens or
    // the report changes. Done with render-time previous-value trackers (React's
    // "adjust state during render" pattern) instead of an effect: the seed runs
    // before paint, which is behaviour-equivalent to the previous open/report-change
    // effect — same fields, same values, same `isOpen && report` guard. prevIsOpen
    // starts false so an already-open mount (the multi-window usage) still seeds.
    const [prevReportSeedIsOpen, setPrevReportSeedIsOpen] = useState(false);
    const [prevReportSeedReport, setPrevReportSeedReport] = useState(report);
    if (isOpen && report && (!prevReportSeedIsOpen || report !== prevReportSeedReport)) {
        setPrevReportSeedIsOpen(isOpen);
        setPrevReportSeedReport(report);
        setSummary(s(report.summary));
        setThreatLevel((s(report.threatLevel) as IntelThreatLevel) || IntelThreatLevel.None);
        setClassificationLevel(String(typeof report.classificationLevel === 'number' ? report.classificationLevel : 0));
        setSelectedMarkers(new Set(reportMarkers.map(m => typeof m?.id === 'number' ? m.id : 0).filter(Boolean)));
        setTagsInput(reportTags.map(t => s(t)).join(', '));
        setEvidenceInput(reportEvidence.map(u => s(u)).join('\n'));
        setAffiliatedOrg(s(report.affiliatedOrg));
        setIsEditing(false);
    } else if (!isOpen && prevReportSeedIsOpen) {
        // Track close transitions so the next open re-seeds even if the report ref
        // is unchanged — mirrors the effect firing on every isOpen false->true edge.
        setPrevReportSeedIsOpen(false);
    }

    const handleToggleMarker = (id: number) => {
        setSelectedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleSave = async () => {
        setIsLoading(true);
        try {
            const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
            const evidenceUrls = evidenceInput.split('\n').map(u => u.trim()).filter(Boolean);

            await rpcAction('intel:update_report', {
                id: reportId,
                updates: {
                    summary: summary.trim(),
                    threatLevel,
                    classificationLevel: parseInt(classificationLevel),
                    markerIds: Array.from(selectedMarkers),
                    tags,
                    evidenceUrls,
                    affiliatedOrg: isOrg ? null : affiliatedOrg.trim() || null,
                    subjectType: report.subjectType
                }
            });

            if (onUpdate) onUpdate();
            setIsEditing(false);
        } catch {
            addToast("Update Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to update intel report. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    const handleDossierOpen = () => {
        onViewDossier(targetId);
        onClose();
    };

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    const currentClearanceName = useMemo(() => {
        const classLvl = typeof report.classificationLevel === 'number' ? report.classificationLevel : 0;
        if (classLvl === 0) return 'UNCLASSIFIED';
        const c = securityClearances.find(cl => cl.level === classLvl);
        return c ? s(c.name) : 'LEVEL ' + String(classLvl);
    }, [securityClearances, report.classificationLevel]);

    const refId = reportId.split('-')[0]?.toUpperCase() || '';

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            onMinimize={onMinimize}
            title={targetId}
            subtitle={'REF: ' + refId}
            icon={isOrg ? "fa-solid fa-building" : "fa-solid fa-file-contract"}
            color={getWindowColor(threatLevel)}
            width="max-w-2xl"
            initialX={initialOffset ? 100 + initialOffset : undefined}
            initialY={initialOffset ? 80 + initialOffset : undefined}
        >
            <div className="flex flex-col h-full bg-slate-900/50">
                <div className="p-6 overflow-y-auto custom-scrollbar space-y-6 flex-1 min-h-0">

                    {/* Privacy & Classification Controls */}
                    <div className="bg-slate-950/30 border border-slate-800 rounded-xl p-4">
                        <SectionHeader title="Privacy & Classification" icon="fa-solid fa-lock" />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-4">
                            <div>
                                <label className={labelClass}>{'Classification Level'}</label>
                                {isEditing ? (
                                    <select value={classificationLevel} onChange={e => setClassificationLevel(e.target.value)} className={inputClass}>
                                        {securityClearances.map(c => <option key={c.id} value={String(c.level)}>{'Level ' + String(c.level) + ' - ' + s(c.name)}</option>)}
                                    </select>
                                ) : (
                                    <span className="inline-block bg-sky-900/20 text-sky-400 px-2 py-1 rounded-sm text-[10px] font-black uppercase border border-sky-500/30">
                                        {currentClearanceName}
                                    </span>
                                )}
                            </div>
                            <div>
                                <label className={labelClass}>{'Limiting Markers'}</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {isEditing ? (
                                        limitingMarkers.map(m => (
                                            <button
                                                key={typeof m?.id === 'number' ? m.id : 0}
                                                type="button"
                                                onClick={() => handleToggleMarker(m.id)}
                                                className={`text-[8px] px-1.5 py-0.5 rounded-sm border uppercase font-black transition-all ${selectedMarkers.has(m.id) ? 'bg-sky-600 text-white border-sky-400' : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-700'}`}
                                            >
                                                {s(m.code)}
                                            </button>
                                        ))
                                    ) : (
                                        reportMarkers.length > 0
                                            ? reportMarkers.map(m => (
                                                <span key={typeof m?.id === 'number' ? m.id : s(m?.code)} className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded-sm text-[9px] font-black uppercase border border-slate-700">
                                                    {s(m?.code)}
                                                </span>
                                            ))
                                            : <span className="text-[10px] text-slate-600 italic">{'None Applied'}</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Header Details */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className={labelClass}>{'Threat Level'}</label>
                            {isEditing ? (
                                <select value={threatLevel} onChange={(e) => setThreatLevel(e.target.value as IntelThreatLevel)} className={inputClass}>
                                    {Object.values(IntelThreatLevel).map(l => <option key={l} value={l}>{l}</option>)}
                                </select>
                            ) : (
                                <span className={`inline-block px-2 py-1 rounded-sm text-[10px] font-black uppercase border ${getWindowColor(threatLevel) === 'red' ? 'bg-red-500/10 text-red-400 border-red-500/30' : 'bg-slate-800 text-slate-300'}`}>
                                    {s(threatLevel)}
                                </span>
                            )}
                        </div>
                        {!isOrg && (
                            <div>
                                <label className={labelClass}>{'Affiliation'}</label>
                                {isEditing ? (
                                    <input type="text" value={affiliatedOrg} onChange={(e) => setAffiliatedOrg(e.target.value)} className={inputClass} placeholder="Organization" />
                                ) : (
                                    <span className="text-sm font-bold text-white uppercase tracking-tight">{s(report.affiliatedOrg, 'No Known Org')}</span>
                                )}
                            </div>
                        )}
                    </div>

                    <div>
                        <label className={labelClass}>{'Incident Report'}</label>
                        {isEditing ? (
                            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={10} className={`${inputClass} resize-none font-mono text-xs`} />
                        ) : (
                            <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800 text-slate-300 text-sm leading-relaxed whitespace-pre-wrap font-mono selection:bg-sky-500/30">
                                {summary || 'NO_REPORT_CONTENT'}
                            </div>
                        )}
                    </div>

                    {(isEditing || reportEvidence.length > 0) && (
                        <div>
                            <label className={labelClass}>{'Intelligence Artifacts (Evidence)'}</label>
                            {isEditing ? (
                                <textarea value={evidenceInput} onChange={(e) => setEvidenceInput(e.target.value)} rows={3} placeholder="https://..." className={`${inputClass} resize-none font-mono text-[10px]`} />
                            ) : (
                                <div className="space-y-2">
                                    {keyedEvidence.map(({ value: urlStr, key }) => (
                                        <a key={key} href={urlStr || '#'} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 bg-slate-800/30 p-3 rounded-lg border border-slate-700/50 hover:border-sky-500/30 transition-all group">
                                            <i className="fa-solid fa-link text-slate-600 group-hover:text-sky-400"></i>
                                            <span className="text-xs text-sky-400 font-mono truncate flex-1">{urlStr}</span>
                                            <i className="fa-solid fa-arrow-up-right-from-square text-slate-700 text-xs group-hover:text-white"></i>
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <div>
                        <label className={labelClass}>{'Classification Tags'}</label>
                        {isEditing ? (
                            <input type="text" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className={inputClass} placeholder="Tag1, Tag2..." />
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {keyedTags.map(({ value: tag, key }) => (
                                    <span key={key} className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-sm border border-slate-700 uppercase font-black tracking-tighter">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="pt-6 border-t border-white/5 flex justify-between items-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-500 shadow-inner">
                                <i className="fa-solid fa-user-shield"></i>
                            </div>
                            <div className="flex flex-col">
                                <span className="font-bold text-slate-400">{'Auth: ' + authorName}</span>
                                <span>{'Filed: ' + createdAt}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-950 flex flex-wrap justify-between items-center rounded-b-xl gap-4 shrink-0">
                    <div className="flex gap-2">
                        {canDelete && !isEditing && onDelete && (
                            <button onClick={onDelete} className="px-4 py-2 bg-red-600/10 text-red-500 border border-red-500/30 hover:bg-red-600 hover:text-white rounded-sm text-[10px] font-black uppercase transition-all">{'Delete'}</button>
                        )}
                        {canEdit && !isEditing && (
                            <button onClick={() => setIsEditing(true)} className="px-4 py-2 bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 rounded-sm text-[10px] font-black uppercase transition-all">{'Edit'}</button>
                        )}
                        <button
                            onClick={handleDossierOpen}
                            disabled={!aiConfig.enabled}
                            className={`px-4 py-2 rounded text-[10px] font-black uppercase transition-all ${
                                aiConfig.enabled
                                    ? 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700'
                                    : 'bg-slate-800/50 text-slate-600 border border-slate-700/30 cursor-not-allowed'
                            }`}
                            title={aiConfig.enabled ? 'View Dossier' : 'Dossier unavailable — Gemini API key not configured by organization admin'}
                        >
                            {!aiConfig.enabled && <i className="fa-solid fa-lock text-[9px] mr-1.5"></i>}
                            {'Dossier'}
                        </button>
                    </div>

                    {isEditing ? (
                        <div className="flex gap-2">
                            <button onClick={() => setIsEditing(false)} className="px-4 py-2 bg-slate-800 text-slate-400 hover:text-white rounded-sm text-[10px] font-black uppercase transition-all">{'Cancel'}</button>
                            <button onClick={handleSave} disabled={isLoading} className="px-6 py-2 bg-green-600 hover:bg-green-500 text-white rounded-sm text-[10px] font-black uppercase transition-all shadow-lg shadow-green-900/20">
                                {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Changes'}
                            </button>
                        </div>
                    ) : (
                        <button onClick={onClose} className="px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-sm text-[10px] font-black uppercase transition-all">{'Close'}</button>
                    )}
                </div>
            </div>
        </WindowFrame>
    );
};

export default IntelReportDetailModal;
