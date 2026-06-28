import React from 'react';
import { HydratedIntelligenceReport } from '../../../types';
import { useAuth } from '../../../contexts/AuthContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { ACCENTS } from '../../shared/ui/accents';
import { IntelPill } from '../operations/requests/pills';
import {
    threatAccent,
    threatIsAlarm,
    subjectIcon,
    subjectLabel,
    timeAgoShort,
} from './intelStyles';

interface Props {
    report: HydratedIntelligenceReport;
    onClick: () => void;
    onViewDossier: (targetId: string) => void;
    onDelete?: (e: React.MouseEvent) => void;
    isDeleting?: boolean;
    /** When provided, tags render as clickable chips that call this. */
    onTagClick?: (tag: string) => void;
}

/** String coercion — guarantees a primitive string for JSX. */
const s = (v: unknown, fallback = ''): string => {
    if (v == null) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback;
};

const IntelligenceReportCard: React.FC<Props> = ({
    report,
    onClick,
    onViewDossier,
    onDelete,
    isDeleting,
    onTagClick,
}) => {
    const { currentUser } = useAuth();
    const { securityClearances } = useMembers();
    const { aiConfig } = useConfig();

    const isAuthor = currentUser?.id === report.createdBy?.id;
    const markers = Array.isArray(report.limitingMarkers) ? report.limitingMarkers : [];
    const tags = Array.isArray(report.tags) ? report.tags : [];
    const targetId = s(report.targetId);
    const summary = s(report.summary);
    const affiliatedOrg = s(report.affiliatedOrg);
    const classLevel = typeof report.classificationLevel === 'number' ? report.classificationLevel : 0;
    const authorName = s(report.createdBy?.name) || s(report.externalAuthor) || 'SYSTEM';
    const sourceFeedLabel = s(report.sourceFeedLabel);

    const accentKey = threatAccent(report.threatLevel);
    const a = ACCENTS[accentKey];
    const isAlarm = threatIsAlarm(report.threatLevel);

    const subjectT = s(report.subjectType);
    const subjIcon = subjectIcon(subjectT);
    const reportShortId = report.id ? report.id.substring(0, 6).toUpperCase() : '------';
    const clearanceName = securityClearances.find(c => c.level === classLevel)?.name || `LEVEL ${classLevel}`;

    return (
        <div
            onClick={onClick}
            className={`group relative h-full rounded-xl overflow-hidden border border-white/10 bg-linear-to-br from-slate-900/80 via-slate-900/60 to-slate-950/80 backdrop-blur-xs shadow-lg transition-all duration-300 cursor-pointer hover:border-white/20 hover:shadow-xl ${isDeleting ? 'opacity-70 pointer-events-none' : ''}`}
        >
            <div className={`absolute inset-y-0 left-0 w-1 ${a.dot} ${isAlarm ? 'animate-pulse' : ''}`} aria-hidden />

            <div
                className={`absolute -top-20 -left-10 w-64 h-64 ${a.bg} rounded-full blur-[90px] opacity-0 group-hover:opacity-60 pointer-events-none transition-opacity duration-500`}
                aria-hidden
            />

            {/* Content column — reserves space at bottom for the absolute footer */}
            <div className="flex flex-col h-full pb-[52px]">

            <div className="relative pl-4 pr-3 py-3 bg-slate-950/40 border-b border-white/5 flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-10 h-10 rounded-lg ${a.bg} border ${a.border} flex items-center justify-center shrink-0`}>
                        <i className={`fa-solid ${subjIcon} ${a.text} text-base`} aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h3 className="text-white font-black text-base sm:text-lg uppercase tracking-tight truncate font-mono">
                            {targetId}
                        </h3>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="font-mono text-[10px] text-slate-500 tracking-wider">REP-{reportShortId}</span>
                            <span className="text-slate-700">·</span>
                            <span className="text-[10px] text-slate-500 font-mono">
                                <i className="fa-regular fa-clock mr-1" aria-hidden />
                                {timeAgoShort(report.createdAt)}
                            </span>
                            <span className="text-slate-700">·</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                {subjectLabel(subjectT)}
                            </span>
                            {affiliatedOrg && (
                                <>
                                    <span className="text-slate-700">·</span>
                                    <span className="text-[10px] font-mono text-slate-400 truncate max-w-[120px]">
                                        @ {affiliatedOrg}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {sourceFeedLabel && (
                        <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest bg-sky-500/10 text-sky-300 border-sky-500/30"
                            title={sourceFeedLabel}
                        >
                            <i className="fa-solid fa-satellite-dish" aria-hidden /> EXT
                        </span>
                    )}
                    <IntelPill level={report.threatLevel} size="sm" />
                </div>
            </div>

            {/* BODY — flex-1 + min-h-0 + overflow-hidden so any overflow is clipped rather than pushing the footer out of view */}
            <div className="relative pl-4 pr-4 py-4 flex-1 min-h-0 overflow-hidden flex flex-col gap-3 min-w-0">
                <p className="text-sm text-slate-300 font-mono leading-relaxed line-clamp-4 shrink">
                    {summary}
                </p>

                {/* Tags — single-row clip so many tags don't stack and push content */}
                {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 max-h-[26px] overflow-hidden shrink-0">
                        {tags.map((tag) => {
                            const t = s(tag);
                            if (!t) return null;
                            if (onTagClick) {
                                return (
                                    <button
                                        key={t}
                                        onClick={(e) => { e.stopPropagation(); onTagClick(t); }}
                                        className="inline-flex items-center px-2 py-0.5 rounded-sm border font-mono text-[10px] uppercase tracking-wider bg-slate-900/60 border-white/10 text-slate-400 hover:bg-sky-500/10 hover:border-sky-500/30 hover:text-sky-300 transition-colors"
                                        title={`Filter by tag "${t}"`}
                                    >
                                        <span className="opacity-60 mr-0.5">#</span>{t}
                                    </button>
                                );
                            }
                            return (
                                <span key={t} className="inline-flex items-center px-2 py-0.5 rounded-sm border font-mono text-[10px] uppercase tracking-wider bg-slate-900/40 border-white/5 text-slate-500">
                                    <span className="opacity-60 mr-0.5">#</span>{t}
                                </span>
                            );
                        })}
                    </div>
                )}

                {/* Classification + markers — single-row clip */}
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono max-h-[24px] overflow-hidden shrink-0">
                    <span className="text-slate-600 uppercase font-black tracking-widest">CLR</span>
                    <span className="px-1.5 py-0.5 rounded-sm bg-slate-900/60 text-slate-300 border border-white/10 uppercase font-black tracking-wider">
                        {clearanceName}
                    </span>
                    {markers.length > 0 && (
                        <>
                            <span className="text-slate-600 uppercase font-black tracking-widest ml-1">MKR</span>
                            {markers.map((m) => (
                                <span
                                    key={typeof m?.id === 'number' ? m.id : s(m?.code)}
                                    className="px-1.5 py-0.5 rounded-sm bg-slate-950/60 text-sky-400 border border-sky-500/20 uppercase font-black tracking-wider"
                                    title={s((m as any)?.name) || s(m?.code)}
                                >
                                    {s(m?.code)}
                                </span>
                            ))}
                        </>
                    )}
                </div>
            </div>

            </div>

            {/* FOOTER — absolutely positioned at the bottom so long content cannot push it below the card edge */}
            <div className="absolute bottom-0 left-0 right-0 z-10 pl-4 pr-3 py-2.5 bg-slate-950/60 backdrop-blur-xs border-t border-white/5 flex items-center justify-between gap-3">
                <div className="min-w-0 font-mono text-[10px] text-slate-500 uppercase tracking-widest truncate">
                    AUTH · {authorName}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <button
                        onClick={(e) => { e.stopPropagation(); onViewDossier(targetId); }}
                        disabled={!aiConfig.enabled}
                        title={aiConfig.enabled ? 'View Dossier' : 'Dossier unavailable — Gemini API key not configured'}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[10px] font-black uppercase tracking-widest border transition-colors ${
                            aiConfig.enabled
                                ? 'bg-sky-500/10 text-sky-300 border-sky-500/30 hover:bg-sky-500/20'
                                : 'bg-slate-800/40 text-slate-600 border-slate-700/40 cursor-not-allowed'
                        }`}
                    >
                        <i className={`fa-solid ${aiConfig.enabled ? 'fa-folder-open' : 'fa-lock'}`} aria-hidden />
                        <span className="hidden sm:inline">Dossier</span>
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onClick(); }}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-widest bg-slate-800/60 text-slate-200 border border-white/10 hover:bg-slate-700/80 transition-colors"
                    >
                        <i className="fa-solid fa-circle-info" aria-hidden />
                        <span className="hidden sm:inline">Details</span>
                    </button>
                    {onDelete && (isAuthor || !report.createdBy) && (
                        <button
                            onClick={onDelete}
                            disabled={isDeleting}
                            title="Purge Record"
                            className="p-1.5 rounded-sm text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                            {isDeleting
                                ? <i className="fa-solid fa-spinner animate-spin text-sm" aria-hidden />
                                : <i className="fa-solid fa-trash-can text-sm" aria-hidden />}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default IntelligenceReportCard;
