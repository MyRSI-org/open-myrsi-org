import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { HydratedOperation, CommsPlanEntry, CommsProvider, OperationBoardElement } from '../../../../types';
import { useOperations } from '../../../../contexts/OperationsContext';
import { useData } from '../../../../contexts/DataContext';
import { getSupabase } from '../../../../lib/supabaseClient';
import { buildJoinLink } from '../../../../lib/commsPlanLinks';
import OpCommsTab from './OpCommsTab';

// Provider catalog — source-of-truth for icons, colors, and which fields each provider exposes.
// Used by both the editor (drives which inputs render) and the read view (icon/colour + join button).
interface ProviderMeta {
    label: string;
    icon: string;
    color: string;          // tailwind text-* class for the icon
    accent: string;         // tailwind border-/bg-* base for the row card
    fields: {
        label?: boolean;
        discordChannel?: boolean;
        address?: boolean;
        port?: boolean;
        url?: boolean;
        frequency?: boolean;
        callsign?: boolean;
    };
}

const PROVIDER_META: Record<CommsProvider, ProviderMeta> = {
    discord_voice:  { label: 'Discord Voice',   icon: 'fa-brands fa-discord',         color: 'text-[#5865F2]', accent: 'border-[#5865F2]/30 bg-[#5865F2]/5', fields: { discordChannel: true } },
    discord_text:   { label: 'Discord Text',    icon: 'fa-solid fa-hashtag',          color: 'text-[#5865F2]', accent: 'border-[#5865F2]/30 bg-[#5865F2]/5', fields: { discordChannel: true } },
    op_radio:       { label: 'Op Radio',        icon: 'fa-solid fa-tower-broadcast',  color: 'text-amber-400',  accent: 'border-amber-500/30 bg-amber-500/5', fields: {} },
    teamspeak:      { label: 'TeamSpeak',       icon: 'fa-solid fa-headset',          color: 'text-cyan-400',   accent: 'border-cyan-500/30 bg-cyan-500/5',   fields: { label: true, address: true, port: true } },
    mumble:         { label: 'Mumble',          icon: 'fa-solid fa-microphone',       color: 'text-emerald-400', accent: 'border-emerald-500/30 bg-emerald-500/5', fields: { label: true, address: true, port: true } },
    simple_radio:   { label: 'SimpleRadio',     icon: 'fa-solid fa-walkie-talkie',    color: 'text-orange-400', accent: 'border-orange-500/30 bg-orange-500/5', fields: { address: true, port: true, frequency: true, callsign: true } },
    dcs_srs:        { label: 'DCS-SRS',         icon: 'fa-solid fa-walkie-talkie',    color: 'text-rose-400',   accent: 'border-rose-500/30 bg-rose-500/5',   fields: { address: true, port: true, frequency: true, callsign: true } },
    external:       { label: 'External / URL',  icon: 'fa-solid fa-link',             color: 'text-slate-300',  accent: 'border-slate-500/30 bg-slate-500/5', fields: { url: true } },
    other:          { label: 'Other / Notes',   icon: 'fa-solid fa-circle-info',      color: 'text-slate-400',  accent: 'border-slate-700/40 bg-slate-800/20', fields: { label: true } },
};

const PROVIDER_OPTIONS: { value: CommsProvider; label: string }[] = [
    { value: 'discord_voice', label: 'Discord — Voice channel' },
    { value: 'discord_text',  label: 'Discord — Text channel' },
    { value: 'op_radio',      label: 'In-platform Op Radio' },
    { value: 'teamspeak',     label: 'TeamSpeak' },
    { value: 'mumble',        label: 'Mumble' },
    { value: 'simple_radio',  label: 'SimpleRadio (in-game)' },
    { value: 'dcs_srs',       label: 'DCS-SRS (in-game)' },
    { value: 'external',      label: 'External URL' },
    { value: 'other',         label: 'Other / free-text' },
];

interface DiscordChannelOption {
    id: string;
    name: string;
    type: number;  // 0 text, 2 voice, 5 announcement, 13 stage
    parentId: string | null;
}

function isLegacyRow(entry: CommsPlanEntry): boolean {
    return !entry.provider;
}

function deriveLegacyDisplay(entry: CommsPlanEntry) {
    // For pre-v2 rows, fall back to the old fields when rendering.
    return {
        title: entry.purpose || entry.channel || '(Untitled)',
        subtitle: [entry.frequency ? `Freq ${entry.frequency}` : null, entry.callsign ? `Callsign ${entry.callsign}` : null].filter(Boolean).join(' · '),
        notes: entry.notes,
    };
}

interface OpCommandSignalsTabProps {
    operation: HydratedOperation;
    canManage: boolean;
    isParticipant: boolean;
    onRefresh: () => void;
}

type SubTab = 'comms-plan' | 'tactical-board' | 'ops-log';

// Comms Plan section: provider-aware editor + read view. Backward-compatible with legacy
// 4-field rows (channel/frequency/callsign/notes), which render in fallback mode without
// action buttons until a user edits them.
const CommsPlanSection: React.FC<{ operation: HydratedOperation; canManage: boolean; onUpdate: (plan: CommsPlanEntry[]) => Promise<any> }> = ({ operation, canManage, onUpdate }) => {
    const { rpcAction } = useData();
    // Memoise the `|| []` fallback so downstream memos (hasDiscordRow,
    // editEntries seed) get a stable reference when commsPlan is undefined.
    const entries = useMemo(() => operation.commsPlan || [], [operation.commsPlan]);
    const [isEditing, setIsEditing] = useState(false);
    const [editEntries, setEditEntries] = useState<CommsPlanEntry[]>(entries);
    const [saving, setSaving] = useState(false);

    // Discord guild channel directory — fetched lazily when the editor opens
    // OR when the read view needs to resolve a Discord channel name. Cached
    // in component state for the duration of this section's mount; the server
    // also caches for 60s.
    const [guildChannels, setGuildChannels] = useState<DiscordChannelOption[]>([]);
    const [guildId, setGuildId] = useState<string | null>(null);
    const [guildError, setGuildError] = useState<string | null>(null);
    const [guildLoading, setGuildLoading] = useState(false);

    const hasDiscordRow = useMemo(
        () => entries.some(e => e.provider === 'discord_voice' || e.provider === 'discord_text'),
        [entries],
    );

    const loadGuildChannels = useCallback(async (forceRefresh = false) => {
        setGuildLoading(true);
        try {
            const result = await rpcAction('discord:list_guild_channels', { forceRefresh });
            setGuildChannels(result?.channels || []);
            setGuildId(result?.guildId || null);
            setGuildError(result?.error || null);
        } catch (err: any) {
            console.error('[CommsPlan] Failed to load Discord channels:', err);
            setGuildChannels([]);
            setGuildError(err?.message || 'Failed to load Discord channels.');
        } finally {
            setGuildLoading(false);
        }
    }, [rpcAction]);

    // Read-view: fetch only if there's actually a Discord row to resolve. The
    // fetch runs inside an async IIFE so the loading flag is set as part of the
    // asynchronous data-sync (loadGuildChannels) rather than as a synchronous
    // setState in the effect body — same fetch, same flag timing as before.
    useEffect(() => {
        if (hasDiscordRow && guildChannels.length === 0 && !guildError && !guildLoading) {
            void (async () => { await loadGuildChannels(); })();
        }
    }, [hasDiscordRow, guildChannels.length, guildError, guildLoading, loadGuildChannels]);

    const channelById = useMemo(() => {
        const map = new Map<string, DiscordChannelOption>();
        for (const c of guildChannels) map.set(c.id, c);
        return map;
    }, [guildChannels]);

    // Stable React keys for the read-only plan. Provider-typed rows carry an `id`;
    // legacy rows predate id assignment, so we derive a deterministic content-based
    // key for them (with an occurrence suffix to disambiguate identical rows). The
    // list is never reordered/filtered in the read view, so these keys are stable
    // across renders — equivalent to the previous `entry.id || index` keying.
    const keyedEntries = useMemo(() => {
        const seen = new Map<string, number>();
        return entries.map(entry => {
            const base = entry.id
                ?? `legacy:${entry.purpose || ''}|${entry.channel || ''}|${entry.frequency || ''}|${entry.callsign || ''}|${entry.notes || ''}`;
            const occurrence = seen.get(base) ?? 0;
            seen.set(base, occurrence + 1);
            return { key: occurrence === 0 ? base : `${base}#${occurrence}`, entry };
        });
    }, [entries]);

    const openEditor = () => {
        // Assign a stable id to any legacy row up front (these are minted on save
        // anyway) so every editable row has a unique React key.
        const seed: CommsPlanEntry[] = entries.length > 0
            ? entries.map(e => ({ ...e, id: e.id || cryptoUuid() }))
            : [{ id: cryptoUuid(), purpose: '', provider: 'discord_voice' }];
        setEditEntries(seed);
        setIsEditing(true);
        // Pre-fetch channels so the dropdown is ready when the user expands a Discord row.
        loadGuildChannels();
    };

    const handleAddRow = () => {
        setEditEntries(prev => [...prev, { id: cryptoUuid(), purpose: '', provider: 'discord_voice' }]);
    };
    const handleRemoveRow = (i: number) => setEditEntries(prev => prev.filter((_, idx) => idx !== i));
    const updateField = <K extends keyof CommsPlanEntry>(i: number, field: K, value: CommsPlanEntry[K]) => {
        setEditEntries(prev => {
            const next = [...prev];
            next[i] = { ...next[i], [field]: value };
            return next;
        });
    };
    const updateProvider = (i: number, provider: CommsProvider) => {
        setEditEntries(prev => {
            const next = [...prev];
            const cur = next[i] || {};
            // Preserve user-entered values across provider swaps so the user
            // doesn't lose work when reclassifying a row.
            next[i] = { ...cur, provider };
            return next;
        });
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            // Filter out rows that are still empty (no purpose AND no provider-specific reference).
            const sanitised = editEntries
                .map(e => ({
                    ...e,
                    id: e.id || cryptoUuid(),
                    purpose: (e.purpose || '').trim() || undefined,
                    label: (e.label || '').trim() || undefined,
                    address: (e.address || '').trim() || undefined,
                    url: (e.url || '').trim() || undefined,
                    frequency: (e.frequency || '').trim() || undefined,
                    callsign: (e.callsign || '').trim() || undefined,
                    notes: (e.notes || '').trim() || undefined,
                    // Discard the legacy `channel` field on save when the row is now provider-typed.
                    channel: e.provider ? undefined : e.channel,
                }))
                .filter(e => {
                    // Keep rows that have at least a purpose, a provider reference, or legacy data.
                    if (e.purpose || e.label || e.notes) return true;
                    if (e.provider === 'discord_voice' || e.provider === 'discord_text') return !!e.discordChannelId;
                    if (e.provider === 'teamspeak' || e.provider === 'mumble') return !!e.address;
                    if (e.provider === 'simple_radio' || e.provider === 'dcs_srs') return !!(e.address || e.frequency);
                    if (e.provider === 'external') return !!e.url;
                    if (e.channel) return true;
                    return false;
                });
            await onUpdate(sanitised);
            setIsEditing(false);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="p-6 lg:p-8 space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                    <i className="fa-solid fa-tower-broadcast text-purple-400/70"></i> Communications Plan
                </p>
                {canManage && !isEditing && (
                    <button onClick={openEditor}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider hover:bg-purple-500/20 transition-colors">
                        <i className="fa-solid fa-pen-to-square"></i> Edit
                    </button>
                )}
            </div>

            {isEditing ? (
                <CommsPlanEditor
                    entries={editEntries}
                    saving={saving}
                    guildChannels={guildChannels}
                    guildLoading={guildLoading}
                    guildError={guildError}
                    onRefreshGuild={() => loadGuildChannels(true)}
                    onAddRow={handleAddRow}
                    onRemoveRow={handleRemoveRow}
                    onUpdateField={updateField}
                    onUpdateProvider={updateProvider}
                    onCancel={() => setIsEditing(false)}
                    onSave={handleSave}
                />
            ) : entries.length > 0 ? (
                <div className="space-y-2">
                    {keyedEntries.map(({ key, entry }) => (
                        <CommsPlanRow
                            key={key}
                            entry={entry}
                            channelById={channelById}
                            guildId={guildId}
                        />
                    ))}
                </div>
            ) : (
                <div className="text-center py-12">
                    <i className="fa-solid fa-tower-broadcast text-3xl text-slate-700 mb-3"></i>
                    <p className="text-slate-600 text-xs italic">No communications plan defined.</p>
                </div>
            )}
        </div>
    );
};

