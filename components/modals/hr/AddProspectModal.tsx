
import React, { useState, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useAuth } from '../../../contexts/AuthContext';

import WindowFrame from '../../layout/WindowFrame';
import { useNotification } from '../../../contexts/NotificationContext';

interface AddProspectModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const AddProspectModal: React.FC<AddProspectModalProps> = ({ isOpen, onClose }) => {
    const { rpcAction, refreshHR } = useData();
    const { allUsers } = useMembers();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();

    const [rsiHandle, setRsiHandle] = useState('');
    const [applicantName, setApplicantName] = useState('');
    const [referral, setReferral] = useState('');
    const [notes, setNotes] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [linkedUser, setLinkedUser] = useState<any>(null);

    // Reset form on open. React-documented "adjust state during render" pattern
    // (previous-value tracker): behaviour-equivalent to the prior effect (deps
    // [isOpen]) which cleared the fields on the closed -> open transition.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (isOpen) {
            setRsiHandle('');
            setApplicantName('');
            setReferral('');
            setNotes('');
            setLinkedUser(null);
            setIsLoading(false);
        }
    }

    const handleRsiChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setRsiHandle(e.target.value);
        // Unlock name field and clear link if user changes handle
        if (linkedUser) {
            setLinkedUser(null);
        }
    };

    // Auto-fill logic when RSI Handle changes
    const handleRsiBlur = () => {
        if (!rsiHandle.trim()) {
            setLinkedUser(null);
            return;
        }
        const existingUser = allUsers.find(u => u.rsiHandle.toLowerCase() === rsiHandle.trim().toLowerCase());
        if (existingUser) {
            setLinkedUser(existingUser);
            setApplicantName(existingUser.name);
        } else {
            setLinkedUser(null);
        }
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!rsiHandle.trim() || !applicantName.trim()) {
            addToast("Validation Error", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "RSI Handle and Name are required." });
            return;
        }

        setIsLoading(true);
        try {
            await rpcAction('user:submit_application', {
                name: applicantName.trim(),
                rsiHandle: rsiHandle.trim(),
                referral: referral.trim(),
                notes: notes.trim(),
                userId: currentUser?.id
            });
            // UX Optimization: Close immediately, refresh in background
            onClose();
            addToast("Case File Opened", <i className="fa-solid fa-folder-plus"></i>, "bg-emerald-500/10 text-emerald-400 border-emerald-500/50", { description: "New case file created successfully." });
            refreshHR();
        } catch (err) {
            console.error("Failed to add prospect:", err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred. Please check if this RSI handle is already in the system." });
            setIsLoading(false);
        }
    }, [rsiHandle, applicantName, referral, notes, rpcAction, refreshHR, onClose, currentUser, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Open New Case File"
            subtitle="Recruitment & Vetting"
            icon="fa-solid fa-folder-plus"
            color="amber"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    <div className="bg-amber-900/10 border border-amber-500/20 p-4 rounded-xl text-xs text-amber-200">
                        <i className="fa-solid fa-circle-info mr-2"></i>
                        Enter the candidate or subject details. If their RSI Handle matches a registered user, they will be automatically linked.
                    </div>

                    <div>
                        <label className={labelClass}>RSI Handle <span className="text-red-400">*</span></label>
                        <div className="relative">
                            <input
                                type="text"
                                value={rsiHandle}
                                onChange={handleRsiChange}
                                onBlur={handleRsiBlur}
                                placeholder="e.g. StarCitizenPlayer"
                                className={`${inputClass} ${linkedUser ? 'border-green-500 focus:border-green-500' : ''}`}
                                required
                                disabled={isLoading}
                            />
                            {linkedUser && (
                                <div className="absolute right-3 top-3 text-green-400" title="Linked to registered user">
                                    <i className="fa-solid fa-link"></i>
                                </div>
                            )}
                        </div>
                        {linkedUser && <p className="text-[10px] text-green-400 mt-1 font-bold">Matched with user: {linkedUser.name}</p>}
                    </div>

                    <div>
                        <label className={labelClass}>Subject Name <span className="text-red-400">*</span></label>
                        <input
                            type="text"
                            value={applicantName}
                            onChange={(e) => setApplicantName(e.target.value)}
                            placeholder="Discord Display Name"
                            className={`${inputClass} ${linkedUser ? 'opacity-60 cursor-not-allowed' : ''}`}
                            required
                            disabled={isLoading || !!linkedUser}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Context / Referral Source</label>
                        <input
                            type="text"
                            value={referral}
                            onChange={(e) => setReferral(e.target.value)}
                            placeholder="e.g. Recruitment, Investigation, Internal Review"
                            className={inputClass}
                            disabled={isLoading}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Initial Notes</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={3}
                            className={`${inputClass} resize-none`}
                            placeholder="Any initial observations..."
                            disabled={isLoading}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/50 hover:bg-amber-500/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Open File'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default AddProspectModal;
