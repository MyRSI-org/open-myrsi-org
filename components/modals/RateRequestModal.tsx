
import React, { useState, useCallback } from 'react';
import { HydratedServiceRequest } from '../../types';
import { useRequests } from '../../contexts/RequestsContext';
import { useConfig } from '../../contexts/ConfigContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface RateRequestModalProps {
    isOpen: boolean;
    onClose: () => void;
    request: HydratedServiceRequest;
}

const StarRatingInput: React.FC<{ rating: number; onRate: (rating: number) => void }> = ({ rating, onRate }) => {
    const [hoverRating, setHoverRating] = useState(0);

    return (
        <div className="flex items-center space-x-3 justify-center py-6">
            {[1, 2, 3, 4, 5].map((star) => (
                <button
                    key={star}
                    onClick={() => onRate(star)}
                    onMouseEnter={() => setHoverRating(star)}
                    onMouseLeave={() => setHoverRating(0)}
                    className="transition-transform duration-150 ease-in-out hover:scale-110 focus:outline-hidden"
                    type="button"
                >
                    <i
                        className={`fa-solid fa-star text-4xl drop-shadow-md ${(hoverRating || rating) >= star ? 'text-amber-400' : 'text-slate-800'}`}
                    />
                </button>
            ))}
        </div>
    );
};


const RateRequestModal: React.FC<RateRequestModalProps> = ({ isOpen, onClose, request }) => {
    const { rateRequest } = useRequests();
    const { brandingConfig } = useConfig();
    const { addToast } = useNotification();
    const [rating, setRating] = useState(0);
    const [feedback, setFeedback] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    // Reset the rating form whenever the modal transitions to open. Adjusts state
    // during render (React's documented pattern) instead of in an effect; the
    // fields must remain user-editable so they cannot be derived during render.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (isOpen) {
            setRating(0);
            setFeedback('');
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async () => {
        if (rating === 0) return;
        setIsLoading(true);
        try {
            await rateRequest(request.id, rating, feedback);
            onClose();
        } catch (err) {
            console.error("Failed to rate request:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while submitting your rating. Please try again." });
        } finally {
            setIsLoading(false);
        }
    }, [request.id, rating, feedback, rateRequest, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Rate Service"
            subtitle="Client Feedback"
            icon="fa-solid fa-star"
            color="amber"
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-8 text-center flex-1">
                    <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mx-auto mb-6 shadow-[0_0_30px_rgba(245,158,11,0.2)]">
                        <i className="fa-solid fa-award text-3xl text-amber-500"></i>
                    </div>

                    <h2 className="text-xl font-bold text-white mb-2">How was your experience?</h2>
                    <div className="flex justify-center items-center gap-3 text-xs text-slate-400 mb-4 font-mono">
                        <span>REQ: {request.id}</span>
                        <span className="text-slate-600">|</span>
                        <span className="uppercase font-bold text-slate-300">{request.serviceType}</span>
                    </div>

                    <StarRatingInput rating={rating} onRate={setRating} />

                    <p className="text-xs text-amber-500 font-bold uppercase tracking-widest mt-2 mb-8 animate-pulse">
                        {rating === 0 ? 'Select a Rating' : rating === 5 ? 'Excellent' : rating >= 4 ? 'Good' : rating === 3 ? 'Average' : 'Poor'}
                    </p>

                    <div className="text-left">
                        <label className={labelClass}>Additional Feedback</label>
                        <textarea
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            rows={3}
                            placeholder="Optional comments for command review..."
                            className={`${inputClass} resize-none`}
                            disabled={isLoading}
                        />
                        <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
                            Your feedback helps <strong className="text-slate-400">{brandingConfig.name}</strong> improve their service. If they have a public landing page enabled, admins may select anonymous excerpts of feedback to display &mdash; your name and identity will never be shown.
                        </p>
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Skip</button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        className="px-8 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/50 hover:bg-amber-500/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                        disabled={isLoading || rating === 0}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Submit Rating'}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
};

export default RateRequestModal;