const CommsPlanRow: React.FC<{
    entry: CommsPlanEntry;
    channelById: Map<string, DiscordChannelOption>;
    guildId: string | null;
}> = ({ entry, channelById, guildId }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — silently no-op */ }
    };

    if (isLegacyRow(entry)) {
        const { title, subtitle, notes } = deriveLegacyDisplay(entry);
        return (
            <div className="rounded-lg border border-slate-700/40 bg-slate-800/20 px-4 py-3">
                <div className="flex items-start gap-3">
                    <i className="fa-solid fa-circle-info text-slate-500 mt-1"></i>
                    <div className="min-w-0 flex-1">
                        <div className="text-sm text-white font-bold truncate">{title}</div>
                        {subtitle && <div className="text-[11px] font-mono text-slate-400 mt-0.5">{subtitle}</div>}
                        {notes && <div className="text-xs text-slate-400 mt-1 leading-relaxed">{notes}</div>}
                        <div className="text-[9px] text-slate-600 uppercase tracking-widest mt-1.5">Legacy entry — edit to convert</div>
                    </div>
                </div>
            </div>
        );
    }

    const provider = entry.provider || 'other';
    const meta = PROVIDER_META[provider];
    const link = buildJoinLink(entry, guildId);

    // Resolved channel name — for Discord rows we look it up against the cached
    // guild channel list. If the bot can't see it (deleted, permission lost),
    // fall back to the stored ID with a faint indicator.
    let primaryReference: string | null = null;
    let secondaryReference: string | null = null;

    if (provider === 'discord_voice' || provider === 'discord_text') {
        const channel = entry.discordChannelId ? channelById.get(entry.discordChannelId) : null;
        primaryReference = channel ? `#${channel.name}` : (entry.discordChannelId ? `(channel ${entry.discordChannelId})` : '(not selected)');
    } else if (provider === 'teamspeak' || provider === 'mumble') {
        primaryReference = entry.address ? `${entry.address}${entry.port ? `:${entry.port}` : ''}` : null;
        if (entry.label) secondaryReference = entry.label;
    } else if (provider === 'simple_radio' || provider === 'dcs_srs') {
        primaryReference = entry.address ? `${entry.address}${entry.port ? `:${entry.port}` : ''}` : null;
    } else if (provider === 'external') {
        primaryReference = entry.url || null;
    } else if (provider === 'op_radio') {
        primaryReference = 'In-platform LiveKit room';
    } else if (provider === 'other') {
        primaryReference = entry.label || null;
    }

    const showFreqCallsign = (provider === 'simple_radio' || provider === 'dcs_srs') && (entry.frequency || entry.callsign);

    const handleJoin = () => {
        if (!link.primary) return;
        // Open the native handler. For Discord, fall back to the web client
        // after a short delay if no client picks up. Browser will silently
        // ignore unknown protocols, so we try-catch the assignment.
        try {
            window.location.href = link.primary;
        } catch { /* ignore */ }
        if ((provider === 'discord_voice' || provider === 'discord_text') && link.fallback) {
            // 800ms is enough for the desktop client to register the navigation;
            // longer than this risks a double-open.
            setTimeout(() => {
                try { window.open(link.fallback, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
            }, 800);
        }
    };

    return (
        <div className={`rounded-lg border ${meta.accent} px-4 py-3`}>
            <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-900/60 border border-slate-700/40 flex items-center justify-center shrink-0">
                    <i className={`${meta.icon} ${meta.color} text-base`}></i>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-white font-bold truncate">{entry.purpose || meta.label}</span>
                        <span className="text-[9px] text-slate-500 uppercase tracking-widest font-mono">{meta.label}</span>
                    </div>
                    {primaryReference && (
                        <div className="text-[12px] font-mono text-slate-300 mt-0.5 break-all">{primaryReference}</div>
                    )}
                    {secondaryReference && (
                        <div className="text-[11px] text-slate-500 mt-0.5">Channel: {secondaryReference}</div>
                    )}
                    {showFreqCallsign && (
                        <div className="flex flex-wrap gap-2 mt-2">
                            {entry.frequency && (
                                <span className="text-[10px] font-mono text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-sm px-2 py-0.5">FREQ {entry.frequency}</span>
                            )}
                            {entry.callsign && (
                                <span className="text-[10px] font-mono text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-sm px-2 py-0.5">CALL {entry.callsign}</span>
                            )}
                        </div>
                    )}
                    {entry.notes && (
                        <div className="text-xs text-slate-400 mt-1.5 leading-relaxed">{entry.notes}</div>
                    )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {link.primary && (
                        <button
                            onClick={handleJoin}
                            className="px-3 py-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[10px] font-bold uppercase tracking-wider transition-colors"
                            title={link.primary}
                        >
                            <i className={`${provider === 'discord_voice' || provider === 'discord_text' ? 'fa-brands fa-discord' : 'fa-solid fa-arrow-up-right-from-square'} mr-1.5`}></i>
                            {provider === 'discord_voice' || provider === 'discord_text' ? 'Open' : 'Connect'}
                        </button>
                    )}
                    {link.copyText && (
                        <button
                            onClick={() => handleCopy(link.copyText!)}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 text-slate-400 hover:text-white border border-slate-700/40 text-[10px] font-bold uppercase tracking-wider transition-colors"
                            title="Copy address"
                        >
                            <i className={copied ? 'fa-solid fa-check' : 'fa-solid fa-copy'}></i>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

const CommsPlanEditor: React.FC<{
    entries: CommsPlanEntry[];
    saving: boolean;
    guildChannels: DiscordChannelOption[];
    guildLoading: boolean;
    guildError: string | null;
    onRefreshGuild: () => void;
    onAddRow: () => void;
    onRemoveRow: (i: number) => void;
    onUpdateField: <K extends keyof CommsPlanEntry>(i: number, field: K, value: CommsPlanEntry[K]) => void;
    onUpdateProvider: (i: number, provider: CommsProvider) => void;
    onCancel: () => void;
    onSave: () => void;
}> = ({ entries, saving, guildChannels, guildLoading, guildError, onRefreshGuild, onAddRow, onRemoveRow, onUpdateField, onUpdateProvider, onCancel, onSave }) => {
    return (
        <div className="space-y-3">
            <div className="space-y-3">
                {entries.map((entry, i) => {
                    const provider: CommsProvider = entry.provider || 'other';
                    const meta = PROVIDER_META[provider];
                    return (
                        <div key={entry.id} className={`rounded-lg border ${meta.accent} p-3 space-y-2.5`}>
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-lg bg-slate-900/60 border border-slate-700/40 flex items-center justify-center shrink-0">
                                    <i className={`${meta.icon} ${meta.color} text-sm`}></i>
                                </div>
                                <input
                                    value={entry.purpose || ''}
                                    onChange={e => onUpdateField(i, 'purpose', e.target.value)}
                                    placeholder="Purpose (e.g. Command Net, Alpha Squad)"
                                    className="flex-1 bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30"
                                />
                                <select
                                    value={provider}
                                    onChange={e => onUpdateProvider(i, e.target.value as CommsProvider)}
                                    className="bg-slate-900 border border-slate-700/50 text-white text-xs rounded-lg px-2 py-2 outline-hidden focus:border-purple-500/40"
                                >
                                    {PROVIDER_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </select>
                                <button onClick={() => onRemoveRow(i)} className="text-red-400 hover:text-red-300 w-7 h-7 flex items-center justify-center rounded-sm hover:bg-red-500/10" title="Remove row">
                                    <i className="fa-solid fa-xmark"></i>
                                </button>
                            </div>

                            {/* Provider-specific fields */}
                            {(provider === 'discord_voice' || provider === 'discord_text') && (
                                <DiscordChannelPicker
                                    expectedType={provider === 'discord_voice' ? [2, 13] : [0, 5]}
                                    value={entry.discordChannelId || ''}
                                    onChange={(channelId, channelName) => {
                                        onUpdateField(i, 'discordChannelId', channelId || undefined);
                                        if (channelName) onUpdateField(i, 'label', channelName);
                                    }}
                                    channels={guildChannels}
                                    loading={guildLoading}
                                    error={guildError}
                                    onRefresh={onRefreshGuild}
                                />
                            )}

                            {meta.fields.address && (
                                <div className="grid grid-cols-[1fr_140px] gap-2">
                                    <input
                                        value={entry.address || ''}
                                        onChange={e => onUpdateField(i, 'address', e.target.value)}
                                        placeholder="Server address (host or IP)"
                                        className="bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                                    />
                                    {meta.fields.port && (
                                        <input
                                            type="number"
                                            value={entry.port ?? ''}
                                            onChange={e => onUpdateField(i, 'port', e.target.value ? Number(e.target.value) : undefined)}
                                            placeholder="Port"
                                            className="bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                                        />
                                    )}
                                </div>
                            )}

                            {meta.fields.label && provider !== 'discord_voice' && provider !== 'discord_text' && (
                                <input
                                    value={entry.label || ''}
                                    onChange={e => onUpdateField(i, 'label', e.target.value)}
                                    placeholder={provider === 'teamspeak' || provider === 'mumble' ? 'Channel name (optional)' : 'Display label (optional)'}
                                    className="w-full bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                                />
                            )}

                            {meta.fields.url && (
                                <input
                                    value={entry.url || ''}
                                    onChange={e => onUpdateField(i, 'url', e.target.value)}
                                    placeholder="https://… or ts3server://…"
                                    className="w-full bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                                />
                            )}

                            {(meta.fields.frequency || meta.fields.callsign) && (
                                <div className="grid grid-cols-2 gap-2">
                                    {meta.fields.frequency && (
                                        <input
                                            value={entry.frequency || ''}
                                            onChange={e => onUpdateField(i, 'frequency', e.target.value)}
                                            placeholder="Frequency (e.g. 251.0 MHz)"
                                            className="bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                                        />
                                    )}
                                    {meta.fields.callsign && (
                                        <input
                                            value={entry.callsign || ''}
                                            onChange={e => onUpdateField(i, 'callsign', e.target.value)}
                                            placeholder="Callsign"
                                            className="bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                                        />
                                    )}
                                </div>
                            )}

                            <input
                                value={entry.notes || ''}
                                onChange={e => onUpdateField(i, 'notes', e.target.value)}
                                placeholder="Notes (optional)"
                                className="w-full bg-black/20 border border-slate-700/50 text-slate-300 text-xs rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
                            />
                        </div>
                    );
                })}
            </div>
            <button onClick={onAddRow} className="text-xs text-purple-300 hover:text-purple-200">
                <i className="fa-solid fa-plus mr-1"></i>Add channel
            </button>
            <div className="flex gap-3 justify-end">
                <button onClick={onCancel} className="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">Cancel</button>
                <button onClick={onSave} disabled={saving} className="text-xs text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                    {saving ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Plan'}
                </button>
            </div>
        </div>
    );
};

const DiscordChannelPicker: React.FC<{
    expectedType: number[];
    value: string;
    onChange: (channelId: string, channelName: string | null) => void;
    channels: DiscordChannelOption[];
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
}> = ({ expectedType, value, onChange, channels, loading, error, onRefresh }) => {
    const filtered = useMemo(() => channels.filter(c => expectedType.includes(c.type)), [channels, expectedType]);

    if (error) {
        return (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
                <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                {error}
                <button onClick={onRefresh} className="ml-2 underline hover:text-amber-100">Retry</button>
            </div>
        );
    }

    if (loading && channels.length === 0) {
        return (
            <div className="text-[11px] text-slate-500"><i className="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading channels…</div>
        );
    }

    if (filtered.length === 0) {
        return (
            <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-2 text-[11px] text-slate-400">
                No matching channels found.
                <button onClick={onRefresh} className="ml-2 underline text-purple-300 hover:text-purple-200">Refresh</button>
            </div>
        );
    }

    return (
        <div className="flex gap-2">
            <select
                value={value}
                onChange={e => {
                    const id = e.target.value;
                    const ch = filtered.find(c => c.id === id);
                    onChange(id, ch?.name || null);
                }}
                className="flex-1 bg-slate-900 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2 outline-hidden focus:border-purple-500/40"
            >
                <option value="">— select a channel —</option>
                {filtered.map(c => (
                    <option key={c.id} value={c.id}>#{c.name}</option>
                ))}
            </select>
            <button
                onClick={onRefresh}
                className="px-3 py-2 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 text-slate-400 hover:text-white border border-slate-700/40 text-[10px]"
                title="Refresh channel list (60s server cache)"
            >
                <i className="fa-solid fa-rotate"></i>
            </button>
        </div>
    );
};

// crypto.randomUUID is widely available; falls back to a Math.random ID
// only if running in an unusually old environment.
function cryptoUuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

import { Stage, Layer, Rect, Circle, Line, Text as KonvaText, Group, Transformer } from 'react-konva';
import Konva from 'konva';

type ToolType = OperationBoardElement['elementType'] | 'draw' | null;

const ELEMENT_TOOLS: { type: OperationBoardElement['elementType']; icon: string; color: string; label: string }[] = [
    { type: 'unit', icon: 'fa-solid fa-users', color: '#3b82f6', label: 'Unit' },
    { type: 'waypoint', icon: 'fa-solid fa-location-dot', color: '#f59e0b', label: 'Waypoint' },
    { type: 'ship', icon: 'fa-solid fa-rocket', color: '#06b6d4', label: 'Ship' },
    { type: 'zone', icon: 'fa-solid fa-draw-polygon', color: '#22c55e', label: 'Zone' },
    { type: 'line', icon: 'fa-solid fa-minus', color: '#94a3b8', label: 'Line' },
    { type: 'text', icon: 'fa-solid fa-font', color: '#e2e8f0', label: 'Text' },
    { type: 'icon', icon: 'fa-solid fa-icons', color: '#a855f7', label: 'Icon' },
];

const ELEMENT_ICONS: Record<string, { icon: string; color: string }> = Object.fromEntries(ELEMENT_TOOLS.map(t => [t.type, { icon: t.icon, color: t.color }]));

// Unicode symbols for konva text rendering (FontAwesome not available in canvas)
const ELEMENT_SYMBOLS: Record<string, string> = {
    unit: '\u2694', // crossed swords
    waypoint: '\u25C9', // fisheye
    ship: '\u2708', // airplane
    zone: '\u25A1', // square
    line: '\u2500', // line
    text: 'T',
    icon: '\u2605', // star
};

// Distance-based point simplification for freehand strokes
// Keeps points that are at least `minDist` pixels apart from the last kept point
function simplifyPoints(points: number[], minDist: number = 4): number[] {
    if (points.length < 6) return points; // fewer than 3 coordinate pairs
    const result = [points[0], points[1]];
    let lastX = points[0], lastY = points[1];
    for (let i = 2; i < points.length - 2; i += 2) {
        const dx = points[i] - lastX;
        const dy = points[i + 1] - lastY;
        if (dx * dx + dy * dy >= minDist * minDist) {
            result.push(points[i], points[i + 1]);
            lastX = points[i];
            lastY = points[i + 1];
        }
    }
    // Always keep the last point
    result.push(points[points.length - 2], points[points.length - 1]);
    return result;
}

const TacticalBoard: React.FC<{ operation: HydratedOperation; canManage: boolean; onRefresh: () => void }> = ({ operation, canManage, onRefresh }) => {
    const { rpcAction } = useData();
    // Memoise the `|| []` fallback so downstream effects/memos that watch
    // baseElements only re-fire when the underlying boardElements array
    // actually changes.
    const baseElements = useMemo(() => operation.boardElements || [], [operation.boardElements]);

    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<Konva.Stage>(null);
    const transformerRef = useRef<Konva.Transformer>(null);
    const [stageSize, setStageSize] = useState({ width: 800, height: 600 });

    // Pan/zoom state (refs kept in sync for stable callback access). The raw
    // useState setters take the canonical names; the `commit*` wrappers below
    // additionally mirror each value into a ref so pointer/wheel handlers can
    // read the latest value synchronously without re-binding.
    const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1.0);
    const stagePosRef = useRef({ x: 0, y: 0 });
    const zoomRef = useRef(1.0);
    const commitStagePos = useCallback((pos: { x: number; y: number }) => {
        stagePosRef.current = pos;
        setStagePos(pos);
    }, []);
    const commitZoom = useCallback((val: number | ((prev: number) => number)) => {
        if (typeof val === 'function') {
            setZoom(prev => {
                const next = val(prev);
                zoomRef.current = next;
                return next;
            });
        } else {
            zoomRef.current = val;
            setZoom(val);
        }
    }, []);

    // Tool mode: null = pan/select, element type = click-to-place, 'draw' = freehand
    const [activeTool, setActiveTool] = useState<ToolType>(null);
    const [toolColor, setToolColor] = useState('#3b82f6');
    const [saving, setSaving] = useState(false);

    // Snap-to-grid: when enabled, placement / drag-end / nudge round to
    // `GRID_SIZE` pixels. Matches the existing faint grid overlay spacing.
    const GRID_SIZE = 50;
    const [snapEnabled, setSnapEnabled] = useState(false);
    const snap = useCallback(
        (v: number) => snapEnabled ? Math.round(v / GRID_SIZE) * GRID_SIZE : v,
        [snapEnabled],
    );

    // Clipboard for copy/paste. Stores deep-copied element snapshots minus id
    // — paste re-creates fresh rows, so new server-assigned IDs are fine.
    const clipboardRef = useRef<OperationBoardElement[]>([]);

    // Multi-select state — shift-click toggles, drag-box rubber-bands. The
    // properties panel only exposes inline edits when exactly one element is
    // selected (label/color editing is per-element, not batch-friendly).
    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

    // Inline edit for single-selected element
    const [editLabel, setEditLabel] = useState('');
    const [editColor, setEditColor] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);

    // Freehand drawing state
    const isDrawingRef = useRef(false);
    const [drawingPoints, setDrawingPoints] = useState<number[]>([]);
    const drawingPointsRef = useRef<number[]>([]);
    const drawingFrameRef = useRef(0);

    // Drag-to-create state (zones, lines). `sx`/`sy` carry the drag start point
    // so the line preview can be drawn purely from this state without reading
    // drawStartRef during render.
    const drawStartRef = useRef<{ x: number; y: number } | null>(null);
    const isDraggingShapeRef = useRef(false);
    const [drawPreview, setDrawPreview] = useState<{ x: number; y: number; w: number; h: number; sx: number; sy: number } | null>(null);

    // Rubber-band (drag-box) selection state — activated by shift+drag on empty stage.
    const rubberStartRef = useRef<{ x: number; y: number } | null>(null);
    const [rubberRect, setRubberRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    // Mirror of rubberRect so the pointer-up handler can read the latest rect
    // without taking rubberRect as a dep (which would re-bind it on every
    // mouse-move during a marquee). Kept in sync next to every setRubberRect call.
    const rubberRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

    // Optimistic elements (shown immediately before server confirmation)
    const [optimisticElements, setOptimisticElements] = useState<OperationBoardElement[]>([]);
    const nextOptimisticIdRef = useRef(-1);

    // Realtime delta state. Board mutations from other tabs land on `op-board-{operationId}`
    // and merge into liveElements / deletedIds before the next full detail refetch. The
    // originating tab calls onRefresh() for itself; remote tabs apply the delta directly.
    const [liveElements, setLiveElements] = useState<Map<number, OperationBoardElement>>(() => new Map());
    const [deletedIds, setDeletedIds] = useState<Set<number>>(() => new Set());
    // IDs the local user is mid-drag on — remote `update` deltas for these
    // are dropped so the element doesn't yank out from under the cursor.
    const localDraggingIdsRef = useRef<Set<number>>(new Set());
    // clientNonce → optimistic id mapping. When the broadcast for our own add
    // returns with the matching nonce, we retire the placeholder so the real
    // server-assigned row replaces it without flicker.
    const pendingNoncesRef = useRef<Map<string, number>>(new Map());

    // Stable ref so the channel handler (which captures it once) sees the
    // latest baseElements without forcing a re-subscribe on every prop change.
    const baseElementsRef = useRef<OperationBoardElement[]>(baseElements);
    useEffect(() => { baseElementsRef.current = baseElements; }, [baseElements]);

    // Undo/redo history for position and property edits only. Add/delete don't enter
    // history — server IDs change on re-add, which would poison the stack.
    interface HistoryEntry {
        op: 'move' | 'update';
        elementId: number;
        before: Partial<OperationBoardElement>;
        after: Partial<OperationBoardElement>;
    }
    const historyRef = useRef<HistoryEntry[]>([]);
    const futureRef = useRef<HistoryEntry[]>([]);
    const HISTORY_LIMIT = 30;
    const pushHistory = useCallback((entry: HistoryEntry) => {
        historyRef.current.push(entry);
        if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
        futureRef.current = []; // new edit invalidates redo chain
    }, []);

    // When a fresh server baseline lands (full op-detail refetch), it supersedes
    // everything we've been carrying locally — optimistics, live deltas, and
    // tombstones. Also prune selection of IDs no longer present.
    //
    // The state resets run as a render-time adjust keyed on the baseElements
    // reference (React's "adjust state during render" pattern) rather than in an
    // effect: React re-renders before paint, so the cleared local state lands with
    // the same timing as the old effect — without the synchronous setState-in-effect.
    // The block runs at most once per baseline change (the tracker update
    // short-circuits the immediate re-render), matching the old [baseElements] dep.
    const [prevBaseElements, setPrevBaseElements] = useState(baseElements);
    if (baseElements !== prevBaseElements) {
        setPrevBaseElements(baseElements);
        setOptimisticElements([]);
        setLiveElements(new Map());
        setDeletedIds(new Set());
        const liveIds = new Set(baseElements.map(e => e.id));
        setSelectedIds(prev => {
            let changed = false;
            const next = new Set<number>();
            for (const id of prev) {
                if (liveIds.has(id)) next.add(id); else changed = true;
            }
            return changed ? next : prev;
        });
    }

    // Ref bookkeeping for the same baseline change — kept in an effect because
    // refs must not be mutated during render. These are not render state: the
    // nonce map and undo/redo stacks are only read from event handlers, so
    // clearing/pruning them post-commit is equivalent to the old combined effect.
    useEffect(() => {
        pendingNoncesRef.current.clear();
        const liveIds = new Set(baseElements.map(e => e.id));
        historyRef.current = historyRef.current.filter(h => liveIds.has(h.elementId));
        futureRef.current = futureRef.current.filter(h => liveIds.has(h.elementId));
    }, [baseElements]);

    // Compose the effective element list: baseline minus tombstones, with each
    // remaining baseline row replaced by its live override if one exists, plus
    // any live-only adds (remote inserts since the last baseline).
    const elements = useMemo<OperationBoardElement[]>(() => {
        const out: OperationBoardElement[] = [];
        for (const el of baseElements) {
            if (deletedIds.has(el.id)) continue;
            out.push(liveElements.get(el.id) ?? el);
        }
        for (const [id, el] of liveElements) {
            if (!baseElements.some(b => b.id === id)) out.push(el);
        }
        return out;
    }, [baseElements, liveElements, deletedIds]);

    const selectedElement = selectedIds.size === 1
        ? elements.find(e => e.id === Array.from(selectedIds)[0]) || null
        : null;

    // Auto-name counter — tracks the merged element count so labels like
    // "Unit 4" stay stable across realtime additions.
    const elementCountRef = useRef(elements.length);
    useEffect(() => { elementCountRef.current = elements.length; }, [elements.length]);

    // Stable ref to the merged element list so the pointer-up handler's
    // marquee hit-test can read the latest elements without taking `elements`
    // as a dep (the handler already recreates on placeElement→getAutoName).
    const elementsRef = useRef(elements);
    useEffect(() => { elementsRef.current = elements; }, [elements]);

    // Subscribe to per-op board deltas. Channel name and event match the
    // server-side helpers in lib/db/ops.ts (broadcastBoard{Add,Update,Delete}).
    useEffect(() => {
        const supabase = getSupabase();
        if (!supabase) return;
        // Private channel: receipt of board deltas (full element content) is authorized by the
        // op-visibility RLS policy on realtime.messages (owner / operations:manage / clearance+markers).
        const channel = supabase.channel(`op-board-${operation.id}`, { config: { private: true } });
        channel.on('broadcast' as any, { event: 'board_element_update' }, (payload: any) => {
            const d = payload.payload as {
                op: 'add' | 'update' | 'delete';
                element?: OperationBoardElement;
                elementId?: number;
                changes?: Partial<OperationBoardElement>;
                clientNonce?: string;
            };
            if (d.op === 'add' && d.element) {
                const element = d.element;
                if (d.clientNonce && pendingNoncesRef.current.has(d.clientNonce)) {
                    const optId = pendingNoncesRef.current.get(d.clientNonce)!;
                    pendingNoncesRef.current.delete(d.clientNonce);
                    setOptimisticElements(prev => prev.filter(el => el.id !== optId));
                }
                setLiveElements(prev => {
                    if (prev.has(element.id)) return prev;
                    const next = new Map(prev);
                    next.set(element.id, element);
                    return next;
                });
            } else if (d.op === 'update' && typeof d.elementId === 'number' && d.changes) {
                const id = d.elementId;
                if (localDraggingIdsRef.current.has(id)) return;
                const changes = d.changes;
                setLiveElements(prev => {
                    const existing = prev.get(id) ?? baseElementsRef.current.find(b => b.id === id);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(id, { ...existing, ...changes });
                    return next;
                });
            } else if (d.op === 'delete' && typeof d.elementId === 'number') {
                const id = d.elementId;
                setDeletedIds(prev => { const n = new Set(prev); n.add(id); return n; });
                setLiveElements(prev => {
                    if (!prev.has(id)) return prev;
                    const next = new Map(prev);
                    next.delete(id);
                    return next;
                });
                setSelectedIds(prev => {
                    if (!prev.has(id)) return prev;
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }
        });
        channel.subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [operation.id]);

    // Resize observer for stage
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
            }
        });
        observer.observe(el);
        setStageSize({ width: el.clientWidth, height: el.clientHeight });
        return () => observer.disconnect();
    }, []);

    // Attach transformer to every selected node so multi-select shows a frame
    // around each element. Konva's Transformer handles N nodes natively.
    useEffect(() => {
        if (!transformerRef.current || !stageRef.current) return;
        const stage = stageRef.current;
        const nodes = Array.from(selectedIds)
            .map(id => stage.findOne(`#el-${id}`))
            .filter(Boolean) as Konva.Node[];
        transformerRef.current.nodes(nodes);
        transformerRef.current.getLayer()?.batchDraw();
    }, [selectedIds, elements]);

    const getAutoName = useCallback((type: OperationBoardElement['elementType']) => {
        const count = elements.filter(e => e.elementType === type).length + 1;
        const names: Record<string, string> = { unit: 'Unit', waypoint: 'WP', ship: 'Ship', zone: 'Zone', line: 'Line', text: 'Text', icon: 'Marker' };
        return `${names[type] || type} ${count}`;
    }, [elements]);

    // Place element at canvas position. Snap applies to discrete placements
    // (units, waypoints, zones, lines) but NOT freehand strokes — snapping
    // pointed-clicked coords would be fine, but points within a freehand curve
    // should stay where they were drawn.
    const placeElement = useCallback(async (type: OperationBoardElement['elementType'], canvasX: number, canvasY: number, extraData?: Record<string, any>, dimensions?: { width?: number; height?: number }) => {
        const label = getAutoName(type);
        const elWidth = dimensions?.width ?? (type === 'zone' ? 150 : type === 'line' ? 200 : undefined);
        const elHeight = dimensions?.height ?? (type === 'zone' ? 100 : undefined);
        const isFreehand = !!extraData?.freehand;
        const posX = Math.round(isFreehand ? canvasX : snap(canvasX));
        const posY = Math.round(isFreehand ? canvasY : snap(canvasY));

        // Add optimistic element for instant feedback
        const optimisticId = nextOptimisticIdRef.current--;
        const clientNonce = cryptoUuid();
        pendingNoncesRef.current.set(clientNonce, optimisticId);
        setOptimisticElements(prev => [...prev, {
            id: optimisticId,
            operationId: operation.id,
            elementType: type,
            label,
            posX,
            posY,
            width: elWidth,
            height: elHeight,
            rotation: 0,
            color: toolColor,
            data: extraData || {},
            layer: 0,
            sortOrder: elementCountRef.current,
        } as OperationBoardElement]);

        setSaving(true);
        try {
            await rpcAction('operation:add_board_element', {
                operationId: operation.id,
                clientNonce,
                data: {
                    elementType: type,
                    label,
                    posX,
                    posY,
                    width: elWidth,
                    height: elHeight,
                    rotation: 0,
                    color: toolColor,
                    data: extraData || {},
                    layer: 0,
                    sortOrder: elementCountRef.current,
                },
            });
            onRefresh();
        } catch {
            // RPC failed — drop the placeholder and the dangling nonce so the
            // user isn't left with a phantom element.
            pendingNoncesRef.current.delete(clientNonce);
            setOptimisticElements(prev => prev.filter(el => el.id !== optimisticId));
        } finally {
            setSaving(false);
        }
    }, [rpcAction, operation.id, toolColor, getAutoName, onRefresh, snap]);

    const handleDeleteElement = useCallback(async (id: number) => {
        try {
            await rpcAction('operation:delete_board_element', { elementId: id, operationId: operation.id });
            setSelectedIds(prev => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            onRefresh();
        } catch { /* rpcAction already logs errors */ }
    }, [rpcAction, operation.id, onRefresh]);

    const handleMoveElement = useCallback(async (id: number, posX: number, posY: number, recordHistory: boolean = true) => {
        const before = elements.find(e => e.id === id);
        try {
            await rpcAction('operation:update_board_element', {
                elementId: id,
                data: { posX: Math.round(posX), posY: Math.round(posY) },
                operationId: operation.id,
            });
            if (recordHistory && before) {
                pushHistory({
                    op: 'move',
                    elementId: id,
                    before: { posX: before.posX, posY: before.posY },
                    after: { posX: Math.round(posX), posY: Math.round(posY) },
                });
            }
            onRefresh();
        } catch { /* rpcAction already logs errors */ }
    }, [rpcAction, operation.id, onRefresh, elements, pushHistory]);

    const handleUpdateElement = useCallback(async (id: number, data: Record<string, any>, recordHistory: boolean = true) => {
        const before = elements.find(e => e.id === id);
        setSavingEdit(true);
        try {
            await rpcAction('operation:update_board_element', { elementId: id, data, operationId: operation.id });
            if (recordHistory && before) {
                const beforeSnap: Partial<OperationBoardElement> = {};
                for (const key of Object.keys(data)) {
                    (beforeSnap as any)[key] = (before as any)[key];
                }
                pushHistory({ op: 'update', elementId: id, before: beforeSnap, after: data });
            }
            onRefresh();
        } catch { /* rpcAction already logs errors */ } finally {
            setSavingEdit(false);
        }
    }, [rpcAction, operation.id, onRefresh, elements, pushHistory]);

    // Undo: rewind the most recent tracked edit by replaying the `before` snapshot.
    // Skips history push on the replay itself (so the inverse doesn't re-enter history).
    const handleUndo = useCallback(async () => {
        const entry = historyRef.current.pop();
        if (!entry) return;
        futureRef.current.push(entry);
        if (entry.op === 'move' && entry.before.posX !== undefined && entry.before.posY !== undefined) {
            await handleMoveElement(entry.elementId, entry.before.posX as number, entry.before.posY as number, false);
        } else if (entry.op === 'update') {
            await handleUpdateElement(entry.elementId, entry.before, false);
        }
    }, [handleMoveElement, handleUpdateElement]);

    const handleRedo = useCallback(async () => {
        const entry = futureRef.current.pop();
        if (!entry) return;
        historyRef.current.push(entry);
        if (entry.op === 'move' && entry.after.posX !== undefined && entry.after.posY !== undefined) {
            await handleMoveElement(entry.elementId, entry.after.posX as number, entry.after.posY as number, false);
        } else if (entry.op === 'update') {
            await handleUpdateElement(entry.elementId, entry.after, false);
        }
    }, [handleMoveElement, handleUpdateElement]);

    // Delete everything in the current selection. Runs sequentially so errors
    // stop at the first failure (rest stay selected for retry).
    const handleDeleteSelected = useCallback(async () => {
        if (selectedIds.size === 0) return;
        const ids = Array.from(selectedIds);
        for (const id of ids) {
            try {
                await rpcAction('operation:delete_board_element', { elementId: id, operationId: operation.id });
            } catch { /* rpcAction already logs errors */ }
        }
        setSelectedIds(new Set());
        onRefresh();
    }, [rpcAction, operation.id, onRefresh, selectedIds]);

    // Duplicate the current selection offset by (15, 15). New elements get new
    // server IDs; we select them after the refresh lands.
    const handleDuplicateSelected = useCallback(async () => {
        if (selectedIds.size === 0) return;
        const toClone = elements.filter(e => selectedIds.has(e.id));
        for (const el of toClone) {
            try {
                await rpcAction('operation:add_board_element', {
                    operationId: operation.id,
                    data: {
                        elementType: el.elementType,
                        label: el.label,
                        posX: Math.round(el.posX + 15),
                        posY: Math.round(el.posY + 15),
                        width: el.width,
                        height: el.height,
                        rotation: el.rotation,
                        color: el.color,
                        data: el.data,
                        layer: el.layer,
                        sortOrder: el.sortOrder,
                    },
                });
            } catch { /* rpcAction already logs errors */ }
        }
        onRefresh();
    }, [rpcAction, operation.id, onRefresh, selectedIds, elements]);

    // Nudge every selected element by (dx, dy). Records ONE history entry per
    // element (mirrors how a drag works), so a 10-step nudge can be undone step
    // by step. With snap on, each arrow already moves one grid cell so we skip
    // the extra snap call.
    const handleNudgeSelected = useCallback(async (dx: number, dy: number) => {
        if (selectedIds.size === 0) return;
        const targets = elements.filter(e => selectedIds.has(e.id));
        for (const el of targets) {
            await handleMoveElement(el.id, el.posX + dx, el.posY + dy);
        }
    }, [selectedIds, elements, handleMoveElement]);

    // Copy: snapshot the currently selected elements to the in-memory clipboard.
    // Shallow clones are fine because paste creates new rows server-side.
    const handleCopySelected = useCallback(() => {
        if (selectedIds.size === 0) return;
        clipboardRef.current = elements.filter(e => selectedIds.has(e.id)).map(e => ({ ...e, data: { ...(e.data || {}) } }));
    }, [selectedIds, elements]);

    // Paste: insert clipboard elements offset by (15, 15), then select the new
    // ones so the user can immediately move them as a group. Sequential calls
    // give us the server-assigned IDs to re-select.
    const handlePaste = useCallback(async () => {
        const clip = clipboardRef.current;
        if (!clip.length || !canManage) return;
        const newIds: number[] = [];
        for (const el of clip) {
            try {
                const result: any = await rpcAction('operation:add_board_element', {
                    operationId: operation.id,
                    data: {
                        elementType: el.elementType,
                        label: el.label,
                        posX: Math.round(el.posX + 15),
                        posY: Math.round(el.posY + 15),
                        width: el.width,
                        height: el.height,
                        rotation: el.rotation,
                        color: el.color,
                        data: el.data,
                        layer: el.layer,
                        sortOrder: el.sortOrder,
                    },
                });
                // RPC returns the DB row — map the numeric id if present so the
                // pasted group can be selected without a round-trip.
                const newId = Number(result?.id);
                if (Number.isFinite(newId) && newId > 0) newIds.push(newId);
            } catch { /* rpcAction already logs errors */ }
        }
        if (newIds.length > 0) setSelectedIds(new Set(newIds));
        onRefresh();
    }, [canManage, rpcAction, operation.id, onRefresh]);

    // Select a single element (clears any existing selection). Passing null
    // clears the selection entirely.
    const selectElement = useCallback((id: number | null) => {
        if (id === null) {
            setSelectedIds(new Set());
            return;
        }
        setSelectedIds(new Set([id]));
        const el = elements.find(e => e.id === id);
        if (el) {
            setEditLabel(el.label || '');
            setEditColor(el.color || ELEMENT_ICONS[el.elementType]?.color || '#3b82f6');
        }
    }, [elements]);

    // Shift-click: add or remove from current selection.
    const toggleSelectElement = useCallback((id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const sortedElements = useMemo(() => [...elements, ...optimisticElements].sort((a, b) => a.layer - b.layer || a.sortOrder - b.sortOrder), [elements, optimisticElements]);


    const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
        e.evt.preventDefault();
        const stage = stageRef.current;
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const oldZoom = zoomRef.current;
        const pos = stagePosRef.current;
        const delta = e.evt.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.min(Math.max(oldZoom * delta, 0.2), 3.0);
        const mousePointTo = { x: (pointer.x - pos.x) / oldZoom, y: (pointer.y - pos.y) / oldZoom };
        commitZoom(newZoom);
        commitStagePos({ x: pointer.x - mousePointTo.x * newZoom, y: pointer.y - mousePointTo.y * newZoom });
    }, [commitZoom, commitStagePos]);

    const handleStageClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
        // If clicked on empty area of stage
        if (e.target === e.target.getStage()) {
            // Zone and line tools use drag-to-create (handled by mouseDown/Up)
            if (activeTool && activeTool !== 'draw' && activeTool !== 'zone' && activeTool !== 'line' && canManage) {
                const stage = stageRef.current;
                if (!stage) return;
                const pointer = stage.getPointerPosition();
                if (!pointer) return;
                const pos = stagePosRef.current;
                const z = zoomRef.current;
                const canvasX = (pointer.x - pos.x) / z;
                const canvasY = (pointer.y - pos.y) / z;
                placeElement(activeTool as OperationBoardElement['elementType'], canvasX, canvasY);
            } else if (!activeTool) {
                selectElement(null);
            }
        }
    }, [activeTool, canManage, placeElement, selectElement]);

    const handleStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
        if (e.target !== e.target.getStage()) return;
        const stage = stageRef.current;
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const pos = stagePosRef.current;
        const z = zoomRef.current;
        const x = (pointer.x - pos.x) / z;
        const y = (pointer.y - pos.y) / z;

        // Shift+drag on empty stage starts a rubber-band selection — works in
        // any mode (including when no tool is active), and doesn't require
        // canManage since selection itself is read-only.
        if (e.evt.shiftKey && !activeTool) {
            rubberStartRef.current = { x, y };
            rubberRectRef.current = { x, y, w: 0, h: 0 };
            setRubberRect({ x, y, w: 0, h: 0 });
            return;
        }

        if (!canManage) return;

        if (activeTool === 'draw') {
            isDrawingRef.current = true;
            drawingPointsRef.current = [x, y];
            drawingFrameRef.current = 0;
            setDrawingPoints([x, y]);
        } else if (activeTool === 'zone' || activeTool === 'line') {
            drawStartRef.current = { x, y };
            isDraggingShapeRef.current = false;
        }
    }, [activeTool, canManage]);

    const handleStageMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
        const stage = stageRef.current;
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const pos = stagePosRef.current;
        const z = zoomRef.current;
        const x = (pointer.x - pos.x) / z;
        const y = (pointer.y - pos.y) / z;

        // Rubber-band rectangle update
        if (rubberStartRef.current) {
            const start = rubberStartRef.current;
            const nextRect = {
                x: Math.min(start.x, x),
                y: Math.min(start.y, y),
                w: Math.abs(x - start.x),
                h: Math.abs(y - start.y),
            };
            rubberRectRef.current = nextRect;
            setRubberRect(nextRect);
            return;
        }

        // Freehand draw — accumulate in ref, flush to state every 3rd point for smooth preview
        if (isDrawingRef.current) {
            drawingPointsRef.current.push(x, y);
            drawingFrameRef.current++;
            if (drawingFrameRef.current % 3 === 0) {
                setDrawingPoints([...drawingPointsRef.current]);
            }
            return;
        }

        // Zone/Line drag preview
        if (drawStartRef.current && (activeTool === 'zone' || activeTool === 'line')) {
            const dx = x - drawStartRef.current.x;
            const dy = y - drawStartRef.current.y;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDraggingShapeRef.current = true;
            setDrawPreview({
                x: Math.min(drawStartRef.current.x, x),
                y: Math.min(drawStartRef.current.y, y),
                w: dx,
                h: dy,
                sx: drawStartRef.current.x,
                sy: drawStartRef.current.y,
            });
        }
    }, [activeTool]);

    const handleStageMouseUp = useCallback(async (e: Konva.KonvaEventObject<MouseEvent>) => {
        // Rubber-band end — collect elements whose bounding box intersects the rect
        if (rubberStartRef.current) {
            const rect = rubberRectRef.current;
            rubberStartRef.current = null;
            rubberRectRef.current = null;
            setRubberRect(null);
            if (rect && (rect.w > 3 || rect.h > 3)) {
                const hits = new Set<number>();
                for (const el of elementsRef.current) {
                    const elW = el.width ?? 30;
                    const elH = el.height ?? 30;
                    // For point-style elements (unit/waypoint/ship/icon/text) use a small
                    // hit box around pos. For zones/lines with explicit dims use those.
                    const ax = el.posX;
                    const ay = el.posY;
                    const bx = ax + elW;
                    const by = ay + elH;
                    const intersects = !(bx < rect.x || ax > rect.x + rect.w || by < rect.y || ay > rect.y + rect.h);
                    if (intersects) hits.add(el.id);
                }
                // Shift-drag adds to existing selection; plain drag replaces.
                setSelectedIds(prev => {
                    if (e.evt?.shiftKey) {
                        const next = new Set(prev);
                        for (const id of hits) next.add(id);
                        return next;
                    }
                    return hits;
                });
            }
            return;
        }

        // Freehand draw end
        if (isDrawingRef.current) {
            isDrawingRef.current = false;
            const rawPoints = drawingPointsRef.current;
            drawingPointsRef.current = [];
            if (rawPoints.length >= 4) {
                const simplified = simplifyPoints(rawPoints);
                const minX = Math.min(...simplified.filter((_, i) => i % 2 === 0));
                const minY = Math.min(...simplified.filter((_, i) => i % 2 === 1));
                const normalizedPoints = simplified.map((v, i) => i % 2 === 0 ? v - minX : v - minY);
                await placeElement('line', minX, minY, { points: normalizedPoints, freehand: true });
            }
            setDrawingPoints([]);
            return;
        }

        // Zone/Line drag-to-create end
        if (drawStartRef.current && (activeTool === 'zone' || activeTool === 'line')) {
            const start = drawStartRef.current;
            const wasDragging = isDraggingShapeRef.current;

            // Get final pointer position
            const stage = stageRef.current;
            const pointer = stage?.getPointerPosition();
            const pos = stagePosRef.current;
            const z = zoomRef.current;
            const endX = pointer ? (pointer.x - pos.x) / z : start.x;
            const endY = pointer ? (pointer.y - pos.y) / z : start.y;

            drawStartRef.current = null;
            isDraggingShapeRef.current = false;
            setDrawPreview(null);

            if (!wasDragging) {
                // Single click fallback - place with default fixed size
                placeElement(activeTool as OperationBoardElement['elementType'], start.x, start.y);
            } else if (activeTool === 'zone') {
                const w = Math.abs(endX - start.x);
                const h = Math.abs(endY - start.y);
                if (w >= 20 && h >= 20) {
                    const posX = Math.min(start.x, endX);
                    const posY = Math.min(start.y, endY);
                    placeElement('zone', posX, posY, {}, { width: Math.round(w), height: Math.round(h) });
                }
            } else if (activeTool === 'line') {
                const dx = Math.round(endX - start.x);
                const dy = Math.round(endY - start.y);
                placeElement('line', start.x, start.y, { points: [0, 0, dx, dy] });
            }
        }
    }, [placeElement, activeTool]);

    // Mark id as locally-controlled so remote `update` deltas mid-drag are
    // dropped instead of yanking the element away from the user's cursor.
    const handleDragStart = useCallback((elId: number) => {
        if (!canManage) return;
        localDraggingIdsRef.current.add(elId);
    }, [canManage]);

    const handleDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>, elId: number) => {
        if (!canManage) return;
        const node = e.target;
        const nx = snap(node.x());
        const ny = snap(node.y());
        // If snap rounded the visual position, reflect it on the Konva node
        // immediately so the element doesn't flicker before the server refresh.
        if (snapEnabled && (nx !== node.x() || ny !== node.y())) {
            node.position({ x: nx, y: ny });
        }
        localDraggingIdsRef.current.delete(elId);
        handleMoveElement(elId, nx, ny);
    }, [canManage, handleMoveElement, snap, snapEnabled]);

    const handleElementClick = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, elId: number) => {
        e.cancelBubble = true;
        const shift = (e.evt as MouseEvent | TouchEvent).shiftKey;
        if (shift) toggleSelectElement(elId);
        else selectElement(elId);
    }, [selectElement, toggleSelectElement]);

    // Keyboard handler on wrapper div — multi-select aware.
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        // Cancel tools and clear state with Escape
        if (e.key === 'Escape') {
            setActiveTool(null);
            selectElement(null);
            isDrawingRef.current = false;
            setDrawingPoints([]);
            drawStartRef.current = null;
            isDraggingShapeRef.current = false;
            setDrawPreview(null);
            rubberStartRef.current = null;
            rubberRectRef.current = null;
            setRubberRect(null);
            return;
        }

        // Delete / Backspace: remove every selected element
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0 && canManage) {
            e.preventDefault();
            handleDeleteSelected();
            return;
        }

        // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            if (!canManage) return;
            e.preventDefault();
            handleUndo();
            return;
        }
        if (mod && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) {
            if (!canManage) return;
            e.preventDefault();
            handleRedo();
            return;
        }

        // Ctrl/Cmd+D: duplicate selection
        if (mod && e.key.toLowerCase() === 'd' && selectedIds.size > 0 && canManage) {
            e.preventDefault();
            handleDuplicateSelected();
            return;
        }

        // Ctrl/Cmd+C: copy selection to clipboard
        if (mod && e.key.toLowerCase() === 'c' && selectedIds.size > 0) {
            // Don't preventDefault — let browsers still capture copy for text selection
            // if the focus has drifted. Our clipboard is in-memory anyway.
            handleCopySelected();
            return;
        }

        // Ctrl/Cmd+V: paste clipboard (if any)
        if (mod && e.key.toLowerCase() === 'v' && clipboardRef.current.length > 0 && canManage) {
            e.preventDefault();
            handlePaste();
            return;
        }

        // Arrow-key nudge. With snap on, move one grid cell per keystroke
        // (large) or half a cell with Shift (fine). Off-snap: 1px / 10px.
        if (selectedIds.size > 0 && canManage && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const step = snapEnabled
                ? (e.shiftKey ? GRID_SIZE / 2 : GRID_SIZE)
                : (e.shiftKey ? 10 : 1);
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            handleNudgeSelected(dx, dy);
        }
    }, [selectElement, selectedIds, canManage, handleDeleteSelected, handleUndo, handleRedo, handleDuplicateSelected, handleNudgeSelected, handleCopySelected, handlePaste, snapEnabled, GRID_SIZE]);

    // Determine if stage is draggable (pan mode with no active tool)
    const isDraggable = !activeTool;

    // Grid lines generation — tied to GRID_SIZE so the visual overlay matches
    // the snap grid exactly.
    const gridLines = useMemo(() => {
        const lines: { points: number[]; key: string }[] = [];
        const startX = Math.floor((-stagePos.x / zoom - GRID_SIZE) / GRID_SIZE) * GRID_SIZE;
        const endX = Math.ceil((-stagePos.x / zoom + stageSize.width / zoom + GRID_SIZE) / GRID_SIZE) * GRID_SIZE;
        const startY = Math.floor((-stagePos.y / zoom - GRID_SIZE) / GRID_SIZE) * GRID_SIZE;
        const endY = Math.ceil((-stagePos.y / zoom + stageSize.height / zoom + GRID_SIZE) / GRID_SIZE) * GRID_SIZE;
        for (let x = startX; x <= endX; x += GRID_SIZE) {
            lines.push({ points: [x, startY, x, endY], key: `v-${x}` });
        }
        for (let y = startY; y <= endY; y += GRID_SIZE) {
            lines.push({ points: [startX, y, endX, y], key: `h-${y}` });
        }
        return lines;
    }, [stagePos, zoom, stageSize, GRID_SIZE]);

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            {canManage && (
                <div className="shrink-0 px-3 py-2 bg-slate-900/80 border-b border-slate-700/30 flex items-center gap-1.5 flex-wrap">
                    {/* Pan/Select tool */}
                    <button onClick={() => setActiveTool(null)}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${!activeTool ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-slate-500 hover:text-white hover:bg-slate-800 border border-transparent'}`}
                        title="Pan & Select (Esc)">
                        <i className="fa-solid fa-hand text-xs"></i>
                    </button>
                    <div className="w-px h-6 bg-slate-700/60 mx-0.5"></div>
                    {/* Element tools */}
                    {ELEMENT_TOOLS.map(tool => (
                        <button key={tool.type} onClick={() => setActiveTool(activeTool === tool.type ? null : tool.type)}
                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${activeTool === tool.type ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-xs shadow-purple-900/20' : 'text-slate-500 hover:text-white hover:bg-slate-800 border border-transparent'}`}
                            title={`Place ${tool.label}`}>
                            <i className={`${tool.icon} text-xs`}></i>
                        </button>
                    ))}
                    <div className="w-px h-6 bg-slate-700/60 mx-0.5"></div>
                    {/* Freehand Draw tool */}
                    <button onClick={() => setActiveTool(activeTool === 'draw' ? null : 'draw')}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${activeTool === 'draw' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-xs shadow-purple-900/20' : 'text-slate-500 hover:text-white hover:bg-slate-800 border border-transparent'}`}
                        title="Freehand Draw">
                        <i className="fa-solid fa-pencil text-xs"></i>
                    </button>
                    <div className="w-px h-6 bg-slate-700/60 mx-0.5"></div>
                    {/* Color picker */}
                    <div className="relative" title="Element color">
                        <input type="color" value={toolColor} onChange={e => setToolColor(e.target.value)}
                            className="w-8 h-8 rounded-lg cursor-pointer bg-transparent border border-slate-700/50 p-0.5" />
                    </div>
                    <div className="w-px h-6 bg-slate-700/60 mx-0.5"></div>
                    {/* Snap-to-grid toggle */}
                    <button onClick={() => setSnapEnabled(v => !v)}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${snapEnabled ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-slate-500 hover:text-white hover:bg-slate-800 border border-transparent'}`}
                        title={snapEnabled ? 'Snap to grid · ON' : 'Snap to grid · OFF'}>
                        <i className="fa-solid fa-border-all text-xs"></i>
                    </button>
                    <div className="flex-1"></div>
                    {/* Status */}
                    <span className="text-[9px] text-slate-600 font-mono">
                        {activeTool === 'draw' ? <span className="text-purple-300">Draw freehand · Esc to cancel</span> :
                         (activeTool === 'zone' || activeTool === 'line') ? <span className="text-purple-300">Drag to draw {activeTool}</span> :
                         activeTool ? <span className="text-purple-300">Click to place {activeTool}</span> : `${Math.round(zoom * 100)}%`}
                        {saving && <i className="fa-solid fa-spinner animate-spin ml-2 text-purple-300"></i>}
                        {selectedIds.size > 0 && (
                            <span className="ml-2 text-sky-300">{selectedIds.size} selected</span>
                        )}
                        <span className="ml-2 text-slate-700">{elements.length} el</span>
                        {snapEnabled && <span className="ml-2 text-sky-400">snap {GRID_SIZE}px</span>}
                        <span className="ml-2 text-slate-700 hidden lg:inline">· Shift+drag select · ⌫ del · ⌘Z undo · ⌘C/V copy · ⌘D dup · ↑↓←→ nudge</span>
                    </span>
                </div>
            )}

            {/* Canvas + Properties panel side-by-side */}
            <div className="flex-1 min-h-0 flex overflow-hidden">
                {/* Canvas */}
                <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden bg-slate-950"
                    onKeyDown={handleKeyDown} tabIndex={0}
                    style={{ cursor: activeTool === 'draw' ? 'crosshair' : activeTool ? 'crosshair' : 'grab' }}>

                    {/* Tool mode indicator */}
                    {activeTool && (
                        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-purple-500/10 border border-purple-500/30 text-purple-300 text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg backdrop-blur-xs flex items-center gap-2 pointer-events-none animate-pulse">
                            {activeTool === 'draw' ? (
                                <><i className="fa-solid fa-pencil"></i> Click & drag to draw · Esc to cancel</>
                            ) : activeTool === 'zone' || activeTool === 'line' ? (
                                <><i className={`${ELEMENT_ICONS[activeTool]?.icon}`}></i> Click to place or drag to size · Esc to cancel</>
                            ) : (
                                <><i className={`${ELEMENT_ICONS[activeTool]?.icon}`}></i> Click to place · Esc to cancel</>
                            )}
                        </div>
                    )}

                    <Stage
                        ref={stageRef}
                        width={stageSize.width}
                        height={stageSize.height}
                        scaleX={zoom}
                        scaleY={zoom}
                        x={stagePos.x}
                        y={stagePos.y}
                        draggable={isDraggable}
                        onDragStart={(e) => {
                            // If a rubber-band selection is in progress, block the stage
                            // from panning at the same time — shift-drag should select, not pan.
                            if (rubberStartRef.current && e.target === stageRef.current) {
                                e.target.stopDrag();
                            }
                        }}
                        onDragEnd={(e) => {
                            if (e.target === stageRef.current) {
                                commitStagePos({ x: e.target.x(), y: e.target.y() });
                            }
                        }}
                        onWheel={handleWheel}
                        onClick={handleStageClick}
                        onMouseDown={handleStageMouseDown}
                        onMouseMove={handleStageMouseMove}
                        onMouseUp={handleStageMouseUp}
                    >
                        {/* Grid Layer — brighter when snap is active so the user sees what they'll snap to */}
                        <Layer listening={false}>
                            {gridLines.map(l => (
                                <Line key={l.key} points={l.points} stroke="#38bdf8" strokeWidth={0.5 / zoom} opacity={snapEnabled ? 0.18 : 0.05} />
                            ))}
                        </Layer>

                        {/* Elements Layer */}
                        <Layer>
                            {sortedElements.map(el => {
                                const cfg = ELEMENT_ICONS[el.elementType] || ELEMENT_ICONS.icon;
                                const color = el.color || cfg.color;
                                const isSelected = selectedIds.has(el.id);

                                // Zone: dashed rectangle
                                if (el.elementType === 'zone' && el.width && el.height) {
                                    return (
                                        <Group key={el.id} id={`el-${el.id}`}
                                            x={el.posX} y={el.posY}
                                            draggable={canManage}
                                            onDragStart={() => handleDragStart(el.id)} onDragEnd={(e) => handleDragEnd(e, el.id)}
                                            onClick={(e) => handleElementClick(e, el.id)}
                                            onTap={(e) => handleElementClick(e, el.id)}>
                                            <Rect width={el.width} height={el.height}
                                                stroke={color + '60'} strokeWidth={2}
                                                dash={[8, 4]}
                                                fill={color + '10'}
                                                cornerRadius={8}
                                                rotation={el.rotation || 0} />
                                            {el.label && (
                                                <KonvaText text={el.label} fill={color}
                                                    fontSize={10} fontStyle="bold"
                                                    width={el.width} align="center"
                                                    y={(el.height || 0) / 2 - 5} />
                                            )}
                                            {isSelected && (
                                                <Rect width={el.width} height={el.height}
                                                    stroke="#38bdf8" strokeWidth={2} opacity={0.5}
                                                    cornerRadius={8} listening={false} />
                                            )}
                                        </Group>
                                    );
                                }

                                // Line (freehand, dragged, or straight)
                                if (el.elementType === 'line') {
                                    const hasCustomPoints = el.data?.points && Array.isArray(el.data.points) && el.data.points.length >= 4;
                                    const isFreehand = !!el.data?.freehand;
                                    const linePoints = hasCustomPoints
                                        ? el.data.points as number[]
                                        : [0, 0, el.width || 200, 0];
                                    return (
                                        <Group key={el.id} id={`el-${el.id}`}
                                            x={el.posX} y={el.posY}
                                            draggable={canManage}
                                            onDragStart={() => handleDragStart(el.id)} onDragEnd={(e) => handleDragEnd(e, el.id)}
                                            onClick={(e) => handleElementClick(e, el.id)}
                                            onTap={(e) => handleElementClick(e, el.id)}>
                                            <Line points={linePoints}
                                                stroke={color}
                                                strokeWidth={isFreehand ? 3 : 2}
                                                lineCap="round" lineJoin="round"
                                                tension={isFreehand ? 0.5 : 0}
                                                hitStrokeWidth={12}
                                                rotation={el.rotation || 0} />
                                            {el.label && !isFreehand && (
                                                <KonvaText text={el.label} fill={color}
                                                    fontSize={9} fontStyle="bold"
                                                    x={(el.width || 200) + 8} y={-4} />
                                            )}
                                            {isSelected && (
                                                <Line points={linePoints}
                                                    stroke="#38bdf8" strokeWidth={isFreehand ? 5 : 4}
                                                    opacity={0.3} lineCap="round" lineJoin="round"
                                                    tension={isFreehand ? 0.5 : 0} listening={false} />
                                            )}
                                        </Group>
                                    );
                                }

                                // Text element
                                if (el.elementType === 'text') {
                                    return (
                                        <Group key={el.id} id={`el-${el.id}`}
                                            x={el.posX} y={el.posY}
                                            draggable={canManage}
                                            onDragStart={() => handleDragStart(el.id)} onDragEnd={(e) => handleDragEnd(e, el.id)}
                                            onClick={(e) => handleElementClick(e, el.id)}
                                            onTap={(e) => handleElementClick(e, el.id)}>
                                            <KonvaText text={el.label || 'Text'} fill={color}
                                                fontSize={14} fontStyle="bold"
                                                rotation={el.rotation || 0} />
                                            {isSelected && (
                                                <Rect x={-3} y={-3}
                                                    width={((el.label || 'Text').length * 8) + 6}
                                                    height={20}
                                                    stroke="#38bdf8" strokeWidth={1.5} opacity={0.5}
                                                    cornerRadius={3} listening={false} />
                                            )}
                                        </Group>
                                    );
                                }

                                // Default: marker-style element (unit, waypoint, ship, icon)
                                const symbol = ELEMENT_SYMBOLS[el.elementType] || '\u2605';
                                return (
                                    <Group key={el.id} id={`el-${el.id}`}
                                        x={el.posX} y={el.posY}
                                        draggable={canManage}
                                        onDragStart={() => handleDragStart(el.id)} onDragEnd={(e) => handleDragEnd(e, el.id)}
                                        onClick={(e) => handleElementClick(e, el.id)}
                                        onTap={(e) => handleElementClick(e, el.id)}>
                                        {/* Outer glow */}
                                        <Circle radius={22}
                                            fill={color + '20'}
                                            stroke={color + '80'}
                                            strokeWidth={isSelected ? 3 : 2} />
                                        {/* Symbol */}
                                        <KonvaText text={symbol}
                                            fontSize={16} fill={color}
                                            offsetX={8} offsetY={8}
                                            fontStyle="bold" />
                                        {/* Label below */}
                                        {el.label && (
                                            <>
                                                <Rect x={-(Math.max(el.label.length * 5, 20)) / 2} y={26}
                                                    width={Math.max(el.label.length * 5, 20)}
                                                    height={14}
                                                    fill={isSelected ? '#0c4a6e' : 'rgba(0,0,0,0.6)'}
                                                    cornerRadius={3}
                                                    stroke={isSelected ? '#38bdf8' : undefined}
                                                    strokeWidth={isSelected ? 1 : 0} />
                                                <KonvaText text={el.label}
                                                    fontSize={9} fontStyle="bold" fill="white"
                                                    y={28}
                                                    offsetX={(el.label.length * 4.5) / 2}
                                                    align="center" />
                                            </>
                                        )}
                                        {isSelected && (
                                            <Circle radius={26}
                                                stroke="#38bdf8" strokeWidth={2} opacity={0.6}
                                                listening={false} />
                                        )}
                                    </Group>
                                );
                            })}
                        </Layer>

                        {/* Drawing Layer - current freehand stroke + drag-to-create preview */}
                        <Layer listening={false}>
                            {drawingPoints.length >= 4 && (
                                <Line points={drawingPoints}
                                    stroke={toolColor}
                                    strokeWidth={3}
                                    lineCap="round" lineJoin="round"
                                    tension={0.5}
                                    opacity={0.8} />
                            )}
                            {drawPreview && activeTool === 'zone' && (
                                <Rect
                                    x={drawPreview.x}
                                    y={drawPreview.y}
                                    width={Math.abs(drawPreview.w)}
                                    height={Math.abs(drawPreview.h)}
                                    stroke={toolColor}
                                    strokeWidth={2}
                                    dash={[8, 4]}
                                    fill={toolColor + '10'}
                                    cornerRadius={8}
                                    opacity={0.8} />
                            )}
                            {drawPreview && activeTool === 'line' && (
                                <Line
                                    points={[drawPreview.sx, drawPreview.sy, drawPreview.sx + drawPreview.w, drawPreview.sy + drawPreview.h]}
                                    stroke={toolColor}
                                    strokeWidth={2}
                                    dash={[8, 4]}
                                    lineCap="round"
                                    opacity={0.8} />
                            )}
                            {rubberRect && (rubberRect.w > 0 || rubberRect.h > 0) && (
                                <Rect
                                    x={rubberRect.x}
                                    y={rubberRect.y}
                                    width={rubberRect.w}
                                    height={rubberRect.h}
                                    stroke="#38bdf8"
                                    strokeWidth={1.5 / zoom}
                                    dash={[4, 4]}
                                    fill="#38bdf820"
                                />
                            )}
                        </Layer>

                        {/* Transformer Layer */}
                        <Layer>
                            <Transformer ref={transformerRef}
                                rotateEnabled={false}
                                enabledAnchors={[]}
                                borderStroke="#38bdf8"
                                borderStrokeWidth={2}
                                borderDash={[4, 4]} />
                        </Layer>
                    </Stage>

                    {/* Empty state */}
                    {elements.length === 0 && !activeTool && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="text-center text-slate-600">
                                <i className="fa-solid fa-map text-4xl mb-3 opacity-30"></i>
                                <p className="text-sm font-medium opacity-50">Tactical Board</p>
                                <p className="text-xs opacity-40">{canManage ? 'Select a tool from the toolbar and click to place elements.' : 'No tactical elements placed.'}</p>
                            </div>
                        </div>
                    )}

                    {/* Zoom Controls */}
                    <div className="absolute bottom-3 right-3 bg-slate-900/90 border border-slate-700/50 rounded-lg backdrop-blur-xs p-1 flex flex-col gap-1 z-10">
                        <button onClick={() => commitZoom(z => Math.min(z * 1.2, 3.0))} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 rounded-sm transition-colors text-sm" title="Zoom In">
                            <i className="fa-solid fa-plus"></i>
                        </button>
                        <button onClick={() => commitZoom(z => Math.max(z * 0.8, 0.2))} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 rounded-sm transition-colors text-sm" title="Zoom Out">
                            <i className="fa-solid fa-minus"></i>
                        </button>
                        <div className="border-t border-slate-700/50 my-0.5"></div>
                        <button onClick={() => { commitStagePos({ x: 0, y: 0 }); commitZoom(1.0); }} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 rounded-sm transition-colors text-sm" title="Reset View">
                            <i className="fa-solid fa-expand"></i>
                        </button>
                    </div>
                </div>

                {/* Properties Panel (right sidebar when element selected) */}
                {selectedElement && (
                    <div className="w-56 shrink-0 bg-slate-900/80 border-l border-slate-700/30 overflow-y-auto custom-scrollbar">
                        <div className="p-3 border-b border-slate-700/30 flex items-center justify-between">
                            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest">Properties</p>
                            <button onClick={() => selectElement(null)} className="text-slate-600 hover:text-white text-xs"><i className="fa-solid fa-xmark"></i></button>
                        </div>
                        <div className="p-3 space-y-3">
                            <div>
                                <label className="text-[9px] text-slate-500 uppercase font-bold tracking-wider block mb-1">Type</label>
                                <div className="flex items-center gap-2 text-xs text-slate-300">
                                    <i className={`${ELEMENT_ICONS[selectedElement.elementType]?.icon}`} style={{ color: selectedElement.color || ELEMENT_ICONS[selectedElement.elementType]?.color }}></i>
                                    <span className="capitalize font-bold">{selectedElement.elementType}</span>
                                </div>
                            </div>
                            <div>
                                <label className="text-[9px] text-slate-500 uppercase font-bold tracking-wider block mb-1">Label</label>
                                <input type="text" value={editLabel} onChange={e => setEditLabel(e.target.value)}
                                    onBlur={() => { if (editLabel !== (selectedElement.label || '')) handleUpdateElement(selectedElement.id, { label: editLabel }); }}
                                    onKeyDown={e => { if (e.key === 'Enter') handleUpdateElement(selectedElement.id, { label: editLabel }); }}
                                    className="w-full bg-black/20 border border-slate-700/50 text-white text-sm rounded-lg px-3 py-2.5 outline-hidden focus:border-purple-500/40 focus:ring-1 focus:ring-purple-500/30 transition-all" />
                            </div>
                            <div>
                                <label className="text-[9px] text-slate-500 uppercase font-bold tracking-wider block mb-1">Color</label>
                                <div className="flex items-center gap-2">
                                    <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)}
                                        onBlur={() => { if (editColor !== (selectedElement.color || '')) handleUpdateElement(selectedElement.id, { color: editColor }); }}
                                        className="w-8 h-8 rounded-sm cursor-pointer bg-transparent border border-slate-700/50 p-0.5" />
                                    <span className="text-[10px] font-mono text-slate-500">{editColor}</span>
                                </div>
                            </div>
                            <div>
                                <label className="text-[9px] text-slate-500 uppercase font-bold tracking-wider block mb-1">Position</label>
                                <p className="text-[10px] font-mono text-slate-400">
                                    X: {Math.round(selectedElement.posX)} · Y: {Math.round(selectedElement.posY)}
                                </p>
                            </div>
                            {savingEdit && <p className="text-[9px] text-purple-300"><i className="fa-solid fa-spinner animate-spin mr-1"></i>Saving...</p>}
                            {canManage && (
                                <div className="pt-2 border-t border-slate-700/30">
                                    <button onClick={() => handleDeleteElement(selectedElement.id)}
                                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-[10px] font-bold uppercase tracking-wider hover:bg-red-500/20 transition-colors">
                                        <i className="fa-solid fa-trash"></i> Delete Element
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

const OpCommandSignalsTab: React.FC<OpCommandSignalsTabProps> = ({ operation, canManage, isParticipant, onRefresh }) => {
    const { updateOperationDetails } = useOperations();
    const [subTab, setSubTab] = useState<SubTab>('comms-plan');

    const subTabs: { key: SubTab; label: string; icon: string }[] = [
        { key: 'comms-plan', label: 'Comms Plan', icon: 'fa-solid fa-tower-broadcast' },
        { key: 'tactical-board', label: 'Tactical Board', icon: 'fa-solid fa-map' },
        { key: 'ops-log', label: 'Ops Log', icon: 'fa-solid fa-timeline' },
    ];

    return (
        <div className="flex flex-col h-full">
            {/* Sub-tab bar */}
            <div className="shrink-0 px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
                <div className="flex items-center justify-between gap-4">
                    <p className="text-[10px] text-slate-500 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                        <i className="fa-solid fa-tower-broadcast text-purple-400/70"></i> Command & Signals
                    </p>
                    <div className="flex items-center gap-1 bg-slate-800/60 border border-slate-700/40 rounded-lg p-0.5">
                        {subTabs.map(tab => (
                            <button key={tab.key} onClick={() => setSubTab(tab.key)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${
                                    subTab === tab.key ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'
                                }`}>
                                <i className={tab.icon}></i> {tab.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Sub-tab content */}
            <div className="flex-1 min-h-0 overflow-hidden">
                {subTab === 'comms-plan' && (
                    <div className="h-full overflow-y-auto custom-scrollbar">
                        <CommsPlanSection
                            operation={operation}
                            canManage={canManage}
                            onUpdate={async (commsPlan) => {
                                // Persist + refresh both the operations list (for realtime
                                // siblings) AND this op's detail fetch so the row appears
                                // immediately without waiting on a postgres_changes echo.
                                await updateOperationDetails(operation.id, { commsPlan });
                                onRefresh();
                            }}
                        />
                    </div>
                )}

                {subTab === 'tactical-board' && (
                    <TacticalBoard
                        operation={operation}
                        canManage={canManage}
                        onRefresh={onRefresh}
                    />
                )}

                {subTab === 'ops-log' && (
                    <OpCommsTab
                        operation={operation}
                        canManage={canManage}
                        isParticipant={isParticipant}
                        onRefresh={onRefresh}
                    />
                )}
            </div>
        </div>
    );
};

export default OpCommandSignalsTab;
