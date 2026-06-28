
import React, { useState } from 'react';
import { useData } from '../../contexts/DataContext';

import { RadioChannel } from '../../types';
import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface RadioChannelModalProps {
    isOpen: boolean;
    onClose: () => void;
    channel?: RadioChannel;
    onSuccess?: () => void;
}

const RadioChannelModal: React.FC<RadioChannelModalProps> = ({ isOpen, onClose, channel, onSuccess }) => {
    const { rpcAction } = useData();
    const { addToast } = useNotification();
    const [id, setId] = useState('');
    const [name, setName] = useState('');
    const [color, setColor] = useState('#38bdf8');
    const [isLoading, setIsLoading] = useState(false);

    const isEditing = !!channel;

    // Reset/seed the user-editable form fields when the dialog opens or the
    // selected channel changes while open. Done during render via the React
    // "adjust state during render" pattern (re-renders before paint), which is
    // behaviour-equivalent to the previous open/selection-change reset effect.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    const [prevChannel, setPrevChannel] = useState(channel);
    if (isOpen && (isOpen !== prevIsOpen || channel !== prevChannel)) {
        setPrevIsOpen(isOpen);
        setPrevChannel(channel);
        if (channel) {
            setId(channel.id);
            setName(channel.name);
            setColor(channel.color);
        } else {
            setId('');
            setName('');
            setColor('#38bdf8');
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || channel !== prevChannel) {
        setPrevIsOpen(isOpen);
        setPrevChannel(channel);
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!id.trim() || !name.trim()) return;

        setIsLoading(true);
        try {
            if (isEditing) {
                await rpcAction('admin:update_radio_channel', { id, name, color });
            } else {
                await rpcAction('admin:add_radio_channel', {
                    id: id.trim().toLowerCase().replace(/[^a-z0-9]/g, '-'),
                    name,
                    color,
                    type: 'public'
                });
            }
            if (onSuccess) onSuccess();
            onClose();
        } catch (error) {
            console.error(error);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save channel. Please try again." });
        } finally {
            setIsLoading(false);
        }
    };

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all disabled:opacity-50";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Frequency' : 'New Frequency'}
            subtitle="Signal Configuration"
            icon="fa-solid fa-tower-broadcast"
            color="sky"
            width="max-w-md"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    <div>
                        <label className={labelClass}>Channel ID</label>
                        <input
                            type="text"
                            value={id}
                            onChange={(e) => setId(e.target.value)}
                            className={`${inputClass} font-mono`}
                            placeholder="e.g. tac-1"
                            disabled={isEditing || isLoading}
                            required
                        />
                        {!isEditing && <p className="text-[10px] text-slate-600 mt-1 italic">Unique identifier (slug), lower case, no spaces.</p>}
                    </div>

                    <div>
                        <label className={labelClass}>Display Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={inputClass}
                            placeholder="e.g. Tactical One"
                            disabled={isLoading}
                            required
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Signal Color</label>
                        <div className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-lg p-2">
                            <input
                                type="color"
                                value={color}
                                onChange={(e) => setColor(e.target.value)}
                                className="w-8 h-8 bg-transparent border-none cursor-pointer"
                                disabled={isLoading}
                            />
                            <span className="text-sm font-mono text-slate-400 uppercase">{color}</span>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end items-center p-6 bg-slate-900/50 border-t border-white/5 rounded-b-2xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Frequency'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default RadioChannelModal;
