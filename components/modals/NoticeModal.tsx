
import React, { useState, useCallback } from 'react';
import { Announcement, AnnouncementType } from '../../types';
import { useAnnouncements } from '../../contexts/AnnouncementsContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface NoticeModalProps {
    isOpen: boolean;
    onClose: () => void;
    notice?: Announcement;
}

type AudienceOption = 'Client' | 'Member' | 'Admin' | 'Login Screen';

const AUDIENCE_CONFIG: { value: AudienceOption; label: string; description: string; icon: string }[] = [
    { value: 'Client', label: 'Client Dashboard', description: 'All logged in clients can see this notice.', icon: 'fa-solid fa-headset' },
    { value: 'Member', label: 'Members Dashboard', description: 'All logged in members can see this notice.', icon: 'fa-solid fa-users' },
    { value: 'Admin', label: 'Admins Only', description: 'All logged in admins will see this notice on the dashboard and other views.', icon: 'fa-solid fa-shield-halved' },
    { value: 'Login Screen', label: 'Login Screen', description: 'Shown on the login screen for all visitors.', icon: 'fa-solid fa-right-to-bracket' },
];

const NoticeModal: React.FC<NoticeModalProps> = ({ isOpen, onClose, notice }) => {
    const { addAnnouncement, updateAnnouncement } = useAnnouncements();
    const { addToast } = useNotification();

    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [type, setType] = useState<AnnouncementType>(AnnouncementType.Information);
    const [audience, setAudience] = useState<AudienceOption[]>([]);
    const [expiryDate, setExpiryDate] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const isEditing = !!notice;

    // Reset/seed the user-editable form fields when the dialog opens or the
    // selected notice changes while open. Done during render via the React
    // "adjust state during render" pattern (re-renders before paint), which is
    // behaviour-equivalent to the previous open/selection-change reset effect.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevNotice, setPrevNotice] = useState(notice);
    if (isOpen && (isOpen !== prevIsOpen || notice !== prevNotice)) {
        setPrevIsOpen(isOpen);
        setPrevNotice(notice);
        if (notice) {
            setTitle(notice.title);
            setBody(notice.body);
            setType(notice.type);
            setAudience(notice.audience as AudienceOption[]);
            setExpiryDate(notice.expiryDate || null);
        } else {
            setTitle('');
            setBody('');
            setType(AnnouncementType.Information);
            setAudience([]);
            setExpiryDate(null);
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || notice !== prevNotice) {
        // Keep trackers in sync even when the dialog is closed, so the next
        // open is detected correctly (mirrors the effect's dep array firing
        // without performing the reset while closed).
        setPrevIsOpen(isOpen);
        setPrevNotice(notice);
    }

    const handleAudienceChange = (role: AudienceOption) => {
        setAudience(prev =>
            prev.includes(role)
                ? prev.filter(r => r !== role)
                : [...prev, role]
        );
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !body.trim() || audience.length === 0) {
            addToast("Validation Error", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "Title, Body, and at least one Audience are required." });
            return;
        }

        setIsLoading(true);
        const noticeData = {
            title: title.trim(),
            body: body.trim(),
            type,
            audience,
            expiryDate,
        };

        try {
            if (isEditing && notice) {
                await updateAnnouncement({ ...notice, ...noticeData });
            } else {
                await addAnnouncement(noticeData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save notice:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the notice. Please try again." });
            setIsLoading(false);
        }
    }, [title, body, type, audience, expiryDate, isEditing, notice, addAnnouncement, updateAnnouncement, onClose, addToast]);

    if (!isOpen) return null;

    const audienceOptions = AUDIENCE_CONFIG;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Notice' : 'Create Notice'}
            subtitle="Broadcast System"
            icon="fa-solid fa-bullhorn"
            color="sky"
            width="max-w-2xl"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6">
                    {/* scheme-light on inputs handles calendar icon visibility */}
                    <div>
                        <label htmlFor="noticeTitle" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Title</label>
                        <input type="text" id="noticeTitle" value={title} onChange={e => setTitle(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all" required disabled={isLoading} />
                    </div>
                    <div>
                        <label htmlFor="noticeBody" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Body</label>
                        <textarea id="noticeBody" value={body} onChange={e => setBody(e.target.value)} rows={5} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all resize-none" required disabled={isLoading} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label htmlFor="noticeType" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Notice Type</label>
                            <select id="noticeType" value={type} onChange={e => setType(e.target.value as AnnouncementType)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all" disabled={isLoading}>
                                {Object.values(AnnouncementType).map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="expiryDate" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Expiry Date (Optional)</label>
                            <input
                                type="datetime-local"
                                id="expiryDate"
                                value={expiryDate ? expiryDate.substring(0, 16) : ''}
                                onChange={e => setExpiryDate(e.target.value ? new Date(e.target.value).toISOString() : null)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all scheme-light"
                                disabled={isLoading}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Audience</label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {audienceOptions.map(opt => (
                                <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${audience.includes(opt.value) ? 'bg-sky-500/20 border-sky-500/50' : 'bg-slate-950 border-slate-700 hover:bg-slate-900'}`}>
                                    <input
                                        type="checkbox"
                                        checked={audience.includes(opt.value)}
                                        onChange={() => handleAudienceChange(opt.value)}
                                        className="h-5 w-5 rounded-sm bg-slate-800 border-slate-600 text-sky-500 focus:ring-sky-500 mt-0.5 shrink-0"
                                        disabled={isLoading}
                                    />
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <i className={`${opt.icon} text-xs ${audience.includes(opt.value) ? 'text-sky-400' : 'text-slate-500'}`}></i>
                                            <span className="text-sm font-bold text-slate-300">{opt.label}</span>
                                        </div>
                                        <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">{opt.description}</p>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-end items-center p-4 bg-slate-900/50 border-t border-white/5 rounded-b-xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none border border-sky-500/50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Notice')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default NoticeModal;
