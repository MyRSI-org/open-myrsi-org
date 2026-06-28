import React, { useCallback, useEffect, useState } from 'react';
import { HydratedOperation, OperationStatus, OperationType, AlliancePeer } from '../../../../types';
import { useAuth } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';
import { useMembers } from '../../../../contexts/MembersContext';
import { useConfig } from '../../../../contexts/ConfigContext';
import { useOperations } from '../../../../contexts/OperationsContext';

import { toLocalDatetimeValue, formatOpDateTimeWithZone } from '../../../../lib/time';
import { useNotification } from '../../../../contexts/NotificationContext';

interface OpAdministerTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    onRefresh: () => void;
    onDeleteOperation: () => void;
    isDeleting?: boolean;
    loadingAction?: string | null;
    onAction?: (action: () => Promise<void>, actionName: string) => Promise<void>;
}

const OpAdministerTab: React.FC<OpAdministerTabProps> = ({ operation, canManage, onRefresh, onDeleteOperation, isDeleting, loadingAction, onAction }) => {
    const { hasPermission } = useAuth();
    const { rpcAction } = useData();
    const { securityClearances, limitingMarkers, units } = useMembers();
    const { locations, discordConfig } = useConfig();
    const {
        updateOperationDetails, updateOperationStatus,
        extractTemplateFromOperation, createOperationTemplate, operationTemplates,
    } = useOperations();
    const { addToast, confirm } = useNotification();

    // Discord announcement (re)post. First post shows the org default channel + a guild-channel
    // dropdown; once posted, the same controls edit in place (preserves reactions) or change
    // channels (delete + post fresh).
    const [discordChannels, setDiscordChannels] = useState<{ id: string; name: string; type: number }[]>([]);
    const [discordChannelsLoading, setDiscordChannelsLoading] = useState(false);
    const [discordChannelsError, setDiscordChannelsError] = useState<string | null>(null);
    const [pickerChannelId, setPickerChannelId] = useState<string>('');
    const [reposting, setReposting] = useState(false);

    const loadDiscordChannels = useCallback(async (forceRefresh = false) => {
        setDiscordChannelsLoading(true);
        setDiscordChannelsError(null);
        try {
            const result = await rpcAction('discord:list_guild_channels', { forceRefresh });
            const filtered = (result?.channels || []).filter((c: any) => c.type === 0 || c.type === 5);
            setDiscordChannels(filtered);
            setDiscordChannelsError(result?.error || null);
        } catch (err: any) {
            setDiscordChannels([]);
            setDiscordChannelsError(err?.message || 'Failed to load Discord channels.');
        } finally {
            setDiscordChannelsLoading(false);
        }
    }, [rpcAction]);

    // Pre-select the existing channel, falling back to the org default. This is a
    // one-time seed of a user-editable dropdown: once pickerChannelId is set
    // (by this seed or a later user click) it is never re-seeded. We do it during
    // render with a previous-value tracker (the React-documented "adjust state
    // during render" pattern) instead of an effect — React re-renders before
    // paint so it is behaviour-equivalent, and the `!pickerChannelId` guard keeps
    // it from clobbering the operator's choice if the stored/default channel
    // arrives or changes asynchronously after they pick. The null sentinel makes
    // the first render seed too, matching the old effect that ran once on mount.
    const existingPickerChannelId = operation.discordAnnouncementChannelId
        || discordConfig?.defaultOperationAnnounceChannelId
        || '';
    const [prevExistingPickerChannelId, setPrevExistingPickerChannelId] = useState<string | null>(null);
    if (existingPickerChannelId !== prevExistingPickerChannelId) {
        setPrevExistingPickerChannelId(existingPickerChannelId);
        if (!pickerChannelId && existingPickerChannelId) setPickerChannelId(existingPickerChannelId);
    }

    const handleRepostAnnouncement = useCallback(async () => {
        if (!pickerChannelId) {
            addToast('Pick a channel', <i className="fa-solid fa-triangle-exclamation"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: 'Choose a Discord channel before posting.' });
            return;
        }
        setReposting(true);
        try {
            const result = await rpcAction('operation:repost_announcement', { operationId: operation.id, channelId: pickerChannelId });
            if (result?.ok) {
                addToast(
                    result.mode === 'edited' ? 'Announcement Updated' : 'Announcement Posted',
                    <i className="fa-brands fa-discord"></i>,
                    'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                    { description: result.mode === 'edited' ? 'Existing message edited in place.' : 'Embed posted to Discord.' },
                );
                onRefresh();
            } else {
                addToast('Post Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: result?.error || 'Discord did not accept the post.' });
            }
        } catch (err: any) {
            addToast('Post Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'Could not reach the server.' });
        } finally {
            setReposting(false);
        }
    }, [rpcAction, operation.id, pickerChannelId, addToast, onRefresh]);

    // Resolve the template-of-origin name (if any) from the cached templates list.
    // Falls back silently if the template was deleted (FK is ON DELETE SET NULL).
    const sourceTemplate = operation.templateId
        ? operationTemplates.find(t => t.id === operation.templateId)
        : null;

    // "Save as Template" — extracts phases/tasks/milestones from this op and
    // creates a reusable per-org template. Defaults the template name to the op
    // name so users can confirm/rename in a single prompt.
    const [savingTemplate, setSavingTemplate] = useState(false);
    const handleSaveAsTemplate = async () => {
        const defaultName = operation.name;
        const name = window.prompt('Save current phases, tasks, and milestones as a template. Template name:', defaultName);
        if (!name || !name.trim()) return;
        setSavingTemplate(true);
        try {
            const payload = await extractTemplateFromOperation(operation.id);
            if (!payload?.phases?.length) {
                addToast(
                    'Nothing to save',
                    <i className="fa-solid fa-triangle-exclamation"></i>,
                    'bg-amber-500/10 text-amber-400 border-amber-500/50',
                    { description: 'This operation has no phases, tasks, or milestones to template.' }
                );
                return;
            }
            await createOperationTemplate({ name: name.trim(), payload, sourceOperationId: operation.id });
            addToast('Template saved', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/30');
        } catch (err: any) {
            addToast(
                'Save Failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not save template.' }
            );
        } finally {
            setSavingTemplate(false);
        }
    };

    const [isEditing, setIsEditing] = useState(false);
    const [editName, setEditName] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editType, setEditType] = useState<OperationType>(OperationType.NonCombat);
    const [editStatus, setEditStatus] = useState<OperationStatus>(OperationStatus.Planning);
    const [editMaxParticipants, setEditMaxParticipants] = useState<number | ''>('');
    const [editScheduledStart, setEditScheduledStart] = useState('');
    const [editScheduledEnd, setEditScheduledEnd] = useState('');
    const [editClearanceLevel, setEditClearanceLevel] = useState('0');
    const [editMarkers, setEditMarkers] = useState<Set<number>>(() => new Set());
    const [editIsSpecial, setEditIsSpecial] = useState(false);
    const [editJoinCode, setEditJoinCode] = useState('');
    const [editIsJoint, setEditIsJoint] = useState(false);
    const [editIsTraining, setEditIsTraining] = useState(false);
    const [editTracksUec, setEditTracksUec] = useState(false);
    const [editUnitId, setEditUnitId] = useState('');
    const [editLocationId, setEditLocationId] = useState('');
    const [saving, setSaving] = useState(false);

    // Joint ops: invite ally (peer-keyed).
    const [invitePeerId, setInvitePeerId] = useState('');
    const [invitingAlly, setInvitingAlly] = useState(false);
    const [eligiblePeers, setEligiblePeers] = useState<{ id: string; label: string; peerOrgName?: string | null }[]>([]);

    useEffect(() => {
        if (!operation.isJoint || !hasPermission('operations:manage')) return;
        let cancelled = false;
        rpcAction('alliance:list_peers', {}).then((peers: AlliancePeer[]) => {
            if (cancelled) return;
            setEligiblePeers((peers || [])
                .filter(p => p.status === 'Active' && p.channels?.operations === true)
                .map(p => ({ id: p.id, label: p.label, peerOrgName: p.peerOrgName })));
        }).catch(() => { if (!cancelled) setEligiblePeers([]); });
        return () => { cancelled = true; };
    }, [operation.isJoint, rpcAction, hasPermission]);

    const startEdit = () => {
        setEditName(operation.name);
        setEditDescription(operation.description || '');
        setEditType(operation.type);
        setEditStatus(operation.status);
        setEditMaxParticipants(operation.maxParticipants || '');
        setEditScheduledStart(toLocalDatetimeValue(operation.scheduledStart));
        setEditScheduledEnd(toLocalDatetimeValue(operation.scheduledEnd));
        setEditClearanceLevel(String(operation.clearanceLevel || 0));
        setEditMarkers(new Set(operation.limitingMarkers?.map(m => m.id) || []));
        setEditIsSpecial(operation.isSpecial);
        setEditJoinCode(operation.joinCode || '');
        setEditIsJoint(operation.isJoint);
        setEditIsTraining(operation.isTraining);
        setEditTracksUec(operation.tracksUec);
        setEditUnitId(operation.unitId ? String(operation.unitId) : '');
        setEditLocationId(operation.locationId ? String(operation.locationId) : '');
        setIsEditing(true);
    };

    const handleSave = async () => {
        if (!editName.trim()) return;
        setSaving(true);
        try {
            const result: any = await updateOperationDetails(operation.id, {
                name: editName.trim(),
                description: editDescription.trim(),
                type: editType,
                status: editStatus !== operation.status ? editStatus : undefined,
                maxParticipants: editMaxParticipants || null,
                scheduledStart: editScheduledStart ? new Date(editScheduledStart).toISOString() : null,
                scheduledEnd: editScheduledEnd ? new Date(editScheduledEnd).toISOString() : null,
                clearanceLevel: parseInt(editClearanceLevel),
                markerIds: Array.from(editMarkers),
                isSpecial: editIsSpecial,
                joinCode: editIsSpecial ? editJoinCode : undefined,
                isJoint: editIsJoint,
                isTraining: editIsTraining,
                tracksUec: editTracksUec,
                unitId: editUnitId ? parseInt(editUnitId) : null,
                locationId: editLocationId ? parseInt(editLocationId) : null,
            });
            setIsEditing(false);
            if (result?.discordEventFailed) {
                addToast(
                    'Saved — Discord event did not sync',
                    <i className="fa-solid fa-triangle-exclamation"></i>,
                    'bg-amber-500/10 text-amber-400 border-amber-500/50',
                    { description: result.discordEventFailed },
                );
            } else {
                addToast("Operation Updated", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "Operation settings have been saved." });
            }
            onRefresh();
        } catch (err) {
            console.error("Failed to update:", err);
            addToast("Update Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to update operation settings." });
        } finally {
            setSaving(false);
        }
    };

    const handleInviteAlly = async () => {
        if (!invitePeerId) return;
        setInvitingAlly(true);
        try {
            await rpcAction('operation:invite_ally', { operationId: operation.id, peerId: invitePeerId });
            addToast("Ally Invited", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "The allied org has been invited to this operation." });
            setInvitePeerId('');
            onRefresh();
        } catch {
            addToast("Invite Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to invite the ally. Ensure joint operations are enabled for that peer." });
        } finally {
            setInvitingAlly(false);
        }
    };

    const handleRemoveAlly = async (peerId: string) => {
        const ok = await confirm({ title: 'Remove Ally', message: 'Remove this allied org from the operation? Their mirror will be revoked.', confirmText: 'Remove', variant: 'danger' });
        if (!ok) return;
        await rpcAction('operation:revoke_ally', { operationId: operation.id, peerId });
        onRefresh();
    };

    const inputClass = "w-full bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2.5 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 transition-all";
    const labelClass = "text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1.5 block";
    const cardClass = "bg-slate-900/60 rounded-xl border border-slate-700/30 overflow-hidden";

    if (!canManage) return null;

    return (
        <div className="p-6 lg:p-8 space-y-6">
            <div className="flex items-center justify-between p-4 bg-linear-to-r from-slate-800/60 to-slate-900/40 rounded-xl border border-slate-700/40 animate-fade-in-down">
                <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                    <i className="fa-solid fa-gear text-purple-400/70"></i> Operation Administration
                </p>
                {!isEditing && (
                    <button onClick={startEdit}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors">
                        <i className="fa-solid fa-pen-to-square"></i> Edit All Details
                    </button>
                )}
            </div>

            {isEditing ? (
                <div className={cardClass}>
                    <div className="px-5 py-3 bg-purple-500/5 border-b border-purple-500/10">
                        <p className="text-[10px] text-purple-300/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                            <i className="fa-solid fa-pen-to-square"></i> Edit Operation
                        </p>
                    </div>
                    <div className="p-6 space-y-6">
                        <div className="space-y-4">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest flex items-center gap-2"><i className="fa-solid fa-info-circle"></i> Core Details</p>
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <div className="lg:col-span-2">
                                    <label className={labelClass}>Operation Name</label>
                                    <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className={inputClass} placeholder="Operation name..." />
                                </div>
                                <div className="lg:col-span-2">
                                    <label className={labelClass}>Description / Briefing</label>
                                    <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={4} className={`${inputClass} resize-none`} placeholder="Mission briefing..." />
                                </div>
                                <div>
                                    <label className={labelClass}>Operation Type</label>
                                    <select value={editType} onChange={e => setEditType(e.target.value as OperationType)} className={inputClass}>
                                        {Object.values(OperationType).map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Status</label>
                                    <select value={editStatus} onChange={e => setEditStatus(e.target.value as OperationStatus)} className={inputClass}>
                                        {Object.values(OperationStatus).map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Max Participants</label>
                                    <input type="number" value={editMaxParticipants} onChange={e => setEditMaxParticipants(e.target.value ? parseInt(e.target.value) : '')} placeholder="Unlimited" className={inputClass} />
                                </div>
                                <div>
                                    <label className={labelClass}>Host Unit</label>
                                    <select value={editUnitId} onChange={e => setEditUnitId(e.target.value)} className={inputClass}>
                                        <option value="">No unit</option>
                                        {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Location / AO</label>
                                    <select value={editLocationId} onChange={e => setEditLocationId(e.target.value)} className={inputClass}>
                                        <option value="">No location</option>
                                        {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div className="border-t border-slate-700/30 pt-5 space-y-4">
                            <p className="text-[10px] text-amber-400/70 uppercase font-black tracking-widest flex items-center gap-2"><i className="fa-solid fa-clock"></i> Schedule</p>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={labelClass}>Scheduled Start</label>
                                    <input type="datetime-local" value={editScheduledStart} onChange={e => setEditScheduledStart(e.target.value)} className={`${inputClass} scheme-light`} />
                                </div>
                                <div>
                                    <label className={labelClass}>Scheduled End</label>
                                    <input type="datetime-local" value={editScheduledEnd} onChange={e => setEditScheduledEnd(e.target.value)} className={`${inputClass} scheme-light`} />
                                </div>
                            </div>
                        </div>

                        <div className="border-t border-slate-700/30 pt-5 space-y-4">
                            <p className="text-[10px] text-purple-400/70 uppercase font-black tracking-widest flex items-center gap-2"><i className="fa-solid fa-sliders"></i> Configuration</p>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                <button type="button" onClick={() => setEditIsSpecial(!editIsSpecial)}
                                    className={`flex items-center gap-2.5 p-3 rounded-lg border transition-all text-left ${editIsSpecial ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-slate-800/30 border-slate-700/30 text-slate-500 hover:border-slate-600'}`}>
                                    <i className="fa-solid fa-lock text-sm"></i>
                                    <span className="text-[10px] font-bold uppercase tracking-wider">Classified</span>
                                    <div className={`ml-auto w-4 h-4 rounded-full border-2 flex items-center justify-center ${editIsSpecial ? 'border-red-400 bg-red-400' : 'border-slate-600'}`}>
                                        {editIsSpecial && <i className="fa-solid fa-check text-[7px] text-black"></i>}
                                    </div>
                                </button>
                                <button type="button" onClick={() => setEditIsJoint(!editIsJoint)}
                                    className={`flex items-center gap-2.5 p-3 rounded-lg border transition-all text-left ${editIsJoint ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400' : 'bg-slate-800/30 border-slate-700/30 text-slate-500 hover:border-slate-600'}`}>
                                    <i className="fa-solid fa-handshake text-sm"></i>
                                    <span className="text-[10px] font-bold uppercase tracking-wider">Joint Operation</span>
                                    <div className={`ml-auto w-4 h-4 rounded-full border-2 flex items-center justify-center ${editIsJoint ? 'border-cyan-400 bg-cyan-400' : 'border-slate-600'}`}>
                                        {editIsJoint && <i className="fa-solid fa-check text-[7px] text-black"></i>}
                                    </div>
                                </button>
                                <button type="button" onClick={() => setEditIsTraining(!editIsTraining)}
                                    className={`flex items-center gap-2.5 p-3 rounded-lg border transition-all text-left ${editIsTraining ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-800/30 border-slate-700/30 text-slate-500 hover:border-slate-600'}`}>
                                    <i className="fa-solid fa-graduation-cap text-sm"></i>
                                    <span className="text-[10px] font-bold uppercase tracking-wider">Training Exercise</span>
                                    <div className={`ml-auto w-4 h-4 rounded-full border-2 flex items-center justify-center ${editIsTraining ? 'border-amber-400 bg-amber-400' : 'border-slate-600'}`}>
                                        {editIsTraining && <i className="fa-solid fa-check text-[7px] text-black"></i>}
                                    </div>
                                </button>
                                <button type="button" onClick={() => setEditTracksUec(!editTracksUec)}
                                    className={`flex items-center gap-2.5 p-3 rounded-lg border transition-all text-left ${editTracksUec ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-slate-800/30 border-slate-700/30 text-slate-500 hover:border-slate-600'}`}>
                                    <i className="fa-solid fa-coins text-sm"></i>
                                    <span className="text-[10px] font-bold uppercase tracking-wider">Track UEC</span>
                                    <div className={`ml-auto w-4 h-4 rounded-full border-2 flex items-center justify-center ${editTracksUec ? 'border-green-400 bg-green-400' : 'border-slate-600'}`}>
                                        {editTracksUec && <i className="fa-solid fa-check text-[7px] text-black"></i>}
                                    </div>
                                </button>
                            </div>
                            {editIsSpecial && (
                                <div>
                                    <label className={labelClass}>Join Code / PIN</label>
                                    <input type="text" value={editJoinCode} onChange={e => setEditJoinCode(e.target.value)} placeholder="Enter access code..."
                                        className={`${inputClass} max-w-xs font-mono tracking-widest`} />
                                </div>
                            )}
                        </div>

                        <div className="border-t border-slate-700/30 pt-5 space-y-4">
                            <p className="text-[10px] text-red-400/70 uppercase font-black tracking-widest flex items-center gap-2"><i className="fa-solid fa-shield-halved"></i> Security Classification</p>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={labelClass}>Clearance Level</label>
                                    <select value={editClearanceLevel} onChange={e => setEditClearanceLevel(e.target.value)} className={inputClass}>
                                        {securityClearances.map(c => (
                                            <option key={c.id} value={c.level}>Level {c.level} - {c.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>Limiting Markers</label>
                                    <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1 custom-scrollbar bg-black/20 border border-slate-700/50 rounded-lg p-2.5">
                                        {limitingMarkers.length > 0 ? limitingMarkers.map(m => (
                                            <label key={m.id} className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer hover:text-white">
                                                <input type="checkbox" checked={editMarkers.has(m.id)}
                                                    onChange={() => setEditMarkers(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                                                        return next;
                                                    })}
                                                    className="rounded-sm bg-slate-800 border-slate-600 text-purple-500 focus:ring-0 h-3.5 w-3.5" />
                                                <span>{m.code || m.name}</span>
                                            </label>
                                        )) : <span className="text-xs text-slate-600 italic">No markers configured.</span>}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-3 justify-end pt-3 border-t border-slate-700/30">
                            <button onClick={() => setIsEditing(false)} className="px-5 py-2.5 text-xs font-bold uppercase text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">Cancel</button>
                            <button onClick={handleSave} disabled={saving || !editName.trim()}
                                className="px-6 py-2.5 bg-purple-600/10 text-purple-300 border border-purple-600/30 hover:bg-purple-600/20 rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50">
                                {saving ? <><i className="fa-solid fa-spinner animate-spin mr-2"></i>Saving...</> : 'Save Changes'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className={cardClass}>
                        <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                <i className="fa-solid fa-info-circle text-purple-400/70"></i> Operation Details
                            </p>
                        </div>
                        <div className="p-5 grid grid-cols-2 lg:grid-cols-3 gap-4">
                            <InfoItem label="Name" value={operation.name} />
                            <InfoItem label="Type" value={operation.type} />
                            <InfoItem label="Status" value={operation.status} />
                            <InfoItem label="Host Unit" value={operation.unit?.name || 'None'} />
                            <InfoItem label="Location" value={operation.locationText || operation.location?.name || 'None'} />
                            <InfoItem label="Max Participants" value={operation.maxParticipants ? String(operation.maxParticipants) : 'Unlimited'} />
                            <InfoItem label="Scheduled Start" value={operation.scheduledStart ? formatOpDateTimeWithZone(operation.scheduledStart) : 'Not set'} />
                            <InfoItem label="Scheduled End" value={operation.scheduledEnd ? formatOpDateTimeWithZone(operation.scheduledEnd) : 'Not set'} />
                            <InfoItem label="Clearance Level" value={securityClearances.find(c => c.level === (operation.clearanceLevel || 0))?.name || `Level ${operation.clearanceLevel || 0}`} />
                        </div>
                    </div>

                    <div className={cardClass}>
                        <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                <i className="fa-solid fa-sliders text-purple-400/70"></i> Configuration Flags
                            </p>
                        </div>
                        <div className="p-5 flex flex-wrap gap-3">
                            <FlagChip label="Classified" active={operation.isSpecial} color="red" icon="fa-solid fa-lock" />
                            <FlagChip label="Joint Operation" active={operation.isJoint} color="cyan" icon="fa-solid fa-handshake" />
                            <FlagChip label="Training" active={operation.isTraining} color="amber" icon="fa-solid fa-graduation-cap" />
                            <FlagChip label="Tracks UEC" active={operation.tracksUec} color="green" icon="fa-solid fa-coins" />
                            {operation.isSpecial && operation.joinCode && (
                                <span className="text-[10px] font-mono text-slate-500 bg-slate-800/50 border border-slate-700/30 px-3 py-1.5 rounded-lg">
                                    PIN: <span className="text-white">{operation.joinCode}</span>
                                </span>
                            )}
                        </div>
                    </div>

                    {operation.isJoint && (
                        <div className={cardClass}>
                            <div className="px-5 py-3 bg-cyan-950/20 border-b border-cyan-500/10 flex items-center justify-between">
                                <p className="text-[10px] text-cyan-400/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                                    <i className="fa-solid fa-handshake"></i> Allied Organizations
                                </p>
                            </div>
                            <div className="p-5 space-y-3">
                                {(operation.alliedOrgs || []).map(ally => (
                                    <div key={ally.id} className={`flex items-center justify-between p-3 rounded-lg border ${ally.accepted ? 'bg-cyan-900/10 border-cyan-500/15' : 'bg-slate-800/30 border-slate-700/20'}`}>
                                        <div className="flex items-center gap-3">
                                            {ally.peerIconUrl && <img src={ally.peerIconUrl} className="w-8 h-8 rounded-sm" alt="" />}
                                            <div>
                                                <span className="text-sm font-bold text-white">{ally.peerOrgName || ally.label || 'Allied Org'}</span>
                                                <span className={`ml-2 text-[9px] font-black uppercase ${ally.accepted ? 'text-green-400' : 'text-amber-400'}`}>
                                                    {ally.accepted ? 'Confirmed' : 'Pending'}
                                                </span>
                                            </div>
                                        </div>
                                        <button onClick={() => handleRemoveAlly(ally.peerId)}
                                            className="text-red-400/60 hover:text-red-400 text-xs px-2 py-1 hover:bg-red-500/10 rounded-sm transition-colors">
                                            <i className="fa-solid fa-xmark"></i>
                                        </button>
                                    </div>
                                ))}
                                {(operation.alliedOrgs || []).length === 0 && (
                                    <p className="text-xs text-slate-600 italic">No allied organizations invited.</p>
                                )}
                                <div className="flex gap-2 pt-2">
                                    <select value={invitePeerId} onChange={e => setInvitePeerId(e.target.value)}
                                        className="flex-1 bg-black/20 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs outline-hidden focus:border-cyan-500/50">
                                        <option value="">Select an ally…</option>
                                        {eligiblePeers.filter(p => !(operation.alliedOrgs || []).some(a => a.peerId === p.id))
                                            .map(p => <option key={p.id} value={p.id}>{p.peerOrgName || p.label}</option>)}
                                    </select>
                                    <button onClick={handleInviteAlly} disabled={invitingAlly || !invitePeerId}
                                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 text-[10px] font-bold uppercase tracking-wider hover:bg-cyan-500/20 transition-colors disabled:opacity-50">
                                        {invitingAlly ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-plus"></i> Invite</>}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {onAction && (
                <div className={cardClass}>
                    <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/30">
                        <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                            <i className="fa-solid fa-rocket text-purple-400/70"></i> Mission Control
                        </p>
                    </div>
                    <div className="p-5 flex flex-wrap gap-3">
                        {(operation.status === OperationStatus.Planning || operation.status === OperationStatus.Scheduled) && (
                            <button onClick={() => onAction(() => updateOperationStatus(operation.id, OperationStatus.Active), 'launch')}
                                disabled={!!loadingAction}
                                className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg text-[10px] font-black uppercase tracking-wider shadow-lg shadow-green-900/20 active:scale-95 transition-all disabled:opacity-50">
                                {loadingAction === 'launch' ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-rocket"></i>}
                                Launch Mission
                            </button>
                        )}
                        {operation.status === OperationStatus.Active && (
                            <button onClick={() => onAction(() => updateOperationStatus(operation.id, OperationStatus.Concluded), 'end')}
                                disabled={!!loadingAction}
                                className="flex items-center gap-2 px-5 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-[10px] font-black uppercase tracking-wider shadow-lg active:scale-95 transition-all disabled:opacity-50">
                                {loadingAction === 'end' ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-flag-checkered"></i>}
                                End Mission
                            </button>
                        )}
                        {operation.status === OperationStatus.Concluded && (
                            <button onClick={() => onAction(() => updateOperationStatus(operation.id, OperationStatus.Active), 'reactivate')}
                                disabled={!!loadingAction}
                                className="flex items-center gap-2 px-5 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-[10px] font-black uppercase tracking-wider shadow-lg active:scale-95 transition-all disabled:opacity-50">
                                {loadingAction === 'reactivate' ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-rotate-right"></i>}
                                Reactivate
                            </button>
                        )}
                    </div>
                </div>
            )}

            {canManage && hasPermission('operations:create') && (
                <div className="bg-purple-950/10 rounded-xl border border-purple-500/15 overflow-hidden">
                    <div className="px-5 py-3 bg-purple-950/20 border-b border-purple-500/10">
                        <p className="text-[10px] text-purple-300/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                            <i className="fa-solid fa-clipboard-list"></i> Templates
                        </p>
                    </div>
                    <div className="p-5 flex items-center justify-between gap-4 flex-wrap">
                        <div className="max-w-xl">
                            <p className="text-xs text-slate-400">
                                Save this operation's phase / task / milestone structure as a reusable template. Participants, allies, command nodes, board, and logs are not included.
                            </p>
                            {sourceTemplate && (
                                <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1.5">
                                    <i className="fa-solid fa-bookmark text-purple-400/70"></i>
                                    Created from template: <span className="text-purple-300 font-bold">{sourceTemplate.name}</span>
                                </p>
                            )}
                        </div>
                        <button
                            onClick={handleSaveAsTemplate}
                            disabled={savingTemplate}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {savingTemplate
                                ? <><i className="fa-solid fa-spinner animate-spin"></i> Saving...</>
                                : <><i className="fa-solid fa-bookmark"></i> Save as Template</>}
                        </button>
                    </div>
                </div>
            )}

            {canManage && discordConfig?.clientId && (
                <div className="bg-indigo-950/10 rounded-xl border border-indigo-500/15 overflow-hidden">
                    <div className="px-5 py-3 bg-indigo-950/20 border-b border-indigo-500/10">
                        <p className="text-[10px] text-indigo-300/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                            <i className="fa-brands fa-discord"></i> Discord Announcement
                        </p>
                    </div>
                    <div className="p-5 flex flex-col gap-3">
                        <p className="text-xs text-slate-400 max-w-2xl">
                            Posts a rich embed (with ✅ ❌ ❓ reactions) of this operation to a Discord channel. If a message already exists for this channel, it's edited in place — reactions are preserved. Switching channels deletes the old message and posts fresh.
                        </p>
                        <div className="flex flex-wrap items-end gap-3">
                            <div className="flex-1 min-w-[260px]">
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                    <label className="text-[10px] text-slate-400 uppercase font-black tracking-widest">Channel</label>
                                    <button
                                        type="button"
                                        onClick={() => loadDiscordChannels(true)}
                                        disabled={discordChannelsLoading}
                                        className="text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
                                        title="Refresh channel list"
                                    >
                                        <i className={`fa-solid fa-rotate ${discordChannelsLoading ? 'fa-spin' : ''}`}></i>
                                    </button>
                                </div>
                                {discordChannelsError ? (
                                    <p className="text-[11px] text-amber-400 italic">{discordChannelsError}</p>
                                ) : (
                                    <select
                                        value={pickerChannelId}
                                        onFocus={() => { if (discordChannels.length === 0 && !discordChannelsLoading) loadDiscordChannels(); }}
                                        onChange={e => setPickerChannelId(e.target.value)}
                                        className="w-full bg-slate-800/70 border border-slate-700 rounded-lg p-2 text-white text-xs"
                                        disabled={reposting}
                                    >
                                        {/* Always include the currently-stored channel as an option even
                                            if the channels list isn't loaded yet, so the dropdown isn't
                                            empty on first paint. */}
                                        {pickerChannelId && !discordChannels.some(c => c.id === pickerChannelId) && (
                                            <option value={pickerChannelId}>{pickerChannelId}</option>
                                        )}
                                        {!pickerChannelId && <option value="">{discordChannelsLoading ? 'Loading channels…' : 'Select a channel…'}</option>}
                                        {discordChannels.map(c => (
                                            <option key={c.id} value={c.id}>{c.type === 5 ? '📢 ' : '# '}{c.name}</option>
                                        ))}
                                    </select>
                                )}
                                {operation.discordAnnouncementMessageId && operation.discordAnnouncementChannelId === pickerChannelId && (
                                    <p className="text-[10px] text-slate-500 italic mt-1">Same channel as the existing announcement — clicking will edit it in place.</p>
                                )}
                                {operation.discordAnnouncementMessageId && operation.discordAnnouncementChannelId !== pickerChannelId && (
                                    <p className="text-[10px] text-amber-400 italic mt-1">Channel changed — the old message will be deleted and a fresh embed posted.</p>
                                )}
                            </div>
                            <button
                                onClick={handleRepostAnnouncement}
                                disabled={reposting || !pickerChannelId}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-indigo-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {reposting
                                    ? <><i className="fa-solid fa-spinner animate-spin"></i> Posting…</>
                                    : operation.discordAnnouncementMessageId
                                        ? <><i className="fa-solid fa-rotate"></i> Repost Announcement</>
                                        : <><i className="fa-brands fa-discord"></i> Post to Discord</>}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="bg-red-950/10 rounded-xl border border-red-500/15 overflow-hidden">
                <div className="px-5 py-3 bg-red-950/20 border-b border-red-500/10">
                    <p className="text-[10px] text-red-400/80 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                        <i className="fa-solid fa-triangle-exclamation"></i> Danger Zone
                    </p>
                </div>
                <div className="p-5 flex flex-wrap gap-3">
                    <button onClick={onDeleteOperation} disabled={isDeleting}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-[10px] font-bold uppercase tracking-wider hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:pointer-events-none">
                        {isDeleting ? (
                            <><i className="fa-solid fa-spinner animate-spin"></i> Deleting Operation...</>
                        ) : (
                            <><i className="fa-solid fa-trash-can"></i> Delete Operation</>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

const InfoItem: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/20">
        <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">{label}</p>
        <p className="text-xs font-bold text-white truncate">{value}</p>
    </div>
);

const flagColorMap: Record<string, { active: string; }> = {
    red: { active: 'bg-red-500/10 text-red-400 border-red-500/20' },
    cyan: { active: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
    amber: { active: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
    green: { active: 'bg-green-500/10 text-green-400 border-green-500/20' },
};

const FlagChip: React.FC<{ label: string; active: boolean; color: string; icon: string }> = ({ label, active, color, icon }) => (
    <span className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-lg border transition-all duration-200 ${
        active
            ? flagColorMap[color]?.active || 'bg-purple-500/10 text-purple-300 border-purple-500/20'
            : 'bg-slate-800/30 text-slate-600 border-slate-700/20 line-through'
    }`}>
        <i className={`${icon} text-[9px]`}></i> {label}
    </span>
);

export default OpAdministerTab;
