
import React, { useState } from 'react';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useGovernment } from '../../../contexts/GovernmentContext';
import WindowFrame from '../../layout/WindowFrame';
import WikiEditor from '../wiki/WikiEditor';
import { GovernmentLegislation, LegislationStatus } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';
import { classifyVoteFailure } from './governmentUiRules';

interface LegislationDetailViewProps {
    legislation: GovernmentLegislation;
    onBack: () => void;
}

const statusColors: Record<string, { bg: string; text: string }> = {
    Draft: { bg: 'bg-slate-500/10', text: 'text-slate-400' },
    Proposed: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
    Debate: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
    Voting: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    Passed: { bg: 'bg-sky-500/10', text: 'text-sky-400' },
    Failed: { bg: 'bg-red-500/10', text: 'text-red-400' },
    Vetoed: { bg: 'bg-red-500/10', text: 'text-red-400' },
    Repealed: { bg: 'bg-slate-500/10', text: 'text-slate-500' },
};

const LegislationDetailView: React.FC<LegislationDetailViewProps> = ({ legislation, onBack }) => {
    const { currentUser, hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { rpcAction } = useData();
    const { governmentPositions, governmentPositionHolders, refreshGovernment } = useGovernment();
    const { addToast, confirm } = useNotification();

    const [isLoading, setIsLoading] = useState(false);
    const [commentText, setCommentText] = useState('');
    const [vetoReason, setVetoReason] = useState('');
    const [showVetoForm, setShowVetoForm] = useState(false);
    // Bills this member has a stored ballot on, from THIS session (keyed by bill id, as the
    // view is reused across bills): the vote, or '' when the server only reported an
    // earlier ballot. Keeps the vote buttons from coming back before the refetch lands.
    const [votedHere, setVotedHere] = useState<Record<number, string>>({});

    const canManage = hasPermission('gov:manage');
    const canVoteOnLegislation = hasPermission('gov:elected_official');
    const isVoting = legislation.status === LegislationStatus.Voting;
    const colors = statusColors[legislation.status] || statusColors.Draft;

    // Find which of my positions can vote on legislation
    const myVotingPositions = governmentPositionHolders
        .filter(h => h.userId === currentUser?.id && !h.endedAt)
        .map(h => governmentPositions.find(p => p.id === h.positionId))
        .filter(p => p?.canVoteLegislation);

    // Find which of my positions can veto
    const myVetoPositions = governmentPositionHolders
        .filter(h => h.userId === currentUser?.id && !h.endedAt)
        .map(h => governmentPositions.find(p => p.id === h.positionId))
        .filter(p => p?.canVetoLegislation);

    // Check if I've already voted
    const myVote = legislation.votes?.find(v => v.userId === currentUser?.id);
    const votedHereValue = votedHere[legislation.id];
    const hasVoted = !!myVote || votedHereValue !== undefined;
    const myVoteValue = myVote?.vote || votedHereValue;

    const handleAdvanceStatus = async (action: string) => {
        setIsLoading(true);
        try {
            await rpcAction(action, { legislationId: legislation.id });
            addToast('Status Updated', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            await refreshGovernment();
        } catch (err: any) {
            addToast('Update Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Operation failed.' });
        } finally {
            setIsLoading(false);
        }
    };

    const handleVote = async (vote: 'for' | 'against' | 'abstain') => {
        if (!myVotingPositions[0]) return;
        setIsLoading(true);
        try {
            await rpcAction('gov:cast_legislation_vote', {
                legislationId: legislation.id,
                positionId: myVotingPositions[0]!.id,
                vote,
            });
            setVotedHere(prev => ({ ...prev, [legislation.id]: vote }));
            addToast('Vote Cast', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50', { description: `You voted "${vote}" on this bill.` });
            await refreshGovernment();
        } catch (err: any) {
            const message: string = err?.message || 'Failed to cast vote.';
            const failure = classifyVoteFailure(message);
            if (failure === 'failed') {
                addToast('Vote Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: message });
            } else {
                // The ballot IS stored (only the tally refresh failed, or an earlier attempt
                // already counted). Show the server's words as-is, stop offering the vote —
                // a retry only answers "already voted" — and refetch the domain.
                setVotedHere(prev => ({ ...prev, [legislation.id]: failure === 'recorded' ? vote : '' }));
                addToast(failure === 'recorded' ? 'Vote Recorded' : 'Already Voted', <i className="fa-solid fa-triangle-exclamation" />, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: message });
                await refreshGovernment();
            }
        } finally {
            setIsLoading(false);
        }
    };

    const handleVeto = async () => {
        setIsLoading(true);
        try {
            await rpcAction('gov:veto_legislation', { legislationId: legislation.id, reason: vetoReason });
            setShowVetoForm(false);
            addToast('Legislation Vetoed', <i className="fa-solid fa-ban" />, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: 'Legislation has been vetoed.' });
            await refreshGovernment();
        } catch (err: any) {
            addToast('Veto Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to veto.' });
        } finally {
            setIsLoading(false);
        }
    };

    const handleAddComment = async () => {
        if (!commentText.trim()) return;
        setIsLoading(true);
        try {
            await rpcAction('gov:add_legislation_comment', { legislationId: legislation.id, content: commentText });
            setCommentText('');
            await refreshGovernment();
        } catch (err: any) {
            addToast('Comment Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to add comment.' });
        } finally {
            setIsLoading(false);
        }
    };

    const totalVotes = legislation.votesFor + legislation.votesAgainst + legislation.votesAbstain;

    return (
        <div className="space-y-6">
            <button onClick={onBack} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors">
                <i className="fa-solid fa-arrow-left"></i> Back to Legislation
            </button>

            {/* Header */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-5">
                <div className="flex items-start justify-between mb-2">
                    <div>
                        <h2 className="text-lg font-bold text-white">{legislation.title}</h2>
                        {legislation.isConstitutionalAmendment && (
                            <span className="text-[10px] px-2 py-0.5 rounded-sm bg-amber-500/20 text-amber-400 font-bold">CONSTITUTIONAL AMENDMENT</span>
                        )}
                    </div>
                    <span className={`text-xs font-medium px-3 py-1 rounded-sm ${colors.bg} ${colors.text}`}>{legislation.status}</span>
                </div>
                {legislation.summary && <p className="text-sm text-slate-300 mb-3">{legislation.summary}</p>}
                <div className="flex flex-wrap gap-3 text-xs text-slate-400">
                    <span>Authored by {legislation.author?.name || 'Unknown'}</span>
                    {legislation.sponsorPosition && <span>Sponsored via {legislation.sponsorPosition.name}</span>}
                    {legislation.passedAt && <span className="text-sky-400">Enacted {fmt.date(legislation.passedAt)}</span>}
                    {legislation.vetoedAt && <span className="text-red-400">Vetoed by {legislation.vetoedBy?.name || 'Unknown'}</span>}
                </div>

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-2 mt-4">
                    {canManage && legislation.status === 'Draft' && (
                        <button onClick={() => handleAdvanceStatus('gov:propose_legislation')} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md hover:bg-amber-500/20 transition-colors disabled:opacity-40">
                            <i className="fa-solid fa-paper-plane"></i> Propose
                        </button>
                    )}
                    {canManage && legislation.status === 'Proposed' && (
                        <button onClick={() => handleAdvanceStatus('gov:start_legislation_debate')} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded-md hover:bg-purple-500/20 transition-colors disabled:opacity-40">
                            <i className="fa-solid fa-comments"></i> Open Debate
                        </button>
                    )}
                    {canManage && ['Proposed', 'Debate'].includes(legislation.status) && (
                        <button onClick={() => handleAdvanceStatus('gov:start_legislation_vote')} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md hover:bg-emerald-500/20 transition-colors disabled:opacity-40">
                            <i className="fa-solid fa-check-to-slot"></i> Start Vote
                        </button>
                    )}
                    {canManage && legislation.status === 'Voting' && (
                        <button onClick={() => handleAdvanceStatus('gov:conclude_legislation_vote')} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 rounded-md hover:bg-sky-500/20 transition-colors disabled:opacity-40">
                            <i className="fa-solid fa-gavel"></i> Conclude Vote
                        </button>
                    )}
                    {myVetoPositions.length > 0 && legislation.status === 'Passed' && (
                        <button onClick={() => setShowVetoForm(true)} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-md hover:bg-red-500/20 transition-colors disabled:opacity-40">
                            <i className="fa-solid fa-ban"></i> Veto
                        </button>
                    )}
                </div>
            </div>

            {/* Vote Tally */}
            {(isVoting || ['Passed', 'Failed'].includes(legislation.status)) && totalVotes > 0 && (
                <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4">
                    <h3 className="text-xs font-semibold text-white mb-3">Vote Tally</h3>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                        <div className="text-center"><div className="text-lg font-bold text-emerald-400">{legislation.votesFor}</div><div className="text-[10px] text-slate-400">For</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-red-400">{legislation.votesAgainst}</div><div className="text-[10px] text-slate-400">Against</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-slate-400">{legislation.votesAbstain}</div><div className="text-[10px] text-slate-400">Abstain</div></div>
                    </div>
                    {totalVotes > 0 && (
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden flex">
                            <div className="bg-emerald-500 h-full" style={{ width: `${(legislation.votesFor / totalVotes) * 100}%` }}></div>
                            <div className="bg-red-500 h-full" style={{ width: `${(legislation.votesAgainst / totalVotes) * 100}%` }}></div>
                            <div className="bg-slate-500 h-full" style={{ width: `${(legislation.votesAbstain / totalVotes) * 100}%` }}></div>
                        </div>
                    )}
                    {/* Individual votes (public record) */}
                    {legislation.votes && legislation.votes.length > 0 && (
                        <div className="mt-3 space-y-1">
                            {legislation.votes.map(v => (
                                <div key={v.id} className="flex items-center gap-2 text-xs">
                                    <span className={`w-14 text-right font-medium ${v.vote === 'for' ? 'text-emerald-400' : v.vote === 'against' ? 'text-red-400' : 'text-slate-400'}`}>
                                        {v.vote.charAt(0).toUpperCase() + v.vote.slice(1)}
                                    </span>
                                    <span className="text-slate-300">{v.user?.name || 'Unknown'}</span>
                                    {v.position && <span className="text-[10px] text-slate-500">({v.position.name})</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Cast Vote */}
            {isVoting && canVoteOnLegislation && myVotingPositions.length > 0 && !hasVoted && (
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-4">
                    <h3 className="text-xs font-semibold text-white mb-3">Cast Your Vote</h3>
                    <p className="text-[10px] text-slate-400 mb-3">Voting as: {myVotingPositions[0]?.name}</p>
                    <div className="flex gap-2">
                        <button onClick={() => handleVote('for')} disabled={isLoading} className="flex-1 py-2 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md hover:bg-emerald-500/20 transition-colors disabled:opacity-40">For</button>
                        <button onClick={() => handleVote('against')} disabled={isLoading} className="flex-1 py-2 text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/20 rounded-md hover:bg-red-500/20 transition-colors disabled:opacity-40">Against</button>
                        <button onClick={() => handleVote('abstain')} disabled={isLoading} className="flex-1 py-2 text-xs font-bold text-slate-400 bg-slate-500/10 border border-slate-500/20 rounded-md hover:bg-slate-500/20 transition-colors disabled:opacity-40">Abstain</button>
                    </div>
                </div>
            )}

            {isVoting && hasVoted && (
                <div className="text-center py-3">
                    <span className="text-sm text-emerald-400"><i className="fa-solid fa-check-circle mr-1"></i>{myVoteValue ? `You voted "${myVoteValue}" on this bill.` : 'You have voted on this bill.'}</span>
                </div>
            )}

            {/* Bill Body */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-5">
                <h3 className="text-xs font-semibold text-white mb-3">Bill Text</h3>
                {legislation.body && typeof legislation.body === 'object' && legislation.body.type ? (
                    <WikiEditor content={legislation.body} editable={false} />
                ) : (
                    <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                        {typeof legislation.body === 'string' ? legislation.body : JSON.stringify(legislation.body, null, 2)}
                    </div>
                )}
            </div>

            {/* Debate / Comments */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-5">
                <h3 className="text-xs font-semibold text-white mb-3">
                    Debate ({legislation.comments?.length || 0})
                </h3>
                {legislation.comments && legislation.comments.length > 0 ? (
                    <div className="space-y-3 mb-4">
                        {legislation.comments.map(c => (
                            <div key={c.id} className="flex gap-3">
                                {c.user?.avatarUrl ? (
                                    <img src={c.user.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0 object-cover" />
                                ) : (
                                    <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center shrink-0">
                                        <i className="fa-solid fa-user text-[8px] text-slate-500"></i>
                                    </div>
                                )}
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-xs font-medium text-white">{c.user?.name || 'Unknown'}</span>
                                        <span className="text-[10px] text-slate-500">{fmt(c.createdAt)}</span>
                                    </div>
                                    <p className="text-xs text-slate-300">{c.content}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-slate-500 mb-4">No comments yet.</p>
                )}
                {hasPermission('gov:view') && (
                    <div className="flex gap-2">
                        <input
                            value={commentText}
                            onChange={e => setCommentText(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAddComment()}
                            className="flex-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-xs text-white"
                            placeholder="Add to the debate..."
                        />
                        <button onClick={handleAddComment} disabled={!commentText.trim() || isLoading} className="px-3 py-2 text-xs font-medium bg-slate-700 hover:bg-slate-600 text-white rounded-md disabled:opacity-40">
                            <i className="fa-solid fa-paper-plane"></i>
                        </button>
                    </div>
                )}
            </div>

            <WindowFrame
                isOpen={showVetoForm}
                onClose={() => setShowVetoForm(false)}
                title="Exercise Veto"
                subtitle="Legislation"
                icon="fa-solid fa-ban"
                color="red"
                width="max-w-md"
            >
                <div className="flex flex-col h-full">
                    <div className="p-6 space-y-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Reason (optional)</label>
                            <textarea value={vetoReason} onChange={e => setVetoReason(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-red-500 focus:border-red-500 outline-hidden transition-all resize-none" rows={3} placeholder="Explain your veto..." disabled={isLoading} />
                        </div>
                    </div>
                    <div className="flex justify-end items-center p-4 bg-slate-900/50 border-t border-white/5 shrink-0 gap-3">
                        <button type="button" onClick={() => setShowVetoForm(false)} disabled={isLoading} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50">Cancel</button>
                        <button
                            type="button"
                            onClick={handleVeto}
                            disabled={isLoading}
                            className="px-6 py-2 text-xs font-bold uppercase tracking-wider text-white bg-red-600 rounded-lg hover:bg-red-500 transition-all shadow-lg shadow-red-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none border border-red-500/50"
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin" /> : 'Veto'}
                        </button>
                    </div>
                </div>
            </WindowFrame>
        </div>
    );
};

export default LegislationDetailView;
