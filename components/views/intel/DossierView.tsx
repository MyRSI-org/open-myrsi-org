import React, { useMemo, useState, useEffect } from 'react';
import { DossierData, IntelThreatLevel, IntelSubjectType, WarrantStatus, HydratedIntelligenceReport } from '../../../types';
import { useData } from '../../../contexts/DataContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import IntelligenceReportCard from './IntelligenceReportCard';
import IntelReportDetailModal from '../../modals/IntelReportDetailModal';
import CallsignChip from '../../shared/ui/CallsignChip';
import { ACCENTS } from '../../shared/ui/accents';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';
import {
    threatAccent,
    threatIcon,
    threatLabel,
    threatIsAlarm,
    subjectIcon,
    subjectLabel,
    timeAgoShort,
    formatDateCompact,
    humaniseAiError,
} from './intelStyles';

interface DossierViewProps {
    dossier: DossierData;
    onBack: () => void;
    onRefresh: () => void;
    onDeleteReport?: (id: string) => Promise<void>;
    /** Full drilldown stack including the current target id (last element). */
    breadcrumbStack: string[];
    /** Jump to stack index (0 = hub root, stack.length-1 = current). */
    onBreadcrumbJump: (index: number) => void;
    /** Push a new affiliate onto the drilldown stack. */
    onDrilldown: (targetId: string) => void;
    /** Close dossier + pre-filter hub by this tag. */
    onTagClick?: (tag: string) => void;
    /** True while a new dossier is being fetched (e.g. after drilldown). */
    isLoading?: boolean;
}

const s = (v: unknown, fallback = ''): string => {
    if (v == null) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback;
};

const n = (v: unknown, fallback = 0): number => {
    if (typeof v === 'number' && !isNaN(v)) return v;
    return fallback;
};

// Stable synthetic React key for the rare malformed server record that is missing its
// own id. Keyed by object identity so the same record keeps the same key across
// re-renders (unlike an array index, which shifts when the list mutates). This is a
// render-only key; it never touches any submit payload.
const synthKeys = new WeakMap<object, string>();
let synthKeySeq = 0;
const stableKey = (obj: unknown): string => {
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
        return `k${synthKeySeq++}`;
    }
    const existing = synthKeys.get(obj as object);
    if (existing) return existing;
    const k = `k${synthKeySeq++}`;
    synthKeys.set(obj as object, k);
    return k;
};

const THREAT_LEVELS = [IntelThreatLevel.None, IntelThreatLevel.Low, IntelThreatLevel.Medium, IntelThreatLevel.High, IntelThreatLevel.Critical];

