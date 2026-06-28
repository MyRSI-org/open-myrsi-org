
import React, { useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { GovernmentElection, ElectionType } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';

interface VotingBoothProps {
    election: GovernmentElection;
    onSubmit: () => void;
    onCancel: () => void;
}

const VotingBooth: React.FC<VotingBoothProps> = ({ election, onSubmit, onCancel }) => {
    const { rpcAction } = useData();
    const { addToast } = useNotification();

    const candidates = election.candidates || [];
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Simple majority / plurality: select one or more candidates
    const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);

    // Approval: select multiple candidates
    const [approvedCandidateIds, setApprovedCandidateIds] = useState<Set<number>>(() => new Set());

    // Preferential (ranked): ordered list of candidate IDs
    const [rankedCandidates, setRankedCandidates] = useState<number[]>([]);

    const isPreferential = election.electionType === ElectionType.Preferential;
    const isApproval = election.electionType === ElectionType.Approval;
    const isProportional = election.electionType === ElectionType.ProportionalRepresentation;

    const toggleApproval = (candidateId: number) => {
        setApprovedCandidateIds(prev => {
            const next = new Set(prev);
            if (next.has(candidateId)) next.delete(candidateId);
            else next.add(candidateId);
            return next;
        });
    };

    const addToRanking = (candidateId: number) => {
        if (rankedCandidates.includes(candidateId)) return;
        setRankedCandidates(prev => [...prev, candidateId]);
    };

    const removeFromRanking = (candidateId: number) => {
        setRankedCandidates(prev => prev.filter(id => id !== candidateId));
    };

    const moveInRanking = (index: number, direction: -1 | 1) => {
        setRankedCandidates(prev => {
            const arr = [...prev];
            const newIndex = index + direction;
            if (newIndex < 0 || newIndex >= arr.length) return arr;
            [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
            return arr;
        });
    };

    const canSubmit = () => {
        if (isPreferential) return rankedCandidates.length > 0;
        if (isApproval) return approvedCandidateIds.size > 0;
        return selectedCandidateId !== null;
    };

    const handleSubmit = async () => {
        if (!canSubmit()) return;
        setIsSubmitting(true);
        try {
            let selections: { candidateId: number; rankOrder?: number }[];

            if (isPreferential) {
                selections = rankedCandidates.map((cid, idx) => ({ candidateId: cid, rankOrder: idx + 1 }));
            } else if (isApproval) {
                selections = Array.from(approvedCandidateIds).map(cid => ({ candidateId: cid }));
            } else {
                // Simple majority, plurality, proportional — single selection
                selections = [{ candidateId: selectedCandidateId! }];
            }

            await rpcAction('gov:cast_election_vote', {
                electionId: election.id,
                selections,
            });
            onSubmit();
        } catch (err: any) {
            addToast('Vote Failed', err.message || 'Failed to cast your vote.', 'error');
        } finally {
            setIsSubmitting(false);
        }
    };

    const getCandidateName = (candidateId: number) => {
        const c = candidates.find(c => c.id === candidateId);
        return c?.user?.name || 'Unknown';
    };

    return (
        <div className="p-6">
            <div className="text-center mb-6">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-3">
                    <i className="fa-solid fa-box-ballot text-xl text-emerald-400"></i>
                </div>
                <h2 className="text-lg font-bold text-white">Voting Booth</h2>
                <p className="text-xs text-slate-400 mt-1">{election.title}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                    Your vote is secret and cannot be traced back to you.
                </p>
            </div>

            {/* Simple Majority / Plurality / Proportional — Radio selection */}
            {!isPreferential && !isApproval && (
                <div className="space-y-2 mb-6">
                    <p className="text-xs text-slate-400 mb-2">Select your preferred candidate:</p>
                    {candidates.map(c => (
                        <button
                            key={c.id}
                            onClick={() => setSelectedCandidateId(c.id)}
                            className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                                selectedCandidateId === c.id
                                    ? 'border-emerald-500 bg-emerald-500/10'
                                    : 'border-slate-700/50 bg-slate-800/40 hover:border-slate-600'
                            }`}
                        >
                            <div className={`w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                                selectedCandidateId === c.id ? 'border-emerald-500 bg-emerald-500' : 'border-slate-600'
                            }`}>
                                {selectedCandidateId === c.id && <i className="fa-solid fa-check text-[10px] text-white"></i>}
                            </div>
                            {c.user?.avatarUrl && <img src={c.user.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />}
                            <div className="flex-1">
                                <span className="text-sm font-medium text-white">{c.user?.name || 'Unknown'}</span>
                                {c.platformStatement && <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-1">{c.platformStatement}</p>}
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {/* Approval — Checkbox selection */}
            {isApproval && (
                <div className="space-y-2 mb-6">
                    <p className="text-xs text-slate-400 mb-2">Select all candidates you approve of:</p>
                    {candidates.map(c => (
                        <button
                            key={c.id}
                            onClick={() => toggleApproval(c.id)}
                            className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                                approvedCandidateIds.has(c.id)
                                    ? 'border-emerald-500 bg-emerald-500/10'
                                    : 'border-slate-700/50 bg-slate-800/40 hover:border-slate-600'
                            }`}
                        >
                            <div className={`w-5 h-5 rounded shrink-0 flex items-center justify-center border ${
                                approvedCandidateIds.has(c.id) ? 'border-emerald-500 bg-emerald-500' : 'border-slate-600'
                            }`}>
                                {approvedCandidateIds.has(c.id) && <i className="fa-solid fa-check text-[10px] text-white"></i>}
                            </div>
                            {c.user?.avatarUrl && <img src={c.user.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />}
                            <span className="text-sm font-medium text-white">{c.user?.name || 'Unknown'}</span>
                        </button>
                    ))}
                </div>
            )}

            {/* Preferential — Rank candidates */}
            {isPreferential && (
                <div className="mb-6">
                    <p className="text-xs text-slate-400 mb-2">Rank candidates in order of preference (1st = most preferred):</p>

                    {/* Ranked list */}
                    {rankedCandidates.length > 0 && (
                        <div className="space-y-1 mb-3">
                            {rankedCandidates.map((cid, idx) => (
                                <div key={cid} className="flex items-center gap-2 bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2.5">
                                    <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center shrink-0">
                                        {idx + 1}
                                    </span>
                                    <span className="text-sm text-white flex-1">{getCandidateName(cid)}</span>
                                    <div className="flex items-center gap-1">
                                        <button onClick={() => moveInRanking(idx, -1)} disabled={idx === 0} className="p-1 text-slate-400 hover:text-white disabled:opacity-30">
                                            <i className="fa-solid fa-chevron-up text-[10px]"></i>
                                        </button>
                                        <button onClick={() => moveInRanking(idx, 1)} disabled={idx === rankedCandidates.length - 1} className="p-1 text-slate-400 hover:text-white disabled:opacity-30">
                                            <i className="fa-solid fa-chevron-down text-[10px]"></i>
                                        </button>
                                        <button onClick={() => removeFromRanking(cid)} className="p-1 text-red-400 hover:text-red-300">
                                            <i className="fa-solid fa-xmark text-[10px]"></i>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Unranked candidates */}
                    {candidates.filter(c => !rankedCandidates.includes(c.id)).length > 0 && (
                        <div className="space-y-1">
                            <p className="text-[10px] text-slate-500 mb-1">Click to add to ranking:</p>
                            {candidates.filter(c => !rankedCandidates.includes(c.id)).map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => addToRanking(c.id)}
                                    className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-slate-700/50 bg-slate-800/40 hover:border-slate-600 transition-colors text-left"
                                >
                                    {c.user?.avatarUrl && <img src={c.user.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />}
                                    <span className="text-sm text-slate-300">{c.user?.name || 'Unknown'}</span>
                                    <i className="fa-solid fa-plus text-[10px] text-slate-500 ml-auto"></i>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Submit / Cancel */}
            <div className="flex justify-end gap-2 border-t border-slate-700/50 pt-4">
                <button onClick={onCancel} className="px-4 py-2 text-xs text-slate-400 hover:text-white">Cancel</button>
                <button
                    onClick={handleSubmit}
                    disabled={!canSubmit() || isSubmitting}
                    className="flex items-center gap-2 px-5 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {isSubmitting ? (
                        <><div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full"></div>Submitting...</>
                    ) : (
                        <><i className="fa-solid fa-check"></i>Submit Vote</>
                    )}
                </button>
            </div>
        </div>
    );
};

export default VotingBooth;
