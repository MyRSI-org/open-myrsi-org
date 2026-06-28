
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth } from '../../../contexts/AuthContext';

import { HydratedHRInterview, HRInterviewQuestion } from '../../../types';
import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

interface ConductInterviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    interview: HydratedHRInterview;
}

const ConductInterviewModal: React.FC<ConductInterviewModalProps> = ({ isOpen, onClose, interview }) => {
    const { rpcAction, refreshHR } = useData();
    const { hrApplicants } = useHR();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();
    const [responses, setResponses] = useState<{ [key: number]: { text: string; score: number } }>({});
    const [overallNotes, setOverallNotes] = useState(interview.overallNotes || '');
    const [isRecommended, setIsRecommended] = useState<boolean>(interview.isRecommended || false);
    const [isLoading, setIsLoading] = useState(false);
    const [isFetchingTemplate, setIsFetchingTemplate] = useState(true);
    const [activeQuestionId, setActiveQuestionId] = useState<number | null>(null);
    const [questions, setQuestions] = useState<HRInterviewQuestion[]>([]);
    const noteAreaRef = useRef<HTMLTextAreaElement>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    const isCompleted = interview.status === 'Completed';

    const applicantName = useMemo(() => {
        const applicant = hrApplicants.find(a => a.id === interview.applicationId);
        return applicant ? applicant.applicantName : 'Unknown Applicant';
    }, [hrApplicants, interview.applicationId]);

    // Reset the submit-loading flag on the same trigger that (re)loads the template:
    // when the modal opens or the interview / isCompleted / rpcAction inputs change.
    // React-documented "adjust state during render" pattern (previous-value tracker):
    // the prior code set this flag false synchronously inside the load effect; here it
    // is reset during render on the identical input set, while the async template load
    // (whose setState all happen behind an await) stays in the effect below.
    const [prevLoadKey, setPrevLoadKey] = useState({ isOpen, interview, isCompleted, rpcAction });
    if (
        prevLoadKey.isOpen !== isOpen ||
        prevLoadKey.interview !== interview ||
        prevLoadKey.isCompleted !== isCompleted ||
        prevLoadKey.rpcAction !== rpcAction
    ) {
        setPrevLoadKey({ isOpen, interview, isCompleted, rpcAction });
        if (isOpen) {
            setIsLoading(false);
        }
    }

    useEffect(() => {
        if (isOpen) {
            const fetchTemplate = async () => {
                setIsFetchingTemplate(true);
                try {
                    const templateData = await rpcAction('hr:get_template_details', { id: interview.templateId });
                    const loadedQuestions = templateData?.questions || [];
                    setQuestions(loadedQuestions);

                    const initialResponses: { [key: number]: { text: string; score: number } } = {};
                    interview.responses.forEach(r => { initialResponses[r.questionId] = { text: r.responseBody, score: r.score }; });

                    if (!isCompleted && Object.keys(initialResponses).length === 0) {
                        loadedQuestions.forEach((q: HRInterviewQuestion) => { initialResponses[q.id] = { text: '', score: 3 }; });
                    }
                    if (isCompleted) {
                        loadedQuestions.forEach((q: HRInterviewQuestion) => { if (!initialResponses[q.id]) initialResponses[q.id] = { text: '(No response)', score: 0 }; });
                    }

                    setResponses(initialResponses);
                    setOverallNotes(interview.overallNotes || '');
                    setIsRecommended(interview.isRecommended || false);
                    setActiveQuestionId(loadedQuestions.length > 0 ? loadedQuestions[0].id : null);
                } catch (err) { console.error(err); onCloseRef.current(); } finally { setIsFetchingTemplate(false); }
            };
            fetchTemplate();
        }
    }, [isOpen, interview, isCompleted, rpcAction]);

    const handleResponseChange = (qId: number, field: 'text' | 'score', value: string | number) => {
        if (isCompleted) return;
        setResponses(prev => ({ ...prev, [qId]: { ...prev[qId], [field]: value } }));
    };

    const calculateFinalScore = useMemo(() => {
        const scores = (Object.values(responses) as { text: string; score: number }[]).map(r => r.score);
        const validScores = scores.filter(s => s > 0);
        if (validScores.length === 0) return 0;
        const total = validScores.reduce((a, b) => a + b, 0);
        return Math.round((total / validScores.length) * 10) / 10;
    }, [responses]);

    const handleSubmit = async () => {
        if (isCompleted) { onClose(); return; }
        setIsLoading(true);
        const formattedResponses = (Object.entries(responses) as [string, { text: string; score: number }][]).map(([qId, data]) => ({
            questionId: parseInt(qId), text: data.text, score: data.score
        }));
        try {
            await rpcAction('hr:save_interview', {
                id: interview.id,
                interviewerId: currentUser?.id,
                results: { notes: overallNotes, finalScore: Math.round(calculateFinalScore), isRecommended, responses: formattedResponses }
            });
            await refreshHR();
            onClose();
        } catch (err) { console.error(err); addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save interview evaluation." }); } finally { setIsLoading(false); }
    };

    useEffect(() => {
        if (!isCompleted && activeQuestionId && noteAreaRef.current) noteAreaRef.current.focus();
    }, [activeQuestionId, isCompleted]);

    const activeQuestion = questions.find(q => q.id === activeQuestionId);
    const activeResponse = activeQuestionId ? responses[activeQuestionId] : null;

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={applicantName}
            subtitle={interview.template.name}
            icon="fa-solid fa-microphone-lines"
            color="emerald"
            width="max-w-6xl"
        >
            {/* Header: Status, Panel, and Score */}
            <div className="bg-slate-900 border-b border-slate-700/50 p-4 flex justify-between items-center shrink-0">
                <div className="flex items-center gap-3">
                    <span className={`text-xs px-2 py-0.5 rounded-sm border uppercase font-bold tracking-wider ${isCompleted ? 'bg-green-500/10 border-green-500/50 text-green-400' : 'bg-sky-500/10 border-sky-500/50 text-sky-400'}`}>
                        {isCompleted ? 'Completed Review' : 'Live Interview'}
                    </span>
                    {/* Interview panel display */}
                    <div className="flex items-center gap-1.5">
                        <img src={interview.interviewer.avatarUrl} className="h-6 w-6 rounded-full border-2 border-emerald-500/50" alt="" title={`Lead: ${interview.interviewer.name}`} />
                        {interview.panelMembers?.map(pm => (
                            <img key={pm.id} src={pm.avatarUrl} className="h-5 w-5 rounded-full border border-slate-600 -ml-1" alt="" title={pm.name} />
                        ))}
                        {interview.panelMembers?.length > 0 && (
                            <span className="text-[10px] text-slate-500 font-semibold ml-0.5">{1 + interview.panelMembers.length} panel</span>
                        )}
                    </div>
                </div>
                <div className="flex items-baseline gap-2">
                    <p className="text-[10px] text-slate-500 uppercase font-black tracking-wider">Score</p>
                    <span className={`text-2xl font-black ${calculateFinalScore >= 4 ? 'text-green-400' : calculateFinalScore <= 2 ? 'text-red-400' : 'text-amber-400'}`}>
                        {calculateFinalScore}
                    </span>
                    <span className="text-slate-600 text-xs font-bold">/ 5</span>
                </div>
            </div>

            {isFetchingTemplate ? (
                <div className="flex items-center justify-center h-64 text-slate-500">
                    <i className="fa-solid fa-circle-notch animate-spin text-3xl mb-4"></i>
                </div>
            ) : (
                <div className="flex flex-col md:flex-row h-[70vh]">
                    {/* Sidebar: Constrained height on mobile to ensure content visibility */}
                    <div className="w-full md:w-64 max-h-32 md:max-h-full border-b md:border-b-0 md:border-r border-slate-700/50 bg-slate-900/30 overflow-y-auto custom-scrollbar shrink-0">
                        <div className="p-3 space-y-1">
                            {questions.map((q, index) => {
                                const resp = responses[q.id];
                                const hasAnswer = resp?.text?.trim().length > 0;
                                const scoreColor = resp?.score >= 4 ? 'text-green-400' : resp?.score <= 2 ? 'text-red-400' : 'text-amber-400';

                                return (
                                    <button
                                        key={q.id}
                                        onClick={() => setActiveQuestionId(q.id)}
                                        className={`w-full text-left p-3 rounded-lg border transition-all flex items-center gap-3 ${activeQuestionId === q.id ? 'bg-sky-600/10 border-sky-500 shadow-lg' : 'bg-slate-800/20 border-transparent hover:bg-slate-800'}`}
                                    >
                                        <div className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${activeQuestionId === q.id ? 'bg-sky-500 text-white' : hasAnswer ? 'bg-slate-700 text-slate-300' : 'bg-slate-800 text-slate-600'}`}>
                                            {index + 1}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className={`text-xs font-medium truncate ${activeQuestionId === q.id ? 'text-white' : 'text-slate-400'}`}>{q.questionText}</p>
                                            <div className="flex justify-between mt-1">
                                                <span className={`text-[9px] font-mono font-bold ${scoreColor}`}>{resp?.score}/5</span>
                                            </div>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                        <div className="p-3 border-t border-slate-700/50 mt-auto">
                            <button onClick={() => setActiveQuestionId(-1)} className={`w-full text-left p-3 rounded-lg border transition-all flex items-center gap-3 ${activeQuestionId === -1 ? 'bg-emerald-500/15 border-emerald-500/40 shadow-xs shadow-emerald-900/20' : 'bg-slate-800/20 border-transparent hover:bg-slate-800'}`}>
                                <div className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${activeQuestionId === -1 ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-500'}`}><i className="fa-solid fa-star"></i></div>
                                <span className={`text-sm font-bold ${activeQuestionId === -1 ? 'text-white' : 'text-slate-400'}`}>Assessment</span>
                            </button>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 p-6 overflow-y-auto custom-scrollbar bg-slate-900/50">
                        {activeQuestionId === -1 ? (
                            <div className="max-w-3xl mx-auto space-y-6">
                                <div>
                                    <h3 className="text-xl font-bold text-white mb-2">Final Assessment</h3>
                                    <textarea
                                        value={overallNotes}
                                        onChange={(e) => setOverallNotes(e.target.value)}
                                        className="w-full h-48 bg-slate-950/50 border border-slate-700 rounded-lg p-4 text-white focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/30 outline-hidden resize-none"
                                        placeholder="Final recommendation..."
                                        disabled={isCompleted}
                                    />
                                </div>
                                <div className="flex gap-4">
                                    <button onClick={() => !isCompleted && setIsRecommended(true)} disabled={isCompleted} className={`flex-1 p-4 rounded-lg border transition-all flex flex-col items-center gap-2 ${isRecommended ? 'bg-green-500/10 border-green-500 text-green-400' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                                        <i className="fa-solid fa-thumbs-up text-2xl"></i>
                                        <span className="font-bold uppercase text-xs">Recommend</span>
                                    </button>
                                    <button onClick={() => !isCompleted && setIsRecommended(false)} disabled={isCompleted} className={`flex-1 p-4 rounded-lg border transition-all flex flex-col items-center gap-2 ${!isRecommended ? 'bg-red-500/10 border-red-500 text-red-400' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                                        <i className="fa-solid fa-thumbs-down text-2xl"></i>
                                        <span className="font-bold uppercase text-xs">Reject</span>
                                    </button>
                                </div>
                                {!isCompleted && (
                                    <button onClick={handleSubmit} disabled={isLoading} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg shadow-lg shadow-emerald-900/30 border border-emerald-500/40 transition-all uppercase tracking-widest text-xs">
                                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Submit Evaluation'}
                                    </button>
                                )}
                            </div>
                        ) : activeQuestion && activeResponse ? (
                            <div className="max-w-3xl mx-auto flex flex-col h-full">
                                <div className="mb-6 shrink-0">
                                    <span className="text-sky-500 font-bold text-xs uppercase tracking-widest mb-2 block">Question {questions.findIndex(q => q.id === activeQuestion.id) + 1}</span>
                                    <h3 className="text-xl md:text-2xl font-bold text-white leading-tight">{activeQuestion.questionText}</h3>
                                </div>
                                <div className="flex-1 mb-6 min-h-[150px]">
                                    <textarea
                                        ref={noteAreaRef}
                                        value={activeResponse.text}
                                        onChange={(e) => handleResponseChange(activeQuestion.id, 'text', e.target.value)}
                                        className="w-full h-full bg-slate-950/50 border border-slate-700 rounded-lg p-4 text-white text-base focus:border-sky-500 outline-hidden resize-none"
                                        placeholder="Record response..."
                                        disabled={isCompleted}
                                    />
                                </div>
                                <div className="grid grid-cols-5 gap-2 shrink-0">
                                    {[1, 2, 3, 4, 5].map(score => {
                                        const isSelected = activeResponse.score === score;
                                        let color = 'border-slate-700 text-slate-500 hover:bg-slate-800';
                                        if (isSelected) {
                                            if (score <= 2) color = 'bg-red-500/20 border-red-500 text-red-400';
                                            else if (score === 3) color = 'bg-amber-500/20 border-amber-500 text-amber-400';
                                            else color = 'bg-green-500/20 border-green-500 text-green-400';
                                        }
                                        return (
                                            <button
                                                key={score}
                                                onClick={() => handleResponseChange(activeQuestion.id, 'score', score)}
                                                disabled={isCompleted}
                                                className={`py-3 rounded-lg border font-black text-xl transition-all ${color}`}
                                            >
                                                {score}
                                            </button>
                                        )
                                    })}
                                </div>
                                <div className="flex justify-between mt-6 pt-4 border-t border-slate-700/50 shrink-0">
                                    <button
                                        onClick={() => { const idx = questions.findIndex(q => q.id === activeQuestionId); if (idx > 0) setActiveQuestionId(questions[idx - 1].id); }}
                                        disabled={questions.findIndex(q => q.id === activeQuestionId) === 0}
                                        className="text-slate-400 hover:text-white font-bold text-xs uppercase disabled:opacity-0"
                                    >
                                        <i className="fa-solid fa-arrow-left mr-2"></i> Previous
                                    </button>
                                    <button
                                        onClick={() => { const idx = questions.findIndex(q => q.id === activeQuestionId); if (idx < questions.length - 1) setActiveQuestionId(questions[idx + 1].id); else setActiveQuestionId(-1); }}
                                        className="bg-sky-600 hover:bg-sky-500 text-white px-6 py-2 rounded-lg font-bold text-xs uppercase shadow-lg shadow-sky-900/20"
                                    >
                                        {questions.findIndex(q => q.id === activeQuestionId) === questions.length - 1 ? 'Finish' : 'Next'} <i className="fa-solid fa-arrow-right ml-2"></i>
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            )}
        </WindowFrame>
    );
};

export default ConductInterviewModal;
