import React, { useState, useMemo, useEffect } from 'react';
import { HydratedOperation, AARCategory, AAREntry, UserRole } from '../../../../types';
import { useAuth, useFormatDate } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';

import { useNotification } from '../../../../contexts/NotificationContext';

const AAR_AI_COOLDOWN_MS = 3 * 60 * 60 * 1000;

const formatRemaining = (ms: number) => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${totalSeconds}s`;
};

interface OpAARTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    isParticipant: boolean;
    onRefresh: () => void;
}

const categoryConfig: Record<string, { icon: string; color: string; label: string; bgClass: string }> = {
    observation: { icon: 'fa-solid fa-eye', color: 'text-sky-400', label: 'Observations', bgClass: 'bg-sky-500/10 border-sky-500/20' },
    sustain: { icon: 'fa-solid fa-thumbs-up', color: 'text-green-400', label: 'Sustain (What Went Well)', bgClass: 'bg-green-500/10 border-green-500/20' },
    improve: { icon: 'fa-solid fa-arrow-up-right-dots', color: 'text-amber-400', label: 'Improve (What To Fix)', bgClass: 'bg-amber-500/10 border-amber-500/20' },
    action_item: { icon: 'fa-solid fa-clipboard-check', color: 'text-purple-400', label: 'Action Items', bgClass: 'bg-purple-500/10 border-purple-500/20' },
};

const OpAARTab: React.FC<OpAARTabProps> = ({ operation, canManage, isParticipant, onRefresh }) => {
    const { currentUser } = useAuth();
    const fmt = useFormatDate();
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const entries = useMemo(() => operation.aarEntries || [], [operation.aarEntries]);
    const isSubmitted = !!operation.aarSubmittedAt;
    // Reopen is gated to admins or the operation's owner. The server enforces
    // the same check; this controls whether the button is rendered.
    const canReopen = isSubmitted && !!currentUser && (currentUser.role === UserRole.Admin || currentUser.id === operation.ownerId);
    const [reopening, setReopening] = useState(false);

    const [showForm, setShowForm] = useState(false);
    const [content, setContent] = useState('');
    const [category, setCategory] = useState<AARCategory>(AARCategory.Observation);
    const [saving, setSaving] = useState(false);

    // AAR summary editing
    const [editingSummary, setEditingSummary] = useState(false);
    const [summaryText, setSummaryText] = useState(operation.aarSummary || '');
    const [lessonsText, setLessonsText] = useState(operation.aarLessonsLearned || '');
    const [savingSummary, setSavingSummary] = useState(false);
    const [generatingDraft, setGeneratingDraft] = useState(false);
    const [lastGeneratedAt, setLastGeneratedAt] = useState<string | undefined>(operation.aarAiGeneratedAt);
    const [now, setNow] = useState(() => Date.now());

    // Re-sync the cooldown anchor whenever the server-provided timestamp changes
    // (e.g. after onRefresh brings fresh data), while still allowing the local
    // optimistic updates in handleGenerateDraft. Done during render — React's
    // recommended replacement for a setState-in-effect prop sync — so there is
    // no extra commit/paint.
    const [prevAiGeneratedAt, setPrevAiGeneratedAt] = useState(operation.aarAiGeneratedAt);
    if (operation.aarAiGeneratedAt !== prevAiGeneratedAt) {
        setPrevAiGeneratedAt(operation.aarAiGeneratedAt);
        setLastGeneratedAt(operation.aarAiGeneratedAt);
    }

    useEffect(() => {
        if (!lastGeneratedAt) return;
        const interval = setInterval(() => setNow(Date.now()), 30 * 1000);
        return () => clearInterval(interval);
    }, [lastGeneratedAt]);

    const cooldownRemaining = useMemo(() => {
        if (!lastGeneratedAt) return 0;
        const remaining = (new Date(lastGeneratedAt).getTime() + AAR_AI_COOLDOWN_MS) - now;
        return remaining > 0 ? remaining : 0;
    }, [lastGeneratedAt, now]);
    const onCooldown = cooldownRemaining > 0;

    const grouped = useMemo(() => {
        const groups: Record<string, AAREntry[]> = {};
        Object.values(AARCategory).forEach(c => { groups[c] = []; });
        entries.forEach(e => {
            if (groups[e.category]) groups[e.category].push(e);
            else groups[AARCategory.Observation].push(e);
        });
        return groups;
    }, [entries]);

    const handleAddEntry = async () => {
        if (!content.trim()) return;
        setSaving(true);
        try {
            await rpcAction('operation:add_aar_entry', {
                operationId: operation.id,
                data: { content: content.trim(), category },
            });
            setContent('');
            setShowForm(false);
            onRefresh();
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteEntry = async (entryId: number) => {
        await rpcAction('operation:delete_aar_entry', { entryId, operationId: operation.id });
        onRefresh();
    };

    const handleSubmitAAR = async () => {
        setSavingSummary(true);
        await rpcAction('operation:submit_aar', {
            operationId: operation.id,
            summary: summaryText.trim(),
            lessonsLearned: lessonsText.trim(),
        });
        setSavingSummary(false);
        setEditingSummary(false);
        onRefresh();
    };

    const handleReopenAAR = async () => {
        const ok = await confirm({
            title: 'Reopen AAR',
            message: 'Reopen this AAR for editing? The summary and lessons learned are preserved; the submission will be cleared and the operation timeline will record this action.',
            confirmText: 'Reopen',
        });
        if (!ok) return;
        setReopening(true);
        try {
            await rpcAction('operation:reopen_aar', { operationId: operation.id });
            onRefresh();
        } catch (err: any) {
            addToast(
                'Reopen Failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not reopen the AAR.' }
            );
        } finally {
            setReopening(false);
        }
    };

    const handleGenerateDraft = async () => {
        if (onCooldown || generatingDraft) return;
        setGeneratingDraft(true);
        try {
            const result = await rpcAction('operation:generate_aar_summary', { operationId: operation.id });
            if (result?.summary) setSummaryText(result.summary);
            if (result?.lessonsLearned) setLessonsText(result.lessonsLearned);
            if (result?.aarAiGeneratedAt) setLastGeneratedAt(result.aarAiGeneratedAt);
            setNow(Date.now());
            addToast(
                'AI draft ready',
                <i className="fa-solid fa-wand-magic-sparkles" />,
                'bg-purple-500/10 text-purple-300 border-purple-500/30',
                { description: 'Review and edit the draft before submitting.' }
            );
        } catch (err: any) {
            const rawMsg: string = err?.message || '';
            // Strip any raw JSON payload that may have leaked through; surface only friendly prose.
            const cleanMsg = rawMsg.startsWith('{') || rawMsg.includes('"error"')
                ? 'The AI service returned an unexpected error. Try again in a few minutes.'
                : rawMsg;

            if (cleanMsg.includes('AAR_COOLDOWN_ACTIVE') || err?.code === 'AAR_COOLDOWN_ACTIVE') {
                if (err?.retryAt) setLastGeneratedAt(new Date(new Date(err.retryAt).getTime() - AAR_AI_COOLDOWN_MS).toISOString());
                addToast(
                    'AI draft on cooldown',
                    <i className="fa-solid fa-hourglass-half" />,
                    'bg-amber-500/10 text-amber-300 border-amber-500/30',
                    { description: 'Drafts are limited to one every 3 hours per operation. Try again later.' }
                );
                return;
            }

            // Categorise the error for a tighter toast title + body. The message from lib/ai.ts
            // is already operator-friendly; pick a matching title and split the action prompt
            // (after the em-dash, where present) into the description.
            let title = 'AI draft failed';
            let icon = <i className="fa-solid fa-xmark" />;
            const lower = cleanMsg.toLowerCase();
            if (lower.includes('overloaded') || lower.includes('temporarily')) {
                title = 'Gemini temporarily overloaded';
                icon = <i className="fa-solid fa-cloud-bolt" />;
            } else if (lower.includes('quota')) {
                title = 'Gemini quota exceeded';
                icon = <i className="fa-solid fa-gauge-high" />;
            } else if (lower.includes('not found') || lower.includes('retired')) {
                title = 'AI model unavailable';
                icon = <i className="fa-solid fa-circle-question" />;
            } else if (lower.includes('permission')) {
                title = 'API key permission denied';
                icon = <i className="fa-solid fa-lock" />;
            } else if (lower.includes('invalid') && lower.includes('key')) {
                title = 'API key invalid';
                icon = <i className="fa-solid fa-key" />;
            } else if (lower.includes('internal')) {
                title = 'Gemini internal error';
                icon = <i className="fa-solid fa-server" />;
            }

            addToast(
                title,
                icon,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: cleanMsg || 'Could not generate draft.' }
            );
        } finally {
            setGeneratingDraft(false);
        }
    };

    const handleSaveSummary = async () => {
        setSavingSummary(true);
        await rpcAction('operation:update', {
            operationId: operation.id,
            updates: { aarSummary: summaryText.trim(), aarLessonsLearned: lessonsText.trim() },
        });
        setSavingSummary(false);
        setEditingSummary(false);
        onRefresh();
    };

    const canContribute = isParticipant || canManage;
    const inputClass = "w-full bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2.5 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 transition-all";
    const labelClass = "text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1.5 block";

    return (
        <div className="p-6 lg:p-8 space-y-6">
            <div className="flex flex-wrap items-center gap-3 p-4 bg-linear-to-r from-slate-800/60 to-slate-900/40 rounded-xl border border-slate-700/40">
                <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                    <i className="fa-solid fa-file-lines text-purple-400/70"></i> After Action Review
                    {isSubmitted && <span className="text-[8px] bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded-sm ml-1">Submitted</span>}
                </p>
                <div className="flex-1"></div>
                {canContribute && !isSubmitted && (
                    <button onClick={() => setShowForm(!showForm)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors">
                        <i className="fa-solid fa-plus"></i> Add Entry
                    </button>
                )}
                {canManage && !isSubmitted && !editingSummary && (
                    <button onClick={() => { setSummaryText(operation.aarSummary || ''); setLessonsText(operation.aarLessonsLearned || ''); setEditingSummary(true); }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20 text-[10px] font-bold uppercase tracking-wider hover:bg-green-500/20 transition-colors">
                        <i className="fa-solid fa-pen-to-square"></i> Write Summary
                    </button>
                )}
            </div>

            {isSubmitted && (
                <div className="bg-green-950/15 rounded-xl border border-green-500/15 overflow-hidden">
                    <div className="px-5 py-3 bg-green-950/20 border-b border-green-500/10">
                        <p className="text-[10px] text-green-400/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                            <i className="fa-solid fa-check-circle"></i> AAR Submitted
                        </p>
                    </div>
                    <div className="p-5 flex items-center justify-between gap-4 flex-wrap">
                        <p className="text-xs text-slate-400">
                            Submitted {fmt(operation.aarSubmittedAt!)}
                        </p>
                        {canReopen && (
                            <button
                                onClick={handleReopenAAR}
                                disabled={reopening}
                                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Clear submission so the AAR can be edited again."
                            >
                                {reopening
                                    ? <><i className="fa-solid fa-spinner animate-spin"></i> Reopening...</>
                                    : <><i className="fa-solid fa-rotate-left"></i> Reopen AAR</>}
                            </button>
                        )}
                    </div>
                </div>
            )}

            {(editingSummary || operation.aarSummary || operation.aarLessonsLearned) && (
                <div className="bg-slate-900/60 rounded-xl border border-slate-700/30 overflow-hidden">
                    <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                        <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em]">AAR Summary</p>
                    </div>
                    <div className="p-5 space-y-4">
                        {editingSummary ? (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-purple-500/20 bg-purple-500/5">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[10px] uppercase font-black tracking-widest text-purple-300 flex items-center gap-2">
                                            <i className="fa-solid fa-wand-magic-sparkles"></i> AI Draft
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-1">
                                            {onCooldown
                                                ? `Available again in ${formatRemaining(cooldownRemaining)}. Drafts are rate-limited to once every 3 hours per operation.`
                                                : 'Generate a draft summary and lessons-learned from the AAR entries. Review and edit before submitting.'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleGenerateDraft}
                                        disabled={generatingDraft || onCooldown}
                                        className="shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/15 text-purple-200 border border-purple-500/40 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                        title={onCooldown ? `Cooldown: ${formatRemaining(cooldownRemaining)} remaining` : 'Generate AI draft'}
                                    >
                                        {generatingDraft
                                            ? <><i className="fa-solid fa-spinner animate-spin"></i> Drafting...</>
                                            : onCooldown
                                                ? <><i className="fa-solid fa-hourglass-half"></i> {formatRemaining(cooldownRemaining)}</>
                                                : <><i className="fa-solid fa-wand-magic-sparkles"></i> Generate Draft</>}
                                    </button>
                                </div>
                                <div>
                                    <label className={labelClass}>Summary</label>
                                    <textarea value={summaryText} onChange={e => setSummaryText(e.target.value)} rows={4} className={`${inputClass} w-full resize-none`}
                                        placeholder="Overall summary of the operation..." />
                                </div>
                                <div>
                                    <label className={labelClass}>Lessons Learned</label>
                                    <textarea value={lessonsText} onChange={e => setLessonsText(e.target.value)} rows={4} className={`${inputClass} w-full resize-none`}
                                        placeholder="Key takeaways and lessons..." />
                                </div>
                                <div className="flex gap-3 justify-end">
                                    <button onClick={() => setEditingSummary(false)} className="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">Cancel</button>
                                    <button onClick={handleSaveSummary} disabled={savingSummary}
                                        className="text-xs text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                                        {savingSummary ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Draft'}
                                    </button>
                                    <button onClick={handleSubmitAAR} disabled={savingSummary}
                                        className="text-xs text-green-400 bg-green-500/10 border border-green-500/25 hover:bg-green-500/20 px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                                        {savingSummary ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Submit AAR'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {operation.aarSummary ? (
                                    <div className="text-sm text-slate-300 whitespace-pre-wrap font-light leading-relaxed">{operation.aarSummary}</div>
                                ) : (
                                    <p className="text-xs text-slate-600 italic">No summary written yet.</p>
                                )}
                                {operation.aarLessonsLearned && (
                                    <div className="pt-3 border-t border-slate-700/30">
                                        <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-2">Lessons Learned</p>
                                        <div className="text-sm text-slate-300 whitespace-pre-wrap font-light leading-relaxed">{operation.aarLessonsLearned}</div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}

            {showForm && (
                <div className="bg-slate-900/60 rounded-xl border border-slate-700/30 overflow-hidden">
                    <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                        <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em]">New Entry</p>
                    </div>
                    <div className="p-5 space-y-4">
                        <div>
                            <label className={labelClass}>Category</label>
                            <div className="flex gap-2 flex-wrap">
                                {Object.entries(categoryConfig).map(([key, cfg]) => (
                                    <button key={key} onClick={() => setCategory(key as AARCategory)}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-all ${
                                            category === key ? cfg.bgClass + ' ' + cfg.color : 'text-slate-500 border-transparent hover:bg-slate-800/40'
                                        }`}>
                                        <i className={cfg.icon}></i> {cfg.label.split(' ')[0]}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>Content</label>
                            <textarea value={content} onChange={e => setContent(e.target.value)} rows={3} className={`${inputClass} w-full resize-none`}
                                placeholder="Share your feedback..." />
                        </div>
                        <div className="flex justify-end gap-3">
                            <button onClick={() => setShowForm(false)} className="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">Cancel</button>
                            <button onClick={handleAddEntry} disabled={saving || !content.trim()}
                                className="text-xs text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-5 py-1.5 rounded-lg disabled:opacity-50 transition-colors">
                                {saving ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Submit Entry'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="space-y-6">
                {Object.entries(categoryConfig).map(([key, cfg]) => {
                    const catEntries = grouped[key] || [];
                    if (catEntries.length === 0) return null;
                    return (
                        <div key={key}>
                            <h4 className={`text-[10px] font-black uppercase tracking-widest mb-3 flex items-center gap-2 ${cfg.color}`}>
                                <i className={cfg.icon}></i> {cfg.label}
                                <span className="text-slate-600 text-[9px] font-mono">({catEntries.length})</span>
                            </h4>
                            <div className="space-y-2">
                                {catEntries.map(entry => (
                                    <div key={entry.id} className={`p-4 rounded-xl border ${cfg.bgClass} group`}>
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1">
                                                <p className="text-sm text-white whitespace-pre-wrap font-light leading-relaxed">{entry.content}</p>
                                                <div className="flex items-center gap-2 mt-2.5 text-[10px] text-slate-500">
                                                    {entry.author && (
                                                        <span className="flex items-center gap-1">
                                                            {entry.author.avatarUrl && <img src={entry.author.avatarUrl} className="w-4 h-4 rounded-full object-cover shrink-0" alt="" />}
                                                            {entry.author.name}
                                                        </span>
                                                    )}
                                                    <span className="font-mono">{fmt(entry.createdAt)}</span>
                                                </div>
                                            </div>
                                            {canManage && (
                                                <button onClick={() => handleDeleteEntry(entry.id)}
                                                    className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1">
                                                    <i className="fa-solid fa-xmark text-xs"></i>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            {entries.length === 0 && !canContribute && (
                <div className="flex flex-col items-center justify-center py-16 text-slate-600">
                    <i className="fa-solid fa-file-lines text-4xl mb-3 opacity-30"></i>
                    <p className="text-sm font-medium opacity-50">No AAR entries submitted yet.</p>
                </div>
            )}
        </div>
    );
};

export default OpAARTab;
