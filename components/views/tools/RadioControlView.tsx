
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useAuth } from '../../../contexts/AuthContext';

import { useRadio } from '../../../contexts/RadioContext';
import { ActiveRoom, RadioChannel } from '../../../types';
import RadioChannelModal from '../../modals/RadioChannelModal';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

// Moved outside to prevent re-definition on every re-render (which causes "flashing"/remounting)
const RackMountChannel: React.FC<{
    channel: RadioChannel,
    activeRooms: ActiveRoom[],
    currentChannel: RadioChannel | null,
    isConnected: boolean,
    canManage: boolean,
    dragOverChannelId: string | null,
    allChannels: RadioChannel[],
    activeSpeakers: string[],
    monitoredChannelId: string | null,
    onTuneIn: (channel: RadioChannel) => void,
    onEdit: (channel: RadioChannel) => void,
    onDelete: (id: string) => void,
    onSignal: (identity: string) => void,
    onTransfer: (identity: string, currentRoom: string, targetChannel: RadioChannel) => void,
    onDragStart: (e: React.DragEvent, identity: string, currentRoom: string) => void,
    onDragEnd: () => void,
    onDragOver: (e: React.DragEvent, channelId: string) => void,
    onDragLeave: (e: React.DragEvent) => void,
    onDrop: (e: React.DragEvent, targetChannel: RadioChannel) => void
}> = React.memo(({
    channel, activeRooms, currentChannel, isConnected, canManage, dragOverChannelId,
    allChannels, activeSpeakers, monitoredChannelId,
    onTuneIn, onEdit, onDelete, onSignal, onTransfer, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop
}) => {
    const [transferMenuOpen, setTransferMenuOpen] = useState<string | null>(null);

    // Look for matching room based on channel ID
    const activeRoom = activeRooms.find(r => r.roomName === `radio-${channel.id}`);
    const isActive = currentChannel?.id === channel.id && isConnected;
    const isDragTarget = dragOverChannelId === channel.id;
    // Use participant identities (User IDs) for logic, but names for display if available
    const participants = activeRoom?.participants || [];
    const participantNames = activeRoom?.participantNames || participants;

    const userCount = participants.length;

    // This channel is being monitored by the dispatcher — we can show live speaker data
    const isMonitored = monitoredChannelId === channel.id;

    // Determine type for styling (Unit, Request, or Static)
    const isUnit = channel.id.startsWith('unit-');
    const isRequest = channel.id.startsWith('req-');

    // Transfer targets: all channels except this one
    const transferTargets = allChannels.filter(c => c.id !== channel.id);

    return (
        <div
            className={`
                relative flex items-center justify-between p-3 rounded border-l-4 transition-colors duration-200 group mb-2
                ${isActive ? 'bg-slate-800 border-l-green-500 border-y border-r border-slate-700 shadow-[inset_0_0_20px_rgba(34,197,94,0.05)]' : 'bg-slate-900 border-l-slate-600 border-y border-r border-slate-800 hover:bg-slate-800/80'}
                ${isDragTarget ? 'ring-2 ring-sky-500 bg-sky-900/20' : ''}
            `}
            onDragOver={(e) => onDragOver(e, channel.id)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(e, channel)}
        >
            <div className="w-48 pl-2 flex flex-col justify-center border-r border-slate-700/50 pr-4">
                <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-slate-600'}`}></div>
                    <h3 className="font-bold text-white text-sm truncate uppercase tracking-tight" style={{ color: isActive ? '#fff' : channel.color }}>
                        {channel.name}
                    </h3>
                    {isMonitored && (
                        <span className="text-[8px] bg-green-500/15 text-green-400 border border-green-500/20 px-1 rounded-sm uppercase font-black tracking-wider">MON</span>
                    )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                    <code className="text-[10px] text-slate-500 font-mono tracking-wider">{channel.id}</code>
                    {isRequest && <span className="text-[9px] bg-red-900/30 text-red-500 border border-red-500/20 px-1 rounded-sm uppercase font-black">Active Op</span>}
                </div>
            </div>

            {/* Center: Participants (Drop Zone) */}
            <div className="flex-1 px-4 flex flex-wrap gap-2 items-center min-h-[40px]">
                {participants.length > 0 ? (
                    participants.map((identity, idx) => {
                        const displayName = participantNames[idx] || identity;
                        const isSpeaking = isMonitored && activeSpeakers.includes(displayName);

                        return (
                            <div
                                key={identity}
                                className="relative"
                            >
                                <div
                                    draggable={canManage}
                                    onDragStart={(e) => onDragStart(e, identity, activeRoom!.roomName)}
                                    onDragEnd={onDragEnd}
                                    className={`
                                        flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border rounded px-2 py-1 shadow-xs group/user select-none
                                        ${isSpeaking ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-600'}
                                        ${canManage ? 'cursor-grab active:cursor-grabbing' : ''}
                                    `}
                                >
                                    <div className={`w-1.5 h-1.5 rounded-full ${isSpeaking ? 'bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.8)]' : 'bg-green-400'}`}></div>
                                    <span className={`text-xs font-bold ${isSpeaking ? 'text-amber-200' : 'text-slate-200'}`}>{displayName}</span>

                                    <div className={`flex items-center gap-0.5 ml-1 transition-opacity ${canManage ? 'opacity-0 group-hover/user:opacity-100' : 'opacity-0'}`}>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onSignal(identity); }}
                                            className="text-slate-500 hover:text-amber-400 p-0.5"
                                            title="Signal Operator"
                                        >
                                            <i className="fa-solid fa-bell text-[10px]"></i>
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setTransferMenuOpen(transferMenuOpen === identity ? null : identity); }}
                                            className="text-slate-500 hover:text-sky-400 p-0.5"
                                            title="Transfer Operator"
                                        >
                                            <i className="fa-solid fa-arrow-right-arrow-left text-[10px]"></i>
                                        </button>
                                    </div>
                                </div>

                                {canManage && transferMenuOpen === identity && (
                                    <div className="absolute top-full left-0 mt-1 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-48 max-h-48 overflow-y-auto custom-scrollbar py-1">
                                        <p className="px-3 py-1 text-[9px] text-slate-500 uppercase font-black tracking-wider">Transfer to</p>
                                        {transferTargets.map(target => (
                                            <button
                                                key={target.id}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onTransfer(identity, activeRoom!.roomName, target);
                                                    setTransferMenuOpen(null);
                                                }}
                                                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white flex items-center gap-2 transition-colors"
                                            >
                                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: target.color }}></div>
                                                <span className="truncate font-bold uppercase">{target.name}</span>
                                            </button>
                                        ))}
                                        {transferTargets.length === 0 && (
                                            <p className="px-3 py-2 text-[10px] text-slate-600 italic">No other channels</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                ) : (
                    <span className="text-[10px] text-slate-700 uppercase font-bold tracking-widest opacity-50 select-none pointer-events-none">
                        {isDragTarget ? 'Drop to Transfer' : 'Frequency Clear'}
                    </span>
                )}
            </div>

            <div className="w-40 flex justify-end gap-1 border-l border-slate-700/50 pl-2 items-center">
                <span className="text-[10px] font-mono text-slate-600 mr-3">{userCount} USERS</span>
                <button
                    onClick={() => onTuneIn(channel)}
                    disabled={isActive}
                    className={`p-2 rounded-sm transition-colors ${isActive ? 'text-green-500 cursor-default' : 'text-slate-500 hover:text-white hover:bg-slate-700'}`}
                    title={isActive ? "Connected" : "Monitor Frequency"}
                >
                    <i className={`fa-solid ${isActive ? 'fa-headphones' : 'fa-right-to-bracket'}`}></i>
                </button>
                {canManage && !isUnit && !isRequest && (
                    <>
                        <button onClick={() => onEdit(channel)} className="p-2 text-slate-500 hover:text-sky-400 hover:bg-slate-700 rounded-sm transition-colors">
                            <i className="fa-solid fa-gear"></i>
                        </button>
                        <button onClick={() => onDelete(channel.id)} className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-700/20 rounded-sm transition-colors">
                            <i className="fa-solid fa-trash"></i>
                        </button>
                    </>
                )}
            </div>
        </div>
    );
});
RackMountChannel.displayName = 'RackMountChannel';

