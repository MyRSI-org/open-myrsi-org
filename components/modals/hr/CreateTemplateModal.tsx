
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { HRInterviewTemplate } from '../../../types';
import { useData } from '../../../contexts/DataContext';

import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

interface CreateTemplateModalProps {
    isOpen: boolean;
    onClose: () => void;
    template?: HRInterviewTemplate;
}

// Editable questions carry a stable client-only id so React keys survive
// reorder/remove without falling back to the array index. The id is purely a
// rendering concern — it is stripped at submit time, so the wire payload stays
// the bare `string[]` the server expects.
interface QuestionDraft {
    id: string;
    text: string;
}

const CreateTemplateModal: React.FC<CreateTemplateModalProps> = ({ isOpen, onClose, template }) => {
    const { rpcAction, refreshHR } = useData();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [questions, setQuestions] = useState<QuestionDraft[]>([]);
    const [newQuestion, setNewQuestion] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isFetching, setIsFetching] = useState(false);
    const isEditing = !!template;

    // Monotonic counter for synthetic question keys. Only ever read in event
    // handlers / the async fetch (never during render), so it stays render-pure.
    const questionIdRef = useRef(0);
    const nextQuestionId = useCallback(() => `q-${questionIdRef.current++}`, []);

    // Seed / reset the editable form during render whenever the modal opens or
    // the selected template changes (React's "adjust state during render" pattern).
    // Tracking both isOpen and template reproduces the old open-reset effect: a new
    // open event, or swapping the edited template while open, re-hydrates the fields.
    // This runs before paint, so it is behaviour-equivalent to the previous effect's
    // synchronous seeding — without the cascading-render setState-in-effect.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevTemplate, setPrevTemplate] = useState(template);
    if (isOpen && (!prevIsOpen || template !== prevTemplate)) {
        setPrevIsOpen(isOpen);
        setPrevTemplate(template);
        if (template) {
            setName(template.name);
            setDescription(template.description);
            // Async question load resolves isFetching to false; mark it loading up
            // front so there's no flash of the empty-question state for editing.
            setIsFetching(true);
        } else {
            setName('');
            setDescription('');
            setQuestions([]);
            setIsFetching(false);
        }
        setIsLoading(false);
    } else if (!isOpen && prevIsOpen) {
        // Keep the trackers in step with the closed state so the next open
        // (even to the same template reference) is detected as a fresh open event.
        setPrevIsOpen(false);
        setPrevTemplate(template);
    }

    // Fetch the template's questions when editing. The async body runs in a
    // microtask (after the first await), so it performs no synchronous setState
    // in the effect; isFetching(true) is seeded above during render. A cancelled
    // flag drops a stale response if the template changes or the modal closes.
    useEffect(() => {
        if (!isOpen || !template) return;
        const id = template.id;
        let cancelled = false;
        (async () => {
            try {
                const details: HRInterviewTemplate = await rpcAction('hr:get_template_details', { id });
                if (cancelled) return;
                if (details && details.questions) {
                    setQuestions(details.questions.sort((a, b) => a.orderIndex - b.orderIndex).map(q => ({ id: nextQuestionId(), text: q.questionText })));
                }
            } catch (error) {
                if (cancelled) return;
                console.error("Failed to fetch template questions:", error);
                addToast("Load Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Could not load question details." });
            } finally {
                if (!cancelled) setIsFetching(false);
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, template, rpcAction, addToast, nextQuestionId]);

    const handleAddQuestion = (e: React.FormEvent) => {
        e.preventDefault();
        if (newQuestion.trim()) {
            setQuestions([...questions, { id: nextQuestionId(), text: newQuestion.trim() }]);
            setNewQuestion('');
        }
    };

    const removeQuestion = (index: number) => {
        setQuestions(questions.filter((_, i) => i !== index));
    };

    const moveQuestion = (index: number, direction: -1 | 1) => {
        if ((index === 0 && direction === -1) || (index === questions.length - 1 && direction === 1)) return;
        const newQs = [...questions];
        const temp = newQs[index];
        newQs[index] = newQs[index + direction];
        newQs[index + direction] = temp;
        setQuestions(newQs);
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const data = {
            name: name.trim(),
            description: description.trim(),
            // Strip the synthetic ids — the server expects a bare string[].
            questions: questions.map(q => q.text),
        };

        try {
            if (isEditing && template) {
                await rpcAction('hr:update_template', { ...data, id: template.id });
            } else {
                await rpcAction('hr:create_template', data);
            }
            await refreshHR();
            onClose();
        } catch (err) {
            console.error("Failed to save template:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred. Please try again." });
        } finally {
            setIsLoading(false);
        }
    }, [name, description, questions, isEditing, template, rpcAction, refreshHR, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Protocol' : 'New Interview Protocol'}
            subtitle="Questionnaire Config"
            icon="fa-solid fa-clipboard-question"
            color="emerald"
            width="max-w-2xl"
        >
            <form onSubmit={(e) => e.preventDefault()} className="flex flex-col h-full">
                <div className="p-6 space-y-6">
                    {isFetching ? (
                        <div className="flex justify-center items-center h-48 text-slate-500 flex-col gap-3">
                            <i className="fa-solid fa-circle-notch animate-spin text-3xl text-emerald-300"></i>
                            <p className="text-[10px] uppercase tracking-widest font-bold">Loading Data...</p>
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 gap-5">
                                <div>
                                    <label className={labelClass}>Protocol Name</label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        className={inputClass}
                                        required
                                        disabled={isLoading}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Description</label>
                                    <textarea
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        rows={2}
                                        className={`${inputClass} resize-none`}
                                        disabled={isLoading}
                                    />
                                </div>
                            </div>

                            <div className="border-t border-slate-700/50 pt-5">
                                <label className={labelClass}>Interview Questions</label>
                                <div className="flex gap-2 mb-4">
                                    <input
                                        type="text"
                                        value={newQuestion}
                                        onChange={(e) => setNewQuestion(e.target.value)}
                                        className={inputClass}
                                        placeholder="Type a question and press +"
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleAddQuestion(e); }}
                                        disabled={isLoading}
                                    />
                                    <button
                                        onClick={handleAddQuestion}
                                        type="button"
                                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 rounded-lg font-bold transition-colors disabled:opacity-50 border border-emerald-500/40 shadow-lg shadow-emerald-900/30"
                                        disabled={isLoading || !newQuestion.trim()}
                                    >
                                        <i className="fa-solid fa-plus"></i>
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    {questions.map((q, i) => (
                                        <div key={q.id} className="flex items-center gap-3 bg-slate-900/40 p-3 rounded-lg border border-slate-800 group hover:border-slate-700 transition-colors">
                                            <span className="text-slate-500 font-mono text-[10px] font-bold w-6 text-center">{i + 1}.</span>
                                            <p className="flex-1 text-sm text-slate-300">{q.text}</p>
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button type="button" onClick={() => moveQuestion(i, -1)} disabled={i === 0} className="text-slate-500 hover:text-white p-1.5 rounded-sm hover:bg-slate-800 disabled:opacity-30 transition-colors"><i className="fa-solid fa-arrow-up text-xs"></i></button>
                                                <button type="button" onClick={() => moveQuestion(i, 1)} disabled={i === questions.length - 1} className="text-slate-500 hover:text-white p-1.5 rounded-sm hover:bg-slate-800 disabled:opacity-30 transition-colors"><i className="fa-solid fa-arrow-down text-xs"></i></button>
                                                <button type="button" onClick={() => removeQuestion(i)} className="text-slate-500 hover:text-red-400 p-1.5 ml-2 rounded-sm hover:bg-red-900/20 transition-colors"><i className="fa-solid fa-trash text-xs"></i></button>
                                            </div>
                                        </div>
                                    ))}
                                    {questions.length === 0 && (
                                        <div className="text-center py-6 border-2 border-dashed border-slate-800 rounded-lg">
                                            <p className="text-slate-500 text-xs italic">No questions added yet.</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition disabled:opacity-50"
                        disabled={isLoading || isFetching}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Protocol'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CreateTemplateModal;
