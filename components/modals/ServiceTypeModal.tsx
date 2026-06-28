
import React, { useState, useCallback } from 'react';
import { ServiceTypeConfig } from '../../types';
import { useConfig } from '../../contexts/ConfigContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface ServiceTypeModalProps {
    isOpen: boolean;
    onClose: () => void;
    config?: ServiceTypeConfig;
}

const ServiceTypeModal: React.FC<ServiceTypeModalProps> = ({ isOpen, onClose, config }) => {
    const { addServiceType, updateServiceType } = useConfig();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('');
    const [color, setColor] = useState('#38bdf8');
    const [isActive, setIsActive] = useState(true);
    const [discordChannelId, setDiscordChannelId] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const isEditing = !!config;

    // Seed/reset the editable form when the modal opens or the edited config
    // changes while open. Adjusts state during render (React's documented
    // pattern) instead of in an effect; the controlled fields must stay
    // user-editable so they cannot be derived during render.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    const [prevConfig, setPrevConfig] = useState(config);
    if (isOpen !== prevIsOpen || config !== prevConfig) {
        setPrevIsOpen(isOpen);
        setPrevConfig(config);
        if (isOpen) {
            if (config) {
                setName(config.name);
                setDescription(config.description || '');
                setIcon(config.icon);
                setColor(config.color);
                setIsActive(config.isActive);
                setDiscordChannelId(config.discordChannelId || '');
            } else {
                setName('');
                setDescription('');
                setIcon('');
                setColor('#38bdf8');
                setIsActive(true);
                setDiscordChannelId('');
            }
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim() || !icon.trim()) return;

        setIsLoading(true);
        const data = {
            name: name.trim(),
            description: description.trim(),
            icon: icon.trim(),
            color,
            isActive,
            discordChannelId: discordChannelId.trim(),
        };

        try {
            if (isEditing && config) {
                await updateServiceType({ ...data, id: config.id });
            } else {
                await addServiceType(data);
            }
            onClose();
        } catch (err: any) {
            console.error("Failed to save service type:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: err?.message || "An error occurred while saving the service type. Please try again." });
            setIsLoading(false);
        }
    }, [name, description, icon, color, isActive, discordChannelId, isEditing, config, addServiceType, updateServiceType, onClose, addToast]);

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all disabled:opacity-50";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Service Type' : 'New Service Type'}
            subtitle="Mission Configuration"
            icon="fa-solid fa-list-check"
            color="sky"
            width="max-w-md"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    <div>
                        <label className={labelClass}>Type Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Transport, Mining, Bounty"
                            className={inputClass}
                            required
                            disabled={isLoading}
                        />
                        <p className="text-[9px] text-slate-500 mt-1">This will appear in dropdowns for clients and members.</p>
                    </div>

                    <div>
                        <label className={labelClass}>Icon & Color</label>
                        <div className="flex gap-3">
                            <div className="flex-1">
                                <input
                                    type="text"
                                    value={icon}
                                    onChange={(e) => setIcon(e.target.value)}
                                    placeholder="e.g. fa-solid fa-shuttle-space"
                                    className={`${inputClass} font-mono text-xs`}
                                    required
                                    disabled={isLoading}
                                />
                            </div>
                            <div className="w-12">
                                <input
                                    type="color"
                                    value={color}
                                    onChange={(e) => setColor(e.target.value)}
                                    className="w-full h-10 bg-transparent border-0 p-0 cursor-pointer"
                                    disabled={isLoading}
                                />
                            </div>
                            <div className="w-10 h-10 shrink-0 bg-slate-900 border border-slate-700 rounded-sm flex items-center justify-center">
                                <i className={`${icon} text-lg`} style={{ color }}></i>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            placeholder="Brief description of this service category..."
                            className={`${inputClass} resize-none`}
                            disabled={isLoading}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>
                            Discord Channel ID
                            <span className="text-slate-600 font-normal normal-case ml-2">(Optional)</span>
                        </label>
                        <input
                            type="text"
                            value={discordChannelId}
                            onChange={(e) => setDiscordChannelId(e.target.value)}
                            placeholder="e.g. 1234567890123456789"
                            pattern="^\d{17,19}$"
                            inputMode="numeric"
                            className={`${inputClass} font-mono text-xs`}
                            disabled={isLoading}
                        />
                        <p className="text-[9px] text-slate-500 mt-1">
                            Notifications for this service type post to this Discord channel. Leave empty to use the default channel from Discord Settings.
                        </p>
                    </div>

                    <div className="flex items-center space-x-3 pt-2">
                        <label className="flex items-center space-x-2 cursor-pointer group">
                            <input
                                type="checkbox"
                                checked={isActive}
                                onChange={(e) => setIsActive(e.target.checked)}
                                className="h-4 w-4 rounded-sm bg-slate-800 border-slate-600 text-sky-500 focus:ring-sky-500"
                                disabled={isLoading}
                            />
                            <span className="text-sm text-slate-300 font-bold group-hover:text-white">Active</span>
                        </label>
                        <span className="text-xs text-slate-500 italic">Inactive types are hidden from new request forms but visible in history.</span>
                    </div>
                </div>

                <div className="flex justify-end items-center p-6 bg-slate-900/50 border-t border-white/5 rounded-b-2xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Type')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default ServiceTypeModal;
