
import React, { useState, useRef, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useGovernment } from '../../../contexts/GovernmentContext';
import WindowFrame from '../../layout/WindowFrame';
import WikiEditor from '../wiki/WikiEditor';
import { GovernmentMotion, MotionStatus } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';
import { classifyVoteFailure } from './governmentUiRules';

const statusColors: Record<string, string> = {
    Open: 'bg-amber-500/10 text-amber-400',
    Voting: 'bg-emerald-500/10 text-emerald-400',
    Passed: 'bg-sky-500/10 text-sky-400',
    Failed: 'bg-red-500/10 text-red-400',
    Cancelled: 'bg-slate-500/10 text-slate-500',
};

const MotionsTab: React.FC = () => {
    const { currentUser, hasPermission } = useAuth();
    const { rpcAction } = useData();
    const { governmentMotions, governmentPositions, refreshGovernment } = useGovernment();
    const { addToast, confirm } = useNotification();

    const [showCreateModal, setShowCreateModal] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    // Motions this member has a stored ballot on, from THIS session: the government
    // subset carries no per-viewer hasVoted, so without this the vote buttons came back
    // after every vote and a second click could only answer "already voted". The value
    // is the vote when known ('' when not, e.g. the server reported an earlier ballot).
    const [votedHere, setVotedHere] = useState<Record<number, string>>({});

    // Create form
    const [formTitle, setFormTitle] = useState('');
    const formDescriptionRef = useRef<any>({});
    const [formSecretBallot, setFormSecretBallot] = useState(false);
    const [formRestrictedPositions, setFormRestrictedPositions] = useState<number[]>([]);
    const emptyContent = useMemo(() => ({}), []);

    const canManage = hasPermission('gov:manage');
    const canParticipate = hasPermission('gov:participate');

    const activeMotions = governmentMotions.filter(m => [MotionStatus.Open, MotionStatus.Voting].includes(m.status as MotionStatus));
    const pastMotions = governmentMotions.filter(m => [MotionStatus.Passed, MotionStatus.Failed, MotionStatus.Cancelled].includes(m.status as MotionStatus));

    const handleCreate = async () => {
        if (!formTitle.trim()) return;
        setIsLoading(true);
        try {
            await rpcAction('gov:create_motion', {
                motionData: {
                    title: formTitle,
                    description: formDescriptionRef.current && Object.keys(formDescriptionRef.current).length > 0 ? formDescriptionRef.current : null,
                    isSecretBallot: formSecretBallot,
                    restrictedToPositionIds: formRestrictedPositions.length > 0 ? formRestrictedPositions : null,
                }
            });
            setShowCreateModal(false);
            setFormTitle(''); formDescriptionRef.current = {}; setFormSecretBallot(false); setFormRestrictedPositions([]);
            addToast('Motion Created', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50', { description: 'Motion has been created.' });
            await refreshGovernment();
        } catch (err: any) {
            addToast('Create Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to create motion.' });
        } finally {
            setIsLoading(false);
        }
    };

    const handleStartVote = async (motionId: number) => {
        setIsLoading(true);
        try {
            await rpcAction('gov:start_motion_vote', { motionId });
            addToast('Voting Started', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            await refreshGovernment();
        } catch (err: any) { addToast('Start Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to start voting.' }); }
        finally { setIsLoading(false); }
    };

    const handleCastVote = async (motionId: number, vote: 'for' | 'against' | 'abstain') => {
        setIsLoading(true);
        try {
            await rpcAction('gov:cast_motion_vote', { motionId, vote });
            setVotedHere(prev => ({ ...prev, [motionId]: vote }));
            addToast('Vote Cast', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
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
                setVotedHere(prev => ({ ...prev, [motionId]: failure === 'recorded' ? vote : '' }));
                addToast(failure === 'recorded' ? 'Vote Recorded' : 'Already Voted', <i className="fa-solid fa-triangle-exclamation" />, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: message });
                await refreshGovernment();
            }
        }
        finally { setIsLoading(false); }
    };

    const handleConclude = async (motionId: number) => {
        setIsLoading(true);
        try {
            await rpcAction('gov:conclude_motion', { motionId });
            addToast('Motion Concluded', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            await refreshGovernment();
        } catch (err: any) { addToast('Conclude Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to conclude motion.' }); }
        finally { setIsLoading(false); }
    };

    const handleCancel = async (motionId: number) => {
        const confirmed = await confirm({ title: 'Cancel Motion', message: 'Cancel this motion?', confirmText: 'Cancel Motion', variant: 'danger' });
        if (!confirmed) return;
        setIsLoading(true);
        try {
            await rpcAction('gov:cancel_motion', { motionId });
            addToast('Motion Cancelled', <i className="fa-solid fa-ban" />, 'bg-slate-500/10 text-slate-300 border-slate-500/40');
            await refreshGovernment();
        } catch (err: any) { addToast('Cancel Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to cancel motion.' }); }
        finally { setIsLoading(false); }
    };

    const togglePositionRestriction = (posId: number) => {
        setFormRestrictedPositions(prev =>
            prev.includes(posId) ? prev.filter(id => id !== posId) : [...prev, posId]
        );
    };

    const renderMotionCard = (motion: GovernmentMotion) => {
        const total = motion.votesFor + motion.votesAgainst + motion.votesAbstain;
        const isVoting = motion.status === MotionStatus.Voting;
        const hasVoted = !!motion.hasVoted || motion.id in votedHere;
        const myVote = motion.myVote || votedHere[motion.id];

        return (
            <div key={motion.id} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                        <h3 className="text-sm font-bold text-white">{motion.title}</h3>
                        {motion.description && (
                            typeof motion.description === 'object' && motion.description.type ? (
                                <div className="mt-0.5"><WikiEditor content={motion.description} editable={false} /></div>
                            ) : (
                                <p className="text-xs text-slate-400 mt-0.5">{typeof motion.description === 'string' ? motion.description : ''}</p>
                            )
                        )}
                    </div>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-sm ml-2 shrink-0 ${statusColors[motion.status] || statusColors.Open}`}>
                        {motion.status}
                    </span>
                </div>

                <div className="flex items-center gap-3 text-[10px] text-slate-500 mb-3">
                    <span>by {motion.createdBy?.name || 'Unknown'}</span>
                    {motion.isSecretBallot && <span className="text-purple-400"><i className="fa-solid fa-mask mr-0.5"></i>Secret</span>}
                    {motion.restrictedToPositionIds && motion.restrictedToPositionIds.length > 0 && (
                        <span className="text-amber-400"><i className="fa-solid fa-lock mr-0.5"></i>Restricted</span>
                    )}
                </div>

                {/* Vote counts */}
                {total > 0 && (
                    <div className="mb-3">
                        <div className="flex items-center gap-4 text-xs mb-1">
                            <span className="text-emerald-400">{motion.votesFor} for</span>
                            <span className="text-red-400">{motion.votesAgainst} against</span>
                            <span className="text-slate-400">{motion.votesAbstain} abstain</span>
                        </div>
                        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden flex">
                            <div className="bg-emerald-500 h-full" style={{ width: `${(motion.votesFor / total) * 100}%` }}></div>
                            <div className="bg-red-500 h-full" style={{ width: `${(motion.votesAgainst / total) * 100}%` }}></div>
                            <div className="bg-slate-500 h-full" style={{ width: `${(motion.votesAbstain / total) * 100}%` }}></div>
                        </div>
                    </div>
                )}

                {/* Quick vote */}
                {isVoting && canParticipate && !hasVoted && (
                    <div className="flex gap-1.5">
                        <button onClick={() => handleCastVote(motion.id, 'for')} disabled={isLoading} className="flex-1 py-1.5 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-sm hover:bg-emerald-500/20 transition-colors disabled:opacity-40">For</button>
                        <button onClick={() => handleCastVote(motion.id, 'against')} disabled={isLoading} className="flex-1 py-1.5 text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/20 rounded-sm hover:bg-red-500/20 transition-colors disabled:opacity-40">Against</button>
                        <button onClick={() => handleCastVote(motion.id, 'abstain')} disabled={isLoading} className="flex-1 py-1.5 text-[10px] font-bold text-slate-400 bg-slate-500/10 border border-slate-500/20 rounded-sm hover:bg-slate-500/20 transition-colors disabled:opacity-40">Abstain</button>
                    </div>
                )}

                {isVoting && hasVoted && (
                    <p className="text-[10px] text-emerald-400"><i className="fa-solid fa-check mr-0.5"></i>
                        Voted{myVote && !motion.isSecretBallot ? ` "${myVote}"` : ''}
                    </p>
                )}

                {/* Admin controls */}
                {canManage && (
                    <div className="flex gap-1.5 mt-2">
                        {motion.status === 'Open' && (
                            <button onClick={() => handleStartVote(motion.id)} disabled={isLoading} className="text-[10px] text-emerald-400 hover:underline disabled:opacity-40">Start Vote</button>
                        )}
                        {isVoting && (
                            <button onClick={() => handleConclude(motion.id)} disabled={isLoading} className="text-[10px] text-sky-400 hover:underline disabled:opacity-40">Conclude</button>
                        )}
                        {['Open', 'Voting'].includes(motion.status) && (
                            <button onClick={() => handleCancel(motion.id)} disabled={isLoading} className="text-[10px] text-red-400 hover:underline disabled:opacity-40">Cancel</button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">Motions</h2>
                {canManage && (
                    <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded-md hover:bg-purple-500/20 transition-colors">
                        <i className="fa-solid fa-plus"></i> New Motion
                    </button>
                )}
            </div>

            {activeMotions.length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Active</h3>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{activeMotions.map(renderMotionCard)}</div>
                </div>
            )}

            {pastMotions.length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Past</h3>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{pastMotions.map(renderMotionCard)}</div>
                </div>
            )}

            {governmentMotions.length === 0 && (
                <div className="text-center py-12">
                    <i className="fa-solid fa-scale-balanced text-3xl text-slate-600 mb-3"></i>
                    <p className="text-sm text-slate-400">No motions have been raised yet.</p>
                </div>
            )}

            <WindowFrame
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                title="New Motion"
                subtitle="Government"
                icon="fa-solid fa-scale-balanced"
                color="purple"
                width="max-w-2xl"
            >
                <div className="flex flex-col h-full">
                    <div className="p-6 space-y-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Title</label>
                            <input value={formTitle} onChange={e => setFormTitle(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-purple-500 focus:border-purple-500 outline-hidden transition-all" placeholder="e.g. Increase Patrol Routes" disabled={isLoading} />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
                            <WikiEditor
                                content={emptyContent}
                                editable={true}
                                onChange={(json) => { formDescriptionRef.current = json; }}
                            />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input type="checkbox" checked={formSecretBallot} onChange={e => setFormSecretBallot(e.target.checked)} className="rounded-sm bg-slate-800 border-slate-600 text-purple-500 focus:ring-purple-500" disabled={isLoading} />
                            Secret ballot (votes are anonymous)
                        </label>
                        {governmentPositions.length > 0 && (
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Restrict voting to positions (optional)</label>
                                <div className="space-y-1 max-h-40 overflow-y-auto bg-slate-950/40 border border-slate-800 rounded-lg p-3">
                                    {governmentPositions.map(p => (
                                        <label key={p.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                            <input type="checkbox" checked={formRestrictedPositions.includes(p.id)} onChange={() => togglePositionRestriction(p.id)} className="rounded-sm bg-slate-800 border-slate-600 text-purple-500 focus:ring-purple-500" disabled={isLoading} />
                                            {p.name}
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end items-center p-4 bg-slate-900/50 border-t border-white/5 shrink-0 gap-3">
                        <button type="button" onClick={() => setShowCreateModal(false)} disabled={isLoading} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50">Cancel</button>
                        <button
                            type="button"
                            onClick={handleCreate}
                            disabled={isLoading || !formTitle.trim()}
                            className="px-6 py-2 text-xs font-bold uppercase tracking-wider text-white bg-purple-600 rounded-lg hover:bg-purple-500 transition-all shadow-lg shadow-purple-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none border border-purple-500/50"
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin" /> : 'Create Motion'}
                        </button>
                    </div>
                </div>
            </WindowFrame>
        </div>
    );
};

export default MotionsTab;