const ChannelGroup: React.FC<{
    title: string,
    icon: string,
    color: string,
    channels: RadioChannel[],
    activeRooms: ActiveRoom[],
    totalParticipants: number,
    defaultOpen?: boolean,
    children: React.ReactNode
}> = ({ title, icon, color, channels, activeRooms, totalParticipants, defaultOpen = true, children }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    if (channels.length === 0) return null;

    return (
        <div className="mb-4">
            <button
                onClick={() => setIsOpen(prev => !prev)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800/50 transition-colors group/header"
            >
                <i className={`fa-solid fa-chevron-${isOpen ? 'down' : 'right'} text-[10px] text-slate-600 w-3 transition-transform`}></i>
                <i className={`${icon} text-xs`} style={{ color }}></i>
                <span className="text-xs font-black uppercase tracking-wider text-slate-400">{title}</span>
                <span className="text-[10px] font-mono text-slate-600">{channels.length} CH</span>
                {totalParticipants > 0 && (
                    <span className="text-[10px] font-mono text-green-500">{totalParticipants} ONLINE</span>
                )}
            </button>
            {isOpen && (
                <div className="mt-1 ml-3">
                    {children}
                </div>
            )}
        </div>
    );
};

const RadioControlView: React.FC = () => {
    const { rpcAction } = useData();
    const { units = [] } = useMembers();
    const { radioChannels = [], deleteRadioChannel, radioConfig } = useConfig();
    const { hasPermission, currentUser } = useAuth();
    const { setChannel, currentChannel, isConnected, activeSpeakers } = useRadio();
    const { addToast, confirm } = useNotification();
    const { openIssueEamModal } = useModalRegistry();

    const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // Starts true: the mount effect kicks off a status fetch immediately, so the
    // refresh control is "in progress" from the first paint (the async fetch
    // clears it). This avoids a synchronous setState inside the mount effect.
    const [isRefreshing, setIsRefreshing] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [hideEmpty, setHideEmpty] = useState(false);

    // Drag & Drop State
    const [draggedUser, setDraggedUser] = useState<{ identity: string, currentRoom: string } | null>(null);
    const [dragOverChannelId, setDragOverChannelId] = useState<string | null>(null);

    // Broadcast Modal State
    const [isBroadcastModalOpen, setIsBroadcastModalOpen] = useState(false);
    const [broadcastMessage, setBroadcastMessage] = useState('');
    const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);

    // Reboot State
    const [isRebooting, setIsRebooting] = useState(false);

    // Channel Modal State
    const [isChannelModalOpen, setIsChannelModalOpen] = useState(false);
    const [editingChannel, setEditingChannel] = useState<RadioChannel | undefined>(undefined);

    // Core async load: performs the RPC and updates rooms/loading. Does NOT flip
    // the refreshing flag on entry, so the mount effect can call it without a
    // synchronous setState (isRefreshing already initialises to true).
    const loadStatus = useCallback(async () => {
        try {
            // Use RPC Action instead of GET fetch to handle auth
            const data = await rpcAction('radio:status', {});
            setActiveRooms(data.activeChannels || []);
        } catch (err: any) {
            console.error("Failed to fetch radio status:", err);
        } finally {
            setIsRefreshing(false);
            setIsLoading(false);
        }
    }, [rpcAction]);

    // Interactive/poll refresh: shows the spinner immediately, then loads.
    const fetchStatus = useCallback(async () => {
        setIsRefreshing(true);
        await loadStatus();
    }, [loadStatus]);

    useEffect(() => {
        // Mount: isRefreshing already starts true, so just run the async load.
        // All setState calls happen after the awaited RPC (never synchronously
        // in the effect body). Subsequent polls use fetchStatus, which flips the
        // spinner on each tick from inside the timer callback.
        const runInitialLoad = async () => { await loadStatus(); };
        void runInitialLoad();
        const interval = setInterval(fetchStatus, 15000); // Poll every 15s (reduces N+1 LiveKit API calls)
        return () => clearInterval(interval);
    }, [loadStatus, fetchStatus]);

    const unitChannels = useMemo<RadioChannel[]>(() => {
        return units
            .filter(unit => unit.hasRadioChannel !== false && !unit.linkedChannelId)
            .map(unit => ({
                id: `unit-${unit.id}`,
                name: `SQD-${unit.name.substring(0, 3).toUpperCase()}`,
                color: '#a3e635', // Lime
                isPreset: false,
                description: `Tactical channel for ${unit.name}`
            }));
    }, [units]);

    const allChannels = useMemo(() => {
        // Start with defined static channels
        let combined = [...radioChannels, ...unitChannels];

        // Add dynamic channels found in activeRooms (e.g. ad-hoc service requests)
        // These exist in LiveKit but don't have a DB entry
        const existingIds = new Set(combined.map(c => c.id));

        activeRooms.forEach(room => {
            const channelId = room.roomName.replace(/^radio-/, '');
            if (!existingIds.has(channelId)) {
                // Determine channel metadata based on ID pattern
                let name = channelId;
                let color = '#94a3b8'; // Default slate

                if (channelId.startsWith('req-')) {
                    name = `OPS-${channelId.split('-')[1]}`;
                    color = '#ef4444'; // Red for ops
                } else if (channelId.startsWith('unit-')) {
                    // Fallback for units not in DB context for some reason
                    name = `UNIT-${channelId.split('-')[1]}`;
                    color = '#a3e635';
                }

                combined.push({
                    id: channelId,
                    name: name,
                    color: color,
                    isPreset: false,
                    sortOrder: -1 // Show at top
                });
            }
        });

        if (searchTerm.trim()) {
            const lower = searchTerm.toLowerCase();
            combined = combined.filter(c => c.name.toLowerCase().includes(lower) || c.id.toLowerCase().includes(lower));
        }

        // Sort: Active Ops (req-) first, then sorted by sortOrder
        return combined.sort((a, b) => {
            const isReqA = a.id.startsWith('req-');
            const isReqB = b.id.startsWith('req-');

            if (isReqA && !isReqB) return -1;
            if (!isReqA && isReqB) return 1;

            return (a.sortOrder || 0) - (b.sortOrder || 0);
        });
    }, [radioChannels, unitChannels, activeRooms, searchTerm]);

    // Group channels by type
    const channelGroups = useMemo(() => {
        const getParticipantCount = (channels: RadioChannel[]) =>
            channels.reduce((sum, ch) => {
                const room = activeRooms.find(r => r.roomName === `radio-${ch.id}`);
                return sum + (room?.participantCount || 0);
            }, 0);

        const opsChannels = allChannels.filter(c => c.id.startsWith('req-'));
        const unitChs = allChannels.filter(c => c.id.startsWith('unit-'));
        const staticChannels = allChannels.filter(c => !c.id.startsWith('req-') && !c.id.startsWith('unit-'));

        return [
            { key: 'ops', title: 'Active Operations', icon: 'fa-solid fa-crosshairs', color: '#ef4444', channels: opsChannels, participants: getParticipantCount(opsChannels), defaultOpen: true },
            { key: 'unit', title: 'Unit Channels', icon: 'fa-solid fa-users', color: '#a3e635', channels: unitChs, participants: getParticipantCount(unitChs), defaultOpen: true },
            { key: 'static', title: 'Frequencies', icon: 'fa-solid fa-tower-broadcast', color: '#38bdf8', channels: staticChannels, participants: getParticipantCount(staticChannels), defaultOpen: true },
        ];
    }, [allChannels, activeRooms]);

    // Count hidden empty channels for the badge
    const emptyChannelCount = useMemo(() => {
        if (!hideEmpty) return 0;
        return allChannels.filter(ch => {
            const room = activeRooms.find(r => r.roomName === `radio-${ch.id}`);
            return !room || room.participantCount === 0;
        }).length;
    }, [hideEmpty, allChannels, activeRooms]);

    const canManage = hasPermission('radio:manage');

    // The channel the dispatcher is currently monitoring
    const monitoredChannelId = isConnected ? currentChannel?.id || null : null;

    const handleTuneIn = (channel: RadioChannel) => {
        setChannel(channel);
        addToast('Channel Tuned', <i className="fa-solid fa-headphones"></i>, 'bg-sky-500/10 text-sky-400 border-sky-500/50', { description: `Tuning into ${channel.name}.` });
    };

    const handleEdit = (channel: RadioChannel) => {
        setEditingChannel(channel);
        setIsChannelModalOpen(true);
    };

    const handleCreate = () => {
        setEditingChannel(undefined);
        setIsChannelModalOpen(true);
    };

    const handleDelete = async (id: string) => {
        const confirmed = await confirm({ title: 'Delete Frequency', message: 'Delete this frequency? This will disconnect all active users.', confirmText: 'Delete', variant: 'danger' });
        if (!confirmed) return;
        try {
            await deleteRadioChannel(id);
            addToast("Frequency Deleted", <i className="fa-solid fa-trash"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: "The radio frequency has been removed." });
        } catch {
            addToast("Delete Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to delete the radio channel." });
        }
    };

    const handleReboot = async () => {
        const confirmed = await confirm({ title: 'Reboot Network', message: "WARNING: This will forcibly close ALL active radio rooms and disconnect all users. This should only be used to fix 'ghost' sessions. Continue?", confirmText: 'Reboot', variant: 'danger' });
        if (!confirmed) return;

        setIsRebooting(true);
        try {
            const result = await rpcAction('radio:reboot', {});
            addToast('Network Rebooted', <i className="fa-solid fa-power-off"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: `${result.count} rooms cleared.` });
            setTimeout(fetchStatus, 1000);
        } catch (e: any) {
            console.error(e);
            addToast("Reboot Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: e.message || "Failed to reboot the network." });
        } finally {
            setIsRebooting(false);
        }
    };

    const handleSignalUser = async (identity: string, channel: RadioChannel) => {
        try {
            await rpcAction('broadcast:alert', {
                message: `[RADIO PING] ${currentUser?.name || 'Operator'} is signaling user ${identity} on ${channel.name}`
            });
            addToast('Ping Sent', <i className="fa-solid fa-signal"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: 'Radio ping has been transmitted.' });
        } catch (error) {
            console.error("Failed to send ping:", error);
            addToast("Ping Failed", <i className="fa-solid fa-triangle-exclamation"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: "Failed to transmit the radio ping." });
        }
    };

    const handleTransferUser = useCallback(async (identity: string, currentRoom: string, targetChannel: RadioChannel) => {
        const targetRoomName = `radio-${targetChannel.id}`;
        if (currentRoom === targetRoomName) return;

        addToast(
            'Transferring Operator',
            <i className="fa-solid fa-arrow-right-arrow-left"></i>,
            'bg-green-500/10 text-green-400 border-green-500/50',
            { description: `Moving to ${targetChannel.name}...` }
        );

        try {
            await rpcAction('user:set_radio_channel', {
                userId: parseInt(identity),
                channelName: targetRoomName
            });
            setTimeout(fetchStatus, 1000);
        } catch (err) {
            console.error("Failed to transfer user:", err);
            addToast("Transfer Failed", <i className="fa-solid fa-circle-exclamation"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: "Failed to move the operator." });
        }
    }, [rpcAction, addToast, fetchStatus]);

    const handleBroadcastAlert = async () => {
        if (!broadcastMessage.trim()) return;
        setIsSendingBroadcast(true);
        try {
            await rpcAction('broadcast:alert', { message: broadcastMessage.trim() });
            setBroadcastMessage('');
            setIsBroadcastModalOpen(false);
        } catch (e) {
            console.error(e);
            addToast("Broadcast Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to send the broadcast alert." });
        } finally {
            setIsSendingBroadcast(false);
        }
    };

    const handleDragStart = (e: React.DragEvent, identity: string, currentRoom: string) => {
        if (!canManage) return;
        setDraggedUser({ identity, currentRoom });
        e.dataTransfer.setData('text/plain', identity);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragEnd = () => {
        setDraggedUser(null);
        setDragOverChannelId(null);
    }

    const handleDragOver = (e: React.DragEvent, channelId: string) => {
        e.preventDefault();
        e.stopPropagation();

        if (draggedUser && draggedUser.currentRoom !== `radio-${channelId}`) {
            setDragOverChannelId(channelId);
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = async (e: React.DragEvent, targetChannel: RadioChannel) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOverChannelId(null);

        const targetRoomName = `radio-${targetChannel.id}`;

        if (draggedUser && draggedUser.currentRoom !== targetRoomName) {
            addToast(
                'Transferring Operator',
                <i className="fa-solid fa-arrow-right-arrow-left"></i>,
                'bg-green-500/10 text-green-400 border-green-500/50',
                { description: 'Moving operator to the target channel...' }
            );

            try {
                await rpcAction('user:set_radio_channel', {
                    userId: parseInt(draggedUser.identity),
                    channelName: targetRoomName
                });

                setTimeout(fetchStatus, 1000);

            } catch (err) {
                console.error("Failed to move user:", err);
                addToast("Transfer Failed", <i className="fa-solid fa-circle-exclamation"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: "Failed to move the operator to the target channel." });
            }
        }
        setDraggedUser(null);
    };

    const renderChannel = (channel: RadioChannel) => (
        <RackMountChannel
            key={channel.id}
            channel={channel}
            activeRooms={activeRooms}
            currentChannel={currentChannel}
            isConnected={isConnected}
            canManage={canManage}
            dragOverChannelId={dragOverChannelId}
            allChannels={allChannels}
            activeSpeakers={activeSpeakers}
            monitoredChannelId={monitoredChannelId}
            onTuneIn={handleTuneIn}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onSignal={(id) => handleSignalUser(id, channel)}
            onTransfer={handleTransferUser}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        />
    );

    const filterChannels = (channels: RadioChannel[]) => {
        if (!hideEmpty) return channels;
        return channels.filter(ch => {
            const room = activeRooms.find(r => r.roomName === `radio-${ch.id}`);
            return room && room.participantCount > 0;
        });
    };

    const totalOnline = useMemo(
        () => activeRooms.reduce((sum, r) => sum + (r.participantCount || 0), 0),
        [activeRooms]
    );
    const activeChannelsCount = useMemo(
        () => activeRooms.filter(r => (r.participantCount || 0) > 0).length,
        [activeRooms]
    );

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · RADIO CONTROL"
                chipIcon="fa-tower-broadcast"
                chipAccent="amber"
                title="Radio Control Center"
                subtitle="Spectrum monitoring and dispatch. Tune into channels, transfer operators, and broadcast alerts."
                actions={<>
                    <HeroActionButton onClick={() => setIsBroadcastModalOpen(true)} accent="amber" icon="fa-bullhorn">
                        Broadcast Alert
                    </HeroActionButton>
                    <HeroActionButton onClick={openIssueEamModal} accent="red" icon="fa-radiation">
                        Issue EAM
                    </HeroActionButton>
                    {canManage && (
                        <>
                            <HeroActionButton onClick={handleCreate} accent="amber" icon="fa-plus">
                                New Freq
                            </HeroActionButton>
                            <HeroActionButton
                                onClick={handleReboot}
                                disabled={isRebooting}
                                accent="slate"
                                icon={isRebooting ? 'fa-spinner animate-spin' : 'fa-power-off'}
                                title="Force disconnect all users and clear rooms"
                            >
                                Reboot Net
                            </HeroActionButton>
                        </>
                    )}
                </>}
                stats={<>
                    <HeroStat icon="fa-tower-broadcast" label="Channels" value={allChannels.length} accent="amber" />
                    <HeroStat icon="fa-bolt" label="Active" value={activeChannelsCount} accent="emerald" emphasize={activeChannelsCount > 0} />
                    <HeroStat icon="fa-users" label="Operators Online" value={totalOnline} accent="cyan" emphasize={totalOnline > 0} />
                    <HeroStat icon="fa-headphones" label="Monitoring" value={monitoredChannelId ? (currentChannel?.name || 'Tuned') : 'Off'} accent={monitoredChannelId ? 'emerald' : 'slate'} emphasize={!!monitoredChannelId} />
                </>}
            />

            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
                {!radioConfig.configured && (
                    <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-3 flex items-center gap-3">
                        <i className="fa-solid fa-triangle-exclamation text-amber-400"></i>
                        <p className="text-xs text-slate-400">
                            <strong className="text-amber-300">LiveKit Not Configured</strong> — Live comms data is unavailable. Set the LIVEKIT_* credentials in your server's .env file to enable real-time radio monitoring.
                        </p>
                    </div>
                )}

                <div className="flex gap-2">
                    <div className="relative flex-1 max-w-2xl">
                        <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                        <input
                            type="search"
                            placeholder="Filter frequencies, channel IDs, or call signs…"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-slate-900/60 text-white pl-12 pr-10 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-amber-500/50 focus:border-amber-500/40 transition-all"
                        />
                        <button onClick={fetchStatus} disabled={isRefreshing} className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-amber-300 transition-colors" title="Refresh">
                            <i className={`fa-solid fa-rotate ${isRefreshing ? 'animate-spin' : ''}`}></i>
                        </button>
                    </div>
                    <button
                        onClick={() => setHideEmpty(prev => !prev)}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap ${
                            hideEmpty
                                ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                                : 'bg-slate-900/60 text-slate-500 border-slate-700 hover:text-slate-300'
                        }`}
                        title={hideEmpty ? 'Show all channels' : 'Hide empty channels'}
                    >
                        <i className={`fa-solid ${hideEmpty ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                        <span className="hidden md:inline">{hideEmpty ? 'Empty Hidden' : 'Show All'}</span>
                    </button>
                </div>

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center h-64 opacity-60">
                        <i className="fa-solid fa-circle-notch animate-spin text-4xl text-amber-400 mb-4"></i>
                        <p className="text-[10px] uppercase tracking-widest font-black text-amber-300">Scanning Spectrum...</p>
                    </div>
                ) : (
                    <div>
                        {channelGroups.map(group => {
                            const filtered = filterChannels(group.channels);
                            if (filtered.length === 0 && hideEmpty) return null;

                            return (
                                <ChannelGroup
                                    key={group.key}
                                    title={group.title}
                                    icon={group.icon}
                                    color={group.color}
                                    channels={filtered}
                                    activeRooms={activeRooms}
                                    totalParticipants={group.participants}
                                    defaultOpen={group.defaultOpen}
                                >
                                    {filtered.map(channel => renderChannel(channel))}
                                </ChannelGroup>
                            );
                        })}

                        {allChannels.length === 0 && !hideEmpty && (
                            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                                <EmptyState
                                    icon="fa-tower-broadcast"
                                    accent="amber"
                                    heading="No frequencies found"
                                    description={searchTerm ? 'Try a different search term or clear the filter.' : 'No radio channels are configured yet.'}
                                />
                            </div>
                        )}

                        {hideEmpty && emptyChannelCount > 0 && (
                            <div className="text-center py-3">
                                <button
                                    onClick={() => setHideEmpty(false)}
                                    className="text-[10px] text-slate-600 hover:text-amber-300 uppercase font-black tracking-widest transition-colors"
                                >
                                    {emptyChannelCount} empty {emptyChannelCount === 1 ? 'channel' : 'channels'} hidden
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {isBroadcastModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-200 animate-fade-in p-4">
                    <div className="bg-slate-900 border border-amber-500 rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
                        <div className="bg-amber-900/20 p-5 border-b border-amber-500/30 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-amber-500/20 rounded-full flex items-center justify-center text-amber-500">
                                    <i className="fa-solid fa-bullhorn text-lg"></i>
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-white uppercase tracking-tight">Broadcast Alert</h2>
                                    <p className="text-[10px] text-amber-400 font-mono uppercase tracking-wide">All Channels</p>
                                </div>
                            </div>
                            <button onClick={() => setIsBroadcastModalOpen(false)} className="text-slate-400 hover:text-white"><i className="fa-solid fa-xmark text-lg"></i></button>
                        </div>
                        <div className="p-6">
                            <p className="text-xs text-slate-400 mb-4">
                                Send a priority notification to all active terminals. This will appear as a popup message (Toast) for all connected users.
                            </p>
                            <label className="block text-[10px] text-slate-500 uppercase font-black mb-2 tracking-widest">Message</label>
                            <textarea
                                value={broadcastMessage}
                                onChange={(e) => setBroadcastMessage(e.target.value)}
                                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-white text-sm focus:border-amber-500/40 focus:ring-1 focus:ring-amber-500/30 outline-hidden h-24 resize-none transition-all"
                                placeholder="e.g. Squad Leaders report to Command."
                                autoFocus
                            />
                        </div>
                        <div className="p-4 bg-slate-950/60 border-t border-white/5 flex justify-end gap-3 rounded-b-xl">
                            <button onClick={() => setIsBroadcastModalOpen(false)} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors">Cancel</button>
                            <button
                                onClick={handleBroadcastAlert}
                                disabled={isSendingBroadcast || !broadcastMessage.trim()}
                                className="flex items-center gap-2 px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white border border-amber-500/40 rounded-lg text-xs font-bold uppercase tracking-widest shadow-lg shadow-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                {isSendingBroadcast ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-paper-plane"></i>}
                                Send
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <RadioChannelModal
                isOpen={isChannelModalOpen}
                onClose={() => { setIsChannelModalOpen(false); setEditingChannel(undefined); }}
                channel={editingChannel}
                onSuccess={() => { fetchStatus(); }}
            />
        </div>
    );
};

export default RadioControlView;
