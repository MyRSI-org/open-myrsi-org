
import React, { useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useConfig } from '../../../contexts/ConfigContext';

import { RadioChannel, RadioConfig } from '../../../types';
import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const RadioSettingsTab: React.FC = () => {
    const { rpcAction } = useData();
    const { radioConfig, updateRadioConfig, radioChannels = [], deleteRadioChannel } = useConfig();
    const { confirm, addToast } = useNotification();
    const [config, setConfig] = useState<RadioConfig>(radioConfig);
    const [isSavingConfig, setIsSavingConfig] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    // New Channel Form State
    const [newId, setNewId] = useState('');
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState('#38bdf8');

    // Drag State. Seed the local draggable list from the canonical channels on mount —
    // the old sync effect seeded it on first run; lazy-initialising here yields the same
    // sorted list with no transient empty render.
    const [localChannels, setLocalChannels] = useState<RadioChannel[]>(
        () => [...radioChannels].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    );
    const [draggedChannel, setDraggedChannel] = useState<RadioChannel | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null);
    const [isReordering, setIsReordering] = useState(false);

    // Re-seed the local editable form when the canonical config from context changes (e.g.
    // after a save). config is user-editable local state, so it cannot be derived during
    // render without discarding in-progress edits. Uses the React "adjust state during
    // render" pattern (previous-value tracker) instead of an effect: it runs during render
    // and React re-renders before paint, so it is behaviour-equivalent to the old re-sync
    // effect with no extra paint.
    const [prevRadioConfig, setPrevRadioConfig] = useState(radioConfig);
    if (radioConfig !== prevRadioConfig) {
        setPrevRadioConfig(radioConfig);
        setConfig(radioConfig);
    }

    // Sync the local draggable channel list with global state initially and whenever the
    // external list changes while not actively reordering. localChannels is mutated locally
    // during drag reordering, so overwriting it mid-drag would discard the user's in-progress
    // order — hence the !isReordering guard, preserved exactly.
    //
    // This faithfully reproduces the old effect, whose deps were [radioChannels, isReordering]:
    // it re-seeded both when radioChannels changed (while not reordering) AND when reordering
    // ended (isReordering true→false), re-syncing to the server-confirmed order. Two render-time
    // trackers reproduce both triggers. prevRadioChannels is advanced only when we actually
    // re-seed, so a radioChannels change that arrives mid-reorder stays pending and is applied
    // the moment reordering ends — exactly as the effect did.
    const [prevRadioChannels, setPrevRadioChannels] = useState(radioChannels);
    const [prevIsReordering, setPrevIsReordering] = useState(isReordering);
    const radioChannelsChanged = radioChannels !== prevRadioChannels;
    const isReorderingChanged = isReordering !== prevIsReordering;
    if (radioChannelsChanged || isReorderingChanged) {
        if (isReorderingChanged) setPrevIsReordering(isReordering);
        if (!isReordering) {
            setPrevRadioChannels(radioChannels);
            setLocalChannels([...radioChannels].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)));
        }
    }

    const handleUpdateConfig = async () => {
        setIsSavingConfig(true);
        try {
            await updateRadioConfig(config);
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save radio configuration settings." });
        } finally {
            setIsSavingConfig(false);
        }
    };

    const handleUpdateChannel = async (id: string, name: string, color: string) => {
        try {
            await rpcAction('admin:update_radio_channel', { id, name, color });
        } catch (err) {
            console.error(err);
            addToast("Update Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to update the radio channel." });
        }
    };

    const handleAddChannel = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newId.trim() || !newName.trim()) return;

        setIsAdding(true);
        try {
            const maxOrder = localChannels.reduce((max, c) => Math.max(max, c.sortOrder || 0), 0);

            const channelData = {
                id: newId.trim().toLowerCase().replace(/[^a-z0-9]/g, '-'),
                name: newName.trim(),
                color: newColor,
                type: 'public',
                sort_order: maxOrder + 10
            };

            const newChannel = await rpcAction('admin:add_radio_channel', channelData);

            // Optimistically add to local state
            const createdChannel: RadioChannel = {
                id: newChannel?.id || channelData.id,
                name: channelData.name,
                color: channelData.color,
                type: channelData.type,
                sortOrder: channelData.sort_order,
                isPreset: false
            };
            setLocalChannels(prev => [...prev, createdChannel].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)));

            setNewId('');
            setNewName('');
            setNewColor('#38bdf8');
        } catch (err: any) {
            console.error(err);
            addToast("Add Channel Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: `Could not create the radio channel: ${err.message}` });
        } finally {
            setIsAdding(false);
        }
    };

    const handleDeleteChannel = async (id: string, name: string) => {
        const confirmed = await confirm({
            title: 'Delete Radio Channel',
            message: `Are you sure you want to permanently delete the radio frequency "${name}"?`,
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;

        setDeletingId(id);
        try {
            await deleteRadioChannel(id);
        } catch (err) {
            console.error(err);
            addToast("Delete Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to delete the radio channel." });
        } finally {
            setDeletingId(null);
        }
    };

    // --- Drag & Drop ---

    const handleDragStart = (e: React.DragEvent, channel: RadioChannel) => {
        setDraggedChannel(channel);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', channel.id);
    };

    const handleDragOver = (e: React.DragEvent, targetChannel: RadioChannel) => {
        if (!draggedChannel || draggedChannel.id === targetChannel.id) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = e.currentTarget.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const height = rect.height;

        setDropTargetId(targetChannel.id);
        setDropPosition(y < height / 2 ? 'before' : 'after');
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDrop = async (e: React.DragEvent, targetChannel: RadioChannel) => {
        e.preventDefault();
        e.stopPropagation();

        if (!draggedChannel || !dropTargetId || !dropPosition) {
            setDropTargetId(null);
            return;
        }

        const sourceIndex = localChannels.findIndex(c => c.id === draggedChannel.id);
        const targetIndex = localChannels.findIndex(c => c.id === targetChannel.id);

        if (sourceIndex === targetIndex) return;

        const newOrder = [...localChannels];
        const [movedItem] = newOrder.splice(sourceIndex, 1);

        // Re-find the target index in the spliced array since it may have shifted.
        let insertionIndex = newOrder.findIndex(c => c.id === targetChannel.id);
        if (dropPosition === 'after') insertionIndex += 1;

        newOrder.splice(insertionIndex, 0, movedItem);

        setLocalChannels(newOrder);
        setIsReordering(true);
        setDraggedChannel(null);
        setDropTargetId(null);
        setDropPosition(null);

        try {
            await Promise.all(newOrder.map((ch, index) =>
                rpcAction('admin:update_radio_channel', {
                    id: ch.id,
                    name: ch.name,
                    color: ch.color,
                    sort_order: (index + 1) * 10
                })
            ));
        } catch (err) {
            console.error("Failed to reorder", err);
        } finally {
            setIsReordering(false);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Radio Frequencies"
                icon="fa-solid fa-tower-cell"
                accent="amber"
                subtitle="Configure voice radio channels and LiveKit room mappings."
            />

            {!radioConfig.configured && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 flex items-start gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5"></i>
                    <div>
                        <p className="text-sm font-bold text-amber-400">LiveKit Not Configured</p>
                        <p className="text-xs text-slate-400 mt-1">
                            Voice radio requires LiveKit API credentials. Set <strong className="text-slate-300">LIVEKIT_API_KEY</strong>, <strong className="text-slate-300">LIVEKIT_API_SECRET</strong>, and <strong className="text-slate-300">LIVEKIT_URL</strong> in your server's <strong className="text-slate-300">.env</strong> file. Until configured, radio frequencies below will not be functional.
                        </p>
                    </div>
                </div>
            )}

            {/* System Config */}
            <div className="bg-slate-900/50 rounded-lg p-6 border border-slate-700/50">
                <h2 className="text-xl text-white flex items-center mb-4">
                    <i className="fa-solid fa-walkie-talkie h-6 w-6 mr-3 text-slate-400"></i>
                    Radio System Configuration
                </h2>
                <p className="text-sm text-slate-400 mb-6">Manage default boot frequencies and global comms settings.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label htmlFor="channelName" className="block text-sm font-medium text-slate-300 mb-2">Default Boot Frequency ID</label>
                        <select
                            id="channelName"
                            value={config.channelName}
                            onChange={(e) => setConfig(prev => ({ ...prev, channelName: e.target.value }))}
                            className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono"
                        >
                            <option value="">- Select Default -</option>
                            {localChannels.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
                        </select>
                        <p className="text-xs text-slate-500 mt-1">New users will tune to this frequency on power-up.</p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Push-to-Talk Key</label>
                        <div className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-slate-400 font-mono text-sm cursor-not-allowed">
                            Right Control
                        </div>
                    </div>
                </div>

                <div className="mt-6 flex justify-end">
                    <button onClick={handleUpdateConfig} disabled={isSavingConfig || isSaved} className={`px-6 py-2 text-sm font-semibold text-white rounded-md border border-slate-600 transition-colors w-32 text-center ${isSavingConfig ? 'bg-slate-800 cursor-wait' : isSaved ? 'bg-green-600 border-green-500' : 'bg-slate-700 hover:bg-slate-600'}`}>
                        {isSavingConfig ? <i className="fa-solid fa-spinner animate-spin" /> : isSaved ? 'Saved!' : 'Save Config'}
                    </button>
                </div>
            </div>

            {/* Frequency Management */}
            <div className={`bg-slate-900/50 rounded-lg p-6 border border-slate-700/50`}>
                <h2 className="text-xl text-white flex items-center mb-4">
                    <i className="fa-solid fa-tower-broadcast h-6 w-6 mr-3 text-slate-400"></i>
                    Frequency Matrix
                </h2>
                <p className="text-sm text-slate-400 mb-6">Manage preset tactical frequencies. Drag rows to reorder.</p>

                {/* Create New Channel Form */}
                <form onSubmit={handleAddChannel} className="bg-slate-800/40 border border-slate-700 p-4 rounded-lg mb-6 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                    <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-black mb-1">New Channel ID</label>
                        <input
                            type="text"
                            placeholder="e.g. tac-1"
                            value={newId}
                            onChange={(e) => setNewId(e.target.value)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-sm px-3 py-2 text-white text-sm outline-hidden focus:ring-1 focus:ring-slate-400/50"
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] text-slate-500 uppercase font-black mb-1">Display Name</label>
                        <input
                            type="text"
                            placeholder="e.g. Tactical One"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-sm px-3 py-2 text-white text-sm outline-hidden focus:ring-1 focus:ring-slate-400/50"
                            required
                        />
                    </div>
                    <div className="flex space-x-2">
                        <div className="flex-1">
                            <label className="block text-[10px] text-slate-500 uppercase font-black mb-1">Color</label>
                            <div className="flex items-center space-x-2 bg-slate-800 border border-slate-700 rounded-sm px-2 py-1">
                                <input
                                    type="color"
                                    value={newColor}
                                    onChange={(e) => setNewColor(e.target.value)}
                                    className="w-8 h-8 bg-transparent border-none p-0 cursor-pointer"
                                />
                                <span className="text-xs font-mono text-slate-400 uppercase">{newColor}</span>
                            </div>
                        </div>
                    </div>
                    <button
                        type="submit"
                        disabled={isAdding}
                        className="w-full bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white font-bold py-2 rounded-sm transition-colors disabled:opacity-50"
                    >
                        {isAdding ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Add Channel'}
                    </button>
                </form>

                <div className="space-y-3">
                    {localChannels.map(channel => {
                        const isDragging = draggedChannel?.id === channel.id;
                        const isTarget = dropTargetId === channel.id;

                        return (
                            <div
                                key={channel.id}
                                className={`
                                    relative grid grid-cols-1 md:grid-cols-4 gap-4 items-center bg-slate-800/40 p-4 rounded-lg border 
                                    transition-all group 
                                    ${isDragging ? 'bg-slate-900 opacity-40' : 'hover:border-slate-700/50'}
                                    ${isTarget ? 'border-slate-400/50 bg-slate-800/30' : 'border-transparent'}
                                `}
                                draggable
                                onDragStart={(e) => handleDragStart(e, channel)}
                                onDragOver={(e) => handleDragOver(e, channel)}
                                onDrop={(e) => handleDrop(e, channel)}
                            >
                                {/* Drop Indicators */}
                                {isTarget && dropPosition === 'before' && <div className="absolute top-0 left-0 right-0 h-1 bg-slate-300 z-10"></div>}
                                {isTarget && dropPosition === 'after' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-300 z-10"></div>}

                                <div className="flex flex-col relative pl-6">
                                    <div className="absolute left-0 top-1/2 -translate-y-1/2 text-slate-600 cursor-grab active:cursor-grabbing hover:text-slate-400">
                                        <i className="fa-solid fa-grip-vertical"></i>
                                    </div>
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">ID / Slug</label>
                                    <code className="bg-black/30 px-2 py-1 rounded-sm text-slate-300 text-xs w-fit">{channel.id}</code>
                                </div>
                                <div>
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Display Name</label>
                                    <input
                                        type="text"
                                        defaultValue={channel.name}
                                        onBlur={(e) => {
                                            if (e.target.value !== channel.name) {
                                                handleUpdateChannel(channel.id, e.target.value, channel.color);
                                            }
                                        }}
                                        className="w-full bg-slate-700/50 border border-slate-600 rounded-sm px-3 py-1.5 text-white text-sm focus:ring-1 focus:ring-slate-400/50 outline-hidden"
                                    />
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="w-32">
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Color</label>
                                        <input
                                            type="color"
                                            defaultValue={channel.color}
                                            onChange={(e) => handleUpdateChannel(channel.id, channel.name, e.target.value)}
                                            className="w-full h-8 bg-transparent border-none p-0 cursor-pointer"
                                        />
                                    </div>
                                    <div className="text-right flex flex-col items-end">
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Type</label>
                                        <span className={`text-[9px] px-2 py-0.5 rounded-sm uppercase font-black ${channel.isPreset ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30' : 'bg-slate-700 text-slate-400'}`}>
                                            {channel.isPreset ? 'System Preset' : 'Custom'}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex justify-end pt-2 md:pt-0">
                                    <button
                                        onClick={() => handleDeleteChannel(channel.id, channel.name)}
                                        disabled={deletingId === channel.id || channel.isPreset}
                                        className={`p-2 rounded-md transition-colors ${channel.isPreset ? 'text-slate-600 cursor-not-allowed' : 'text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100'}`}
                                        title={channel.isPreset ? "System presets cannot be deleted" : "Delete frequency"}
                                    >
                                        {deletingId === channel.id ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-trash-can"></i>}
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                    {localChannels.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-lg">
                            <i className="fa-solid fa-tower-cell text-4xl text-slate-700 mb-2"></i>
                            <p className="text-slate-500 italic text-sm">No radio frequencies configured.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RadioSettingsTab;