const DossierView: React.FC<DossierViewProps> = ({
    dossier,
    onBack,
    onRefresh,
    onDeleteReport,
    breadcrumbStack,
    onBreadcrumbJump,
    onDrilldown,
    onTagClick,
    isLoading = false,
}) => {
    const { rpcAction, isFetching } = useData();
    const { aiConfig } = useConfig();
    const { hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { confirm: uiConfirm, addToast } = useNotification();
    const { openWindow } = useModalRegistry();

    // Memoise the `? : []` derivations so the empty-array branch keeps a stable reference,
    // letting downstream memos recompute only when the dossier slice actually changes.
    // The raw slices are read into locals so the memo body and dependency reference the
    // same expression, letting the React Compiler preserve the manual memoization.
    const rawReports = dossier?.reports;
    const rawWarrants = dossier?.warrants;
    const reports: HydratedIntelligenceReport[] = useMemo(
        () => Array.isArray(rawReports) ? rawReports : [],
        [rawReports],
    );
    const warrants = useMemo(
        () => Array.isArray(rawWarrants) ? rawWarrants : [],
        [rawWarrants],
    );
    const requests = Array.isArray(dossier?.requests) ? dossier.requests : [];
    const operations = Array.isArray(dossier?.operations) ? dossier.operations : [];
    const affiliates = Array.isArray(dossier?.affiliates) ? dossier.affiliates : [];
    const targetId = s(dossier?.targetId);

    // Seed the locally-editable AI summary from the dossier's cached summary (if any).
    // `aiSummary` diverges from `dossier.cachedSummary` after the user clicks Generate
    // (which sets fresh text without mutating the dossier prop), so it is editable state,
    // not a pure derivation.
    const seedSummary = (d: DossierData | undefined): string | null =>
        typeof d?.cachedSummary === 'string' && d.cachedSummary.length > 0 ? d.cachedSummary : null;

    const [aiSummary, setAiSummary] = useState<string | null>(() => seedSummary(dossier));
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
    const [activeTab, setActiveTab] = useState<'overview' | 'reports' | 'affiliations'>('overview');
    const [selectedReport, setSelectedReport] = useState<HydratedIntelligenceReport | null>(null);
    const [systemTime, setSystemTime] = useState(() => new Date());
    const [aiError, setAiError] = useState<string | null>(null);

    // Reset the locally-editable AI summary/error state when the dossier target or its
    // cached summary changes, using the React "adjust state during render" pattern with a
    // previous-value tracker. This re-seeds before paint (no effect, no flash) and is
    // behavior-equivalent to the old reset-on-id-change effect.
    const [prevSummaryKey, setPrevSummaryKey] = useState<string | undefined>(dossier?.cachedSummary);
    const [prevTargetKey, setPrevTargetKey] = useState<string | undefined>(dossier?.targetId);
    if (dossier?.cachedSummary !== prevSummaryKey || dossier?.targetId !== prevTargetKey) {
        setPrevSummaryKey(dossier?.cachedSummary);
        setPrevTargetKey(dossier?.targetId);
        setAiSummary(seedSummary(dossier));
        setAiError(null);
    }

    useEffect(() => {
        const timer = setInterval(() => setSystemTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const isOrg = useMemo(() => {
        if (reports.length === 0) return false;
        const primary = reports.find(r => s(r.targetId).toLowerCase() === targetId.toLowerCase());
        return s(primary?.subjectType) === IntelSubjectType.Organization;
    }, [reports, targetId]);

    const maxThreatLevel = useMemo(() => {
        let currentThreat: IntelThreatLevel = IntelThreatLevel.None;
        for (const r of reports) {
            const rLevel = s(r.threatLevel) as IntelThreatLevel;
            if (THREAT_LEVELS.indexOf(rLevel) > THREAT_LEVELS.indexOf(currentThreat)) {
                currentThreat = rLevel;
            }
        }
        const hasActiveWarrant = warrants.some(w => {
            const ws = s(w.status);
            return ws === WarrantStatus.Active || ws === WarrantStatus.Standing;
        });
        if (hasActiveWarrant && THREAT_LEVELS.indexOf(currentThreat) < THREAT_LEVELS.indexOf(IntelThreatLevel.High)) {
            return IntelThreatLevel.High;
        }
        return currentThreat;
    }, [reports, warrants]);

    const activeWarrants = useMemo(() =>
        warrants.filter(w => {
            const ws = s(w.status);
            return ws === WarrantStatus.Active || ws === WarrantStatus.Standing;
        }),
    [warrants]);

    const isLocked = useMemo(() => {
        const raw = s(dossier?.cachedSummaryDate);
        if (!raw) return false;
        const lastGen = new Date(raw).getTime();
        if (isNaN(lastGen)) return false;
        // Read the wall-clock time from `systemTime` (ticks every second) instead of
        // calling Date.now() during render, keeping the memo pure while still
        // re-evaluating the 24h cooldown on each tick.
        return (systemTime.getTime() - lastGen) < 24 * 60 * 60 * 1000;
    }, [dossier?.cachedSummaryDate, systemTime]);

    const timeLeft = useMemo(() => {
        const raw = s(dossier?.cachedSummaryDate);
        if (!raw) return '';
        const lastGen = new Date(raw).getTime();
        if (isNaN(lastGen)) return '';
        // Same pattern as isLocked above — drive the countdown from the per-second
        // `systemTime` tick rather than an impure Date.now() call during render.
        const diff = (lastGen + 24 * 60 * 60 * 1000) - systemTime.getTime();
        if (diff <= 0) return '';
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        return `${hours}h ${mins}m`;
    }, [dossier?.cachedSummaryDate, systemTime]);

    const handleGenerateSummary = async () => {
        if (isLocked) return;
        setIsGeneratingSummary(true);
        setAiError(null);
        try {
            const res = await rpcAction('intel:generate_summary', { dossier });
            const text = typeof res === 'string' ? res : res ? String(res) : '';
            if (text.startsWith('QUOTA_EXCEEDED:') || text.startsWith('Error:') || text.startsWith('System Error:')) {
                setAiError(text);
            } else if (text) {
                setAiSummary(text);
                setAiError(null);
            } else {
                setAiError('Error: AI returned an empty response. Please try again later.');
            }
        } catch {
            setAiError('Error: Failed to generate summary. The AI service may be temporarily unavailable.');
        } finally {
            setIsGeneratingSummary(false);
        }
    };

    const handleDeleteReport = async (reportId: string) => {
        if (onDeleteReport) {
            await onDeleteReport(reportId);
            setSelectedReport(null);
        } else {
            const confirmed = await uiConfirm({
                title: 'Purge Intelligence Record',
                message: 'Permanently delete this intelligence report? This action cannot be reversed.',
                confirmText: 'Purge Record',
                variant: 'danger',
            });
            if (!confirmed) return;
            try {
                await rpcAction('intel:delete_report', { reportId });
                onRefresh();
                setSelectedReport(null);
            } catch {
                addToast('Delete Failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Failed to delete the intelligence report.' });
            }
        }
    };

    const [copiedId, setCopiedId] = useState(false);
    const handleCopyTarget = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(targetId);
        setCopiedId(true);
        setTimeout(() => setCopiedId(false), 2000);
    };

    const threatA = ACCENTS[threatAccent(maxThreatLevel)];
    const tIcon = threatIcon(maxThreatLevel);
    const isAlarm = threatIsAlarm(maxThreatLevel);

    const humanisedError = useMemo(() => aiError ? humaniseAiError(aiError) : null, [aiError]);

    // AI Analysis Card header derivations — computed here (instead of an IIFE in JSX)
    // so the React Compiler can optimize them. Pure string derivations, no side effects.
    const aiAvailable = !!aiConfig.enabled;
    const aiHeaderAccent = !aiAvailable
        ? 'bg-slate-700/30 border border-slate-600/40 text-slate-400'
        : humanisedError
            ? (humanisedError.kind === 'quota' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300' : 'bg-red-500/10 border border-red-500/30 text-red-300')
            : 'bg-indigo-500/10 border border-indigo-500/30 text-indigo-300';
    const aiHeaderIcon = !aiAvailable
        ? 'fa-key'
        : humanisedError
            ? (humanisedError.kind === 'quota' ? 'fa-clock' : 'fa-circle-exclamation')
            : 'fa-microchip';
    const aiSubtitle = !aiAvailable
        ? 'Awaiting configuration'
        : humanisedError
            ? humanisedError.title
            : aiSummary
                ? 'Analysis available'
                : 'Ready to scan';

    // Split the (immutable) AI summary into header/body tokens for rendering. The whole
    // list is regenerated wholesale whenever `aiSummary` changes and is never reordered,
    // so the array index is a stable, collision-free key per summary (a char-offset key
    // collides when split() emits a zero-length leading token before a header).
    const summaryParts = useMemo(() => {
        if (!aiSummary) return [];
        return aiSummary.split(/(\[\d\.\d\].*)/).map((part, i) => {
            const isHeader = typeof part === 'string' && part.startsWith('[') && part.includes(']');
            return { key: `p${i}`, part, isHeader };
        });
    }, [aiSummary]);

    const statItems: { label: string; value: number; icon: string; accent: keyof typeof ACCENTS }[] = [
        { label: 'Reports', value: reports.length, icon: 'fa-file-lines', accent: 'sky' },
        ...(!isOrg ? [
            { label: 'Operations', value: operations.length, icon: 'fa-crosshairs', accent: 'emerald' as const },
            { label: 'Cautions', value: warrants.length, icon: 'fa-triangle-exclamation', accent: 'red' as const },
            { label: 'Interactions', value: requests.length, icon: 'fa-handshake', accent: 'amber' as const },
        ] : []),
        { label: isOrg ? 'Members' : 'Affiliations', value: affiliates.length, icon: isOrg ? 'fa-users' : 'fa-diagram-project', accent: 'purple' },
    ];

    const tabs = [
        { id: 'overview' as const, label: 'Overview', icon: 'fa-gauge-high', count: undefined as number | undefined },
        { id: 'reports' as const, label: 'Intel Reports', icon: 'fa-file-lines', count: reports.length },
        { id: 'affiliations' as const, label: isOrg ? 'Known Members' : 'Affiliations', icon: isOrg ? 'fa-users' : 'fa-diagram-project', count: affiliates.length },
    ];

    // The drilldown stack is an ordered path where the same target id can legitimately
    // repeat (cycles), so a breadcrumb's stable identity is its cumulative path prefix
    // (e.g. "A", "A>A", "A>A>B") rather than its bare position. Precompute that key here so
    // it stays stable as the stack only grows/shrinks at the end.
    const breadcrumbCrumbs = useMemo(
        () => breadcrumbStack.map((id, idx) => ({
            id,
            idx,
            key: breadcrumbStack.slice(0, idx + 1).join('›'),
        })),
        [breadcrumbStack],
    );

    return (
        <div className="h-full flex flex-col overflow-y-auto custom-scrollbar animate-fade-in bg-slate-950">
            <header className={`shrink-0 relative overflow-hidden border-b border-white/5 ${threatA.heroGrad}`}>
                <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] ${threatA.heroOrb} rounded-full blur-[120px] pointer-events-none`} aria-hidden />

                <div className="relative px-4 sm:px-8 pt-4 sm:pt-6 pb-4">
                    <div className="max-w-7xl mx-auto w-full">
                        <button
                            onClick={onBack}
                            className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors mb-3"
                        >
                            <i className="fa-solid fa-arrow-left" aria-hidden /> Return to Intel Hub
                        </button>

                        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3 lg:gap-4">
                            <div className="min-w-0 flex items-center gap-4">
                                <div
                                    className={`hidden sm:flex w-14 h-14 md:w-16 md:h-16 rounded-xl ${threatA.bg} border ${threatA.border} items-center justify-center shrink-0`}
                                >
                                    <i className={`fa-solid ${subjectIcon(isOrg ? IntelSubjectType.Organization : IntelSubjectType.Person)} ${threatA.text} text-2xl md:text-3xl`} aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <div className="hidden sm:flex items-center gap-2 mb-2">
                                        <CallsignChip
                                            label={`DOSSIER · ${targetId}`}
                                            icon="fa-satellite-dish"
                                            accent={threatAccent(maxThreatLevel)}
                                            pulse={isAlarm}
                                        />
                                        <button
                                            onClick={handleCopyTarget}
                                            title="Copy target ID"
                                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border font-mono text-[10px] uppercase tracking-widest bg-slate-900/60 border-white/10 text-slate-400 hover:text-slate-200 transition-colors"
                                        >
                                            {copiedId ? <><i className="fa-solid fa-check text-emerald-400" aria-hidden /> Copied</> : <><i className="fa-regular fa-copy" aria-hidden /> Copy</>}
                                        </button>
                                    </div>
                                    <h1 className="text-2xl sm:text-3xl md:text-4xl font-black text-white tracking-tight leading-tight flex items-center gap-3 flex-wrap font-mono uppercase">
                                        <span className="truncate">{targetId}</span>
                                        {isFetching['intel'] && (
                                            <span className={`${threatA.text} text-xs font-mono uppercase tracking-widest animate-pulse inline-flex items-center gap-1`}>
                                                <i className="fa-solid fa-arrows-rotate fa-spin" aria-hidden /> Syncing
                                            </span>
                                        )}
                                    </h1>
                                    <p className="text-xs sm:text-sm text-slate-400 mt-1">
                                        {subjectLabel(isOrg ? IntelSubjectType.Organization : IntelSubjectType.Person)} Dossier
                                        {reports.length > 0 && (
                                            <> · {reports.length} report{reports.length !== 1 ? 's' : ''} on file</>
                                        )}
                                    </p>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-black text-[11px] uppercase tracking-wider ${threatA.bg} ${threatA.border} ${threatA.text} ${isAlarm ? 'animate-pulse' : ''}`}>
                                    <i className={`fa-solid ${tIcon}`} aria-hidden />
                                    {threatLabel(maxThreatLevel)}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {breadcrumbStack.length > 0 && (
                <nav className="shrink-0 sticky top-0 z-20 backdrop-blur-md bg-slate-950/80 border-b border-white/5">
                    <div className="max-w-7xl mx-auto w-full px-4 sm:px-8 py-2 flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest overflow-x-auto custom-scrollbar">
                        <button
                            onClick={() => onBreadcrumbJump(-1)}
                            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-sky-300 transition-colors whitespace-nowrap"
                        >
                            <i className="fa-solid fa-house text-[10px]" aria-hidden /> Intel Hub
                        </button>
                        {breadcrumbCrumbs.map(({ id, idx, key }) => {
                            const isLast = idx === breadcrumbStack.length - 1;
                            return (
                                <React.Fragment key={key}>
                                    <i className="fa-solid fa-chevron-right text-[9px] text-slate-700" aria-hidden />
                                    {isLast ? (
                                        <span className="text-rose-300 font-bold whitespace-nowrap truncate max-w-[180px] inline-flex items-center gap-1.5" title={id}>
                                            {id}
                                            {isLoading && <i className="fa-solid fa-circle-notch fa-spin text-[10px] text-sky-400" aria-hidden />}
                                        </span>
                                    ) : (
                                        <button
                                            onClick={() => onBreadcrumbJump(idx)}
                                            className="text-slate-400 hover:text-sky-300 transition-colors whitespace-nowrap truncate max-w-[140px]"
                                            title={`Jump to ${id}`}
                                        >
                                            {id}
                                        </button>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>
                </nav>
            )}

            <div className={`max-w-7xl mx-auto w-full px-4 sm:px-8 flex flex-col gap-6 mt-6 pb-8 transition-opacity duration-200 ${isLoading ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
                {!isOrg && activeWarrants.length > 0 && (
                    <button
                        onClick={() => setActiveTab('overview')}
                        className="group relative rounded-xl overflow-hidden border border-red-500/40 bg-linear-to-r from-red-950/30 via-red-950/20 to-slate-950 flex items-center gap-3 px-4 py-3 text-left hover:border-red-500/60 transition-colors"
                    >
                        <div className="absolute inset-y-0 left-0 w-1 bg-red-500 animate-pulse" aria-hidden />
                        <div className="w-10 h-10 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center shrink-0 animate-pulse">
                            <i className="fa-solid fa-bullseye text-red-400 text-lg" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-black uppercase tracking-widest text-red-400/80">Active Cautions · {activeWarrants.length}</p>
                            <p className="text-sm font-bold text-red-100 truncate">
                                {s(activeWarrants[0]?.action)} ADVISORY — {s(activeWarrants[0]?.reason)}
                                {activeWarrants.length > 1 && <span className="text-red-400/60"> · +{activeWarrants.length - 1} more</span>}
                            </p>
                        </div>
                        <i className="fa-solid fa-chevron-right text-red-400/60 text-xs" aria-hidden />
                    </button>
                )}

                <div className={`grid gap-3 ${isOrg ? 'grid-cols-2' : 'grid-cols-3 md:grid-cols-5'}`}>
                    {statItems.map(stat => {
                        const a = ACCENTS[stat.accent];
                        return (
                            <div key={stat.label} className="rounded-xl border border-white/10 bg-slate-900/40 p-3 flex items-center gap-3">
                                <div className={`w-9 h-9 rounded-lg ${a.bg} border ${a.border} flex items-center justify-center shrink-0`}>
                                    <i className={`fa-solid ${stat.icon} ${a.text} text-sm`} aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xl font-black text-white font-mono leading-none">{String(stat.value)}</p>
                                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mt-1">{stat.label}</p>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="flex gap-1 bg-slate-900/40 p-1 rounded-lg border border-white/10 w-fit overflow-x-auto custom-scrollbar max-w-full">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`shrink-0 px-4 py-2 text-xs font-bold uppercase tracking-wider transition-all rounded-md flex items-center gap-2 whitespace-nowrap ${activeTab === tab.id ? 'bg-sky-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
                        >
                            <i className={`fa-solid ${tab.icon}`} aria-hidden />
                            {tab.label}
                            {tab.count !== undefined && <span className="text-[10px] opacity-60 font-mono">{tab.count}</span>}
                        </button>
                    ))}
                </div>

                {activeTab === 'overview' && (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="lg:col-span-2 space-y-6">
                            {/* AI Analysis Card — always rendered. When AI isn't configured for the
                                org, the Generate button is disabled and the empty state explains why.
                                Header derivations (aiAvailable / aiHeaderAccent / aiHeaderIcon /
                                aiSubtitle) are computed in the component body above. */}
                            {(
                                <div className="rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
                                    <div className="px-5 py-3 bg-slate-950/40 border-b border-white/5 flex justify-between items-center gap-3">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${aiHeaderAccent}`}>
                                                <i className={`fa-solid ${aiHeaderIcon}`} aria-hidden />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="text-sm font-bold text-white">AI Tactical Analysis</h3>
                                                <p className="text-[10px] text-slate-500 uppercase tracking-widest">
                                                    {aiSubtitle}
                                                    {aiAvailable && aiSummary && !humanisedError && dossier.cachedSummaryDate && (
                                                        <span className="text-slate-600 normal-case tracking-normal"> · generated {timeAgoShort(dossier.cachedSummaryDate)} ago</span>
                                                    )}
                                                </p>
                                            </div>
                                        </div>
                                        {/* AI summary generation is gated server-side at intel:manage
                                            (it writes the global per-target cache only managers can read).
                                            Hide the trigger from non-managers so they don't get a button that 403s. */}
                                        {hasPermission('intel:manage') && (
                                        <button
                                            onClick={handleGenerateSummary}
                                            disabled={!aiAvailable || isGeneratingSummary || isLocked}
                                            title={!aiAvailable ? 'An organization administrator must install a Gemini API key before AI analysis can be generated.' : undefined}
                                            className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border transition-colors ${
                                                !aiAvailable
                                                    ? 'bg-slate-800/40 text-slate-600 border-slate-700/40 cursor-not-allowed'
                                                    : isLocked
                                                        ? 'bg-slate-800/40 text-slate-500 border-slate-700/40 cursor-not-allowed'
                                                        : humanisedError
                                                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20'
                                                            : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/20'
                                            }`}
                                        >
                                            {isGeneratingSummary
                                                ? <i className="fa-solid fa-spinner animate-spin" aria-hidden />
                                                : !aiAvailable ? 'Unavailable' : isLocked ? 'Locked' : humanisedError ? 'Retry' : 'Generate'}
                                        </button>
                                        )}
                                    </div>

                                    <div className="p-5 relative">
                                        {isGeneratingSummary && (
                                            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs flex flex-col items-center justify-center z-10">
                                                <i className="fa-solid fa-microchip text-indigo-300 text-2xl animate-pulse mb-3" aria-hidden />
                                                <p className="text-xs font-bold text-indigo-200 uppercase tracking-widest animate-pulse">Analyzing intelligence data…</p>
                                            </div>
                                        )}

                                        {/* AI not configured for this org — takes precedence over all other states */}
                                        {!aiAvailable && !aiSummary && (
                                            <div className="py-10 flex flex-col items-center justify-center text-slate-500 text-center">
                                                <i className="fa-solid fa-key text-3xl mb-3 text-slate-600" aria-hidden />
                                                <p className="text-xs font-black uppercase tracking-widest text-slate-300">AI Key Not Installed</p>
                                                <p className="text-[10px] text-slate-500 mt-1.5 max-w-xs">
                                                    Tactical analysis is unavailable until an organization administrator installs a Gemini API key.
                                                </p>
                                            </div>
                                        )}

                                        {/* Locked state: prominent countdown */}
                                        {aiAvailable && isLocked && !aiSummary && !humanisedError && (
                                            <div className="py-10 flex flex-col items-center justify-center text-center">
                                                <i className="fa-solid fa-hourglass-half text-slate-500 text-3xl mb-3" aria-hidden />
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Rate limit active</p>
                                                <p className="text-2xl font-black font-mono text-slate-200 mt-2">{timeLeft || '—'}</p>
                                                <p className="text-[10px] text-slate-500 mt-2">until next analysis</p>
                                            </div>
                                        )}

                                        {/* Error state */}
                                        {aiAvailable && humanisedError && !aiSummary && (
                                            <div className={`p-4 rounded-lg text-sm leading-relaxed border ${humanisedError.kind === 'quota' ? 'bg-amber-900/10 border-amber-500/20 text-amber-200/90' : 'bg-red-900/10 border-red-500/20 text-red-200/90'}`}>
                                                <div className={`flex items-center gap-2 mb-2 font-black text-xs uppercase tracking-widest ${humanisedError.kind === 'quota' ? 'text-amber-300' : 'text-red-300'}`}>
                                                    <i className={`fa-solid ${humanisedError.kind === 'quota' ? 'fa-clock' : 'fa-circle-exclamation'}`} aria-hidden />
                                                    {humanisedError.title}
                                                </div>
                                                {humanisedError.body}
                                            </div>
                                        )}

                                        {/* Summary available — render even if AI was later disabled, so cached summaries stay visible */}
                                        {aiSummary && (
                                            <div className="text-slate-300 leading-relaxed text-sm whitespace-pre-wrap font-mono">
                                                {summaryParts.map(({ key, part, isHeader }) => {
                                                    if (isHeader) {
                                                        return (
                                                            <div key={key} className="inline-flex items-center gap-2 mt-6 mb-3 pb-2 text-base font-black tracking-widest text-indigo-300 border-b border-indigo-500/20 w-full not-first:mt-8">
                                                                <i className="fa-solid fa-bookmark text-indigo-400 text-sm" aria-hidden />
                                                                <span>{part}</span>
                                                            </div>
                                                        );
                                                    }
                                                    return <span key={key}>{s(part)}</span>;
                                                })}
                                            </div>
                                        )}

                                        {/* Empty state (AI configured, no summary, no error, not locked) */}
                                        {aiAvailable && !aiSummary && !humanisedError && !isLocked && (
                                            <div className="py-10 flex flex-col items-center justify-center text-slate-500 text-center">
                                                <i className="fa-solid fa-microchip text-3xl mb-3 text-slate-600" aria-hidden />
                                                <p className="text-xs font-black uppercase tracking-widest">No analysis generated yet</p>
                                                <p className="text-[10px] text-slate-600 mt-1">Click Generate to run AI tactical analysis on this dossier.</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Active Warrants (detailed) */}
                            {!isOrg && activeWarrants.length > 0 && (
                                <div className="rounded-xl border border-red-500/20 bg-slate-900/40 overflow-hidden">
                                    <div className="px-5 py-3 bg-red-500/5 border-b border-red-500/10 flex items-center gap-2">
                                        <i className="fa-solid fa-bullseye text-red-400 text-sm" aria-hidden />
                                        <h3 className="text-xs font-black text-red-300 uppercase tracking-widest">Active Cautions</h3>
                                        <span className="text-[10px] font-mono font-bold text-red-400/60 ml-auto">{activeWarrants.length}</span>
                                    </div>
                                    <div className="divide-y divide-white/5">
                                        {activeWarrants.map((w) => {
                                            const wId = s(w.id);
                                            const wAction = s(w.action);
                                            const wReason = s(w.reason);
                                            const wIssuedAt = formatDateCompact(w.issuedAt, fmt.prefs);
                                            const wReward = n(w.uecReward);
                                            return (
                                                <div key={wId || stableKey(w)} className="p-4 flex justify-between items-start gap-4 hover:bg-red-500/5 transition-colors">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-3 mb-1">
                                                            <span className="text-xs font-black text-red-300 uppercase tracking-widest">{wAction} Advisory</span>
                                                            <span className="text-[10px] text-slate-600 font-mono">#{wId.substring(0, 8).toUpperCase()}</span>
                                                        </div>
                                                        <p className="text-white font-bold text-sm mb-1.5">{wReason}</p>
                                                        <div className="flex items-center gap-4 text-[10px] text-slate-500 font-mono uppercase tracking-wider">
                                                            <span>Filed: {wIssuedAt}</span>
                                                            <span className="text-lime-400 font-black">{wReward.toLocaleString()} aUEC</span>
                                                        </div>
                                                    </div>
                                                    <div className="w-10 h-10 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-center text-red-400 shrink-0">
                                                        <i className="fa-solid fa-triangle-exclamation" aria-hidden />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="space-y-6">
                            {!isOrg && (
                                <div className="rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
                                    <div className="px-4 py-3 bg-slate-950/40 border-b border-white/5 flex items-center justify-between">
                                        <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                            <i className="fa-solid fa-clock-rotate-left text-amber-400" aria-hidden /> Interaction History
                                        </h3>
                                        <span className="text-[10px] font-mono font-bold text-slate-500">{requests.length}</span>
                                    </div>
                                    <div className="max-h-[400px] overflow-y-auto custom-scrollbar divide-y divide-white/5">
                                        {requests.length > 0 ? requests.map((r: any, idx: number) => {
                                            const rId = s(r?.id, String(idx));
                                            const rServiceType = s(r?.serviceType);
                                            const rCreatedAt = formatDateCompact(r?.createdAt, fmt.prefs);
                                            const rDescription = s(r?.description);
                                            const rStatus = s(r?.status);
                                            return (
                                                <div
                                                    key={rId}
                                                    onClick={() => openWindow('request', r)}
                                                    className="p-3 hover:bg-slate-800/30 transition-colors cursor-pointer group"
                                                >
                                                    <div className="flex justify-between items-center mb-1">
                                                        <span className="text-[10px] font-black text-sky-300 uppercase tracking-widest">{rServiceType}</span>
                                                        <span className="text-[10px] text-slate-600 font-mono">{rCreatedAt}</span>
                                                    </div>
                                                    <p className="text-xs text-slate-400 line-clamp-2 group-hover:text-slate-200 transition-colors leading-relaxed">
                                                        {rDescription}
                                                    </p>
                                                    <div className="mt-2 flex items-center justify-between">
                                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm border ${rStatus === 'Success' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' : 'bg-slate-900/60 text-slate-500 border-white/10'}`}>
                                                            {rStatus}
                                                        </span>
                                                        <i className="fa-solid fa-arrow-up-right-from-square text-[10px] text-slate-700 group-hover:text-sky-400 transition-colors" aria-hidden />
                                                    </div>
                                                </div>
                                            );
                                        }) : (
                                            <div className="py-8 flex flex-col items-center justify-center text-slate-600">
                                                <i className="fa-solid fa-inbox text-2xl mb-2" aria-hidden />
                                                <p className="text-[10px] font-black uppercase tracking-widest">No interactions on file</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {!isOrg && operations.length > 0 && (
                                <div className="rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
                                    <div className="px-4 py-3 bg-slate-950/40 border-b border-white/5 flex items-center justify-between">
                                        <h3 className="text-xs font-black text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                            <i className="fa-solid fa-crosshairs text-emerald-400" aria-hidden /> Operations
                                        </h3>
                                        <span className="text-[10px] font-mono font-bold text-slate-500">{operations.length}</span>
                                    </div>
                                    <div className="max-h-[300px] overflow-y-auto custom-scrollbar divide-y divide-white/5">
                                        {operations.map((op: any, idx: number) => {
                                            const opId = s(op?.id, String(idx));
                                            const opName = s(op?.name);
                                            const opStatus = s(op?.status);
                                            const opType = s(op?.type);
                                            return (
                                                <div key={opId} className="p-3">
                                                    <div className="flex justify-between items-center mb-1">
                                                        <span className="text-sm font-bold text-white truncate">{opName}</span>
                                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm border ${opStatus === 'Active' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' : 'bg-slate-900/60 text-slate-500 border-white/10'}`}>
                                                            {opStatus}
                                                        </span>
                                                    </div>
                                                    <p className="text-[10px] text-slate-500 uppercase tracking-widest">{opType}</p>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'reports' && (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 pb-8">
                        {reports.map((report, idx) => (
                            <IntelligenceReportCard
                                key={s(report.id, String(idx))}
                                report={report}
                                onClick={() => setSelectedReport(report)}
                                onViewDossier={onDrilldown}
                                onDelete={hasPermission('intel:manage') ? () => handleDeleteReport(s(report.id)) : undefined}
                                onTagClick={onTagClick}
                            />
                        ))}
                        {reports.length === 0 && (
                            <div className="col-span-full py-20 text-center border border-dashed border-white/10 rounded-xl bg-slate-900/30">
                                <div className="w-16 h-16 rounded-xl bg-slate-900 border border-white/10 flex items-center justify-center mx-auto mb-4 text-slate-600">
                                    <i className="fa-solid fa-file-circle-xmark text-2xl" aria-hidden />
                                </div>
                                <p className="font-black text-slate-500 uppercase tracking-widest text-sm">No intelligence reports on file</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'affiliations' && (
                    <div className="pb-8">
                        {affiliates.length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {affiliates.map((aff: any) => {
                                    const affTargetId = s(aff?.targetId);
                                    const affThreat = s(aff?.threatLevel) as IntelThreatLevel;
                                    const affDate = formatDateCompact(aff?.lastReportedAt, fmt.prefs);
                                    const affA = ACCENTS[threatAccent(affThreat)];
                                    const affAlarm = threatIsAlarm(affThreat);
                                    return (
                                        <button
                                            key={affTargetId || stableKey(aff)}
                                            onClick={() => onDrilldown(affTargetId)}
                                            className="group relative rounded-xl overflow-hidden border border-white/10 bg-linear-to-br from-slate-900/80 via-slate-900/60 to-slate-950/80 p-4 text-left hover:border-white/20 hover:shadow-xl transition-all"
                                        >
                                            <div className={`absolute inset-y-0 left-0 w-1 ${affA.dot} ${affAlarm ? 'animate-pulse' : ''}`} aria-hidden />
                                            <div className="relative flex items-center gap-3 mb-3">
                                                <div className={`w-10 h-10 rounded-lg ${affA.bg} border ${affA.border} flex items-center justify-center shrink-0`}>
                                                    <i className={`fa-solid ${isOrg ? 'fa-user' : 'fa-building'} ${affA.text} text-base`} aria-hidden />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="font-black text-white uppercase truncate font-mono group-hover:text-sky-300 transition-colors">{affTargetId}</p>
                                                    <p className="text-[10px] text-slate-500 uppercase tracking-widest">{isOrg ? 'Individual' : 'Organization'}</p>
                                                </div>
                                                <i className="fa-solid fa-chevron-right text-slate-600 group-hover:text-sky-400 transition-colors text-xs" aria-hidden />
                                            </div>
                                            <div className="relative flex justify-between items-center pt-2 border-t border-white/5">
                                                <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">{affDate}</span>
                                                <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-sm border ${affA.bg} ${affA.border} ${affA.text}`}>
                                                    <i className={`fa-solid ${threatIcon(affThreat)}`} aria-hidden />
                                                    {threatLabel(affThreat)}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-20 border border-dashed border-white/10 rounded-xl bg-slate-900/30">
                                <div className="w-16 h-16 rounded-xl bg-slate-900 border border-white/10 flex items-center justify-center mx-auto mb-4 text-slate-600">
                                    <i className="fa-solid fa-diagram-project text-2xl" aria-hidden />
                                </div>
                                <p className="font-black text-slate-500 uppercase tracking-widest text-sm">No known affiliations</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {selectedReport && (
                <IntelReportDetailModal
                    isOpen={!!selectedReport}
                    onClose={() => setSelectedReport(null)}
                    report={selectedReport}
                    onViewDossier={onDrilldown}
                    onDelete={() => handleDeleteReport(s(selectedReport.id))}
                    onUpdate={onRefresh}
                />
            )}
        </div>
    );
};

export default DossierView;
