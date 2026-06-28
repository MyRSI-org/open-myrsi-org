
import React, { useState, useCallback } from 'react';
import { ExternalTool, UserRole } from '../../types';
import { useConfig } from '../../contexts/ConfigContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface ExternalToolModalProps {
    isOpen: boolean;
    onClose: () => void;
    tool?: ExternalTool;
}

const ExternalToolModal: React.FC<ExternalToolModalProps> = ({ isOpen, onClose, tool }) => {
    const { addExternalTool, updateExternalTool, externalTools } = useConfig();
    const { addToast } = useNotification();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [url, setUrl] = useState('');
    const [icon, setIcon] = useState('');
    const [audience, setAudience] = useState<string[]>([]);
    const [category, setCategory] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!tool;

    // Suggest categories the org has already used so admins reuse names
    // instead of fragmenting "Logistics" / "logistics" / "logistic".
    const existingCategories = React.useMemo(
        () => Array.from(new Set(externalTools.map(t => t.category).filter((c): c is string => !!c && !!c.trim()))).sort(),
        [externalTools]
    );

    // Reset editable form fields whenever the modal opens or the selected tool
    // changes. The fields must remain user-editable afterwards, so they are
    // seeded (not derived) using the React "adjust state during render" pattern
    // with previous-value trackers. This re-renders before paint and is
    // behavior-equivalent to the previous sync-with-prop effect, while running
    // during render so no state is set inside an effect.
    // prevIsOpen starts false so that a mount with isOpen already true seeds the
    // fields exactly as the mount-time effect did (this modal is conditionally
    // mounted, so it always mounts with isOpen === true).
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevTool, setPrevTool] = useState(tool);
    if (isOpen && (isOpen !== prevIsOpen || tool !== prevTool)) {
        setPrevIsOpen(isOpen);
        setPrevTool(tool);
        if (tool) {
            setTitle(tool.title);
            setDescription(tool.description || '');
            setUrl(tool.url || '');
            setIcon(tool.icon || '');
            setAudience(tool.audience || []);
            setCategory(tool.category || '');
        } else {
            setTitle('');
            setDescription('');
            setUrl('');
            setIcon('');
            setAudience([UserRole.Member, UserRole.Dispatcher, UserRole.Admin]);
            setCategory('');
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || tool !== prevTool) {
        // Keep trackers in sync even when the modal is closed so the next open
        // (or a tool change while closed) is detected correctly.
        setPrevIsOpen(isOpen);
        setPrevTool(tool);
    }

    const handleAudienceChange = (role: string) => {
        setAudience(prev =>
            prev.includes(role)
                ? prev.filter(r => r !== role)
                : [...prev, role]
        );
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !url.trim() || !icon.trim()) return;

        setIsLoading(true);
        const toolData = {
            title: title.trim(),
            description: description.trim(),
            url: url.trim(),
            icon: icon.trim(),
            audience: audience,
            category: category.trim() || undefined,
            // Preserve existing sortOrder on edit; new tools land at 0 and get
            // pushed around with the up/down arrows in the admin tab.
            sortOrder: isEditing && tool ? tool.sortOrder : undefined,
        };

        try {
            if (isEditing && tool) {
                await updateExternalTool({ ...tool, ...toolData });
            } else {
                await addExternalTool(toolData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save external tool:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the tool. Please try again." });
            setIsLoading(false);
        }
    }, [title, description, url, icon, audience, isEditing, tool, addExternalTool, updateExternalTool, onClose, addToast, category]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";
    const audienceOptions = Object.values(UserRole);

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit External Tool' : 'Create External Tool'}
            subtitle="Resource Management"
            icon="fa-solid fa-toolbox"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    <div>
                        <label className={labelClass}>Title</label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g., Coriolis Ship Builder"
                            className={inputClass}
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Category (Optional)</label>
                        <input
                            type="text"
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                            placeholder="e.g., Theorycraft, Logistics, Reference"
                            list="external-tool-category-suggestions"
                            className={inputClass}
                            disabled={isLoading}
                        />
                        {existingCategories.length > 0 && (
                            <datalist id="external-tool-category-suggestions">
                                {existingCategories.map(c => <option key={c} value={c} />)}
                            </datalist>
                        )}
                        <p className="text-[10px] text-slate-500 mt-1">Tools sharing a category are grouped together in the user-facing view. Leave blank to file under "General".</p>
                    </div>
                    <div>
                        <label className={labelClass}>URL</label>
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://coriolis.io"
                            className={`${inputClass} font-mono`}
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Font Awesome Icon</label>
                        <div className="flex gap-3 items-center">
                            <input
                                type="text"
                                value={icon}
                                onChange={(e) => setIcon(e.target.value)}
                                placeholder="e.g., fa-solid fa-ship"
                                className={`${inputClass} font-mono`}
                                required
                                disabled={isLoading}
                            />
                            {icon && (
                                <div className="w-10 h-10 shrink-0 bg-slate-800 rounded-lg border border-slate-700 flex items-center justify-center">
                                    <i className={`${icon} text-sky-400 text-lg`}></i>
                                </div>
                            )}
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={2}
                            placeholder="A tool for theorycrafting ship builds."
                            className={`${inputClass} resize-none`}
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Audience Access</label>
                        <div className="grid grid-cols-2 gap-3">
                            {audienceOptions.map(opt => (
                                <label key={opt} className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${audience.includes(opt) ? 'bg-sky-500/20 border-sky-500/50' : 'bg-slate-950 border-slate-800 hover:bg-slate-900'}`}>
                                    <input
                                        type="checkbox"
                                        checked={audience.includes(opt)}
                                        onChange={() => handleAudienceChange(opt)}
                                        className="h-4 w-4 rounded-sm bg-slate-800 border-slate-600 text-sky-500 focus:ring-sky-500"
                                        disabled={isLoading}
                                    />
                                    <span className="text-xs font-bold text-slate-300">{opt}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2 bg-sky-500/10 text-sky-400 border border-sky-500/50 hover:bg-sky-500/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Tool')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default ExternalToolModal;
