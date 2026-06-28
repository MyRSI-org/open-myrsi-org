import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { TabPageHeader } from '../../shared/ui';
import { AlliancePeer, AllianceSelfProfile, AllianceType, TrustedIntelFeed } from '../../../types';

const TYPE_OPTIONS: AllianceType[] = ['Alliance' as AllianceType, 'Neutral' as AllianceType, 'Rivalry' as AllianceType];

const statusClass = (status: string) => {
    switch (status) {
        case 'Active': return 'bg-green-500/15 text-green-400 border-green-500/30';
        case 'Pending': return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
        case 'Dissolved': return 'bg-red-500/15 text-red-400 border-red-500/30';
        default: return 'bg-slate-600/20 text-slate-400 border-slate-600/40';
    }
};

// Live-sync health badge (alliance_peers.sync_health, maintained by the
// engine's peer-health state machine).
const SYNC_BADGES: Record<string, { cls: string; icon: string; label: string }> = {
    healthy: { cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', icon: 'fa-signal', label: 'Sync OK' },
    degraded: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30', icon: 'fa-triangle-exclamation', label: 'Degraded' },
    down: { cls: 'bg-red-500/15 text-red-400 border-red-500/30', icon: 'fa-plug-circle-xmark', label: 'Down' },
};

const AllianceManagementTab: React.FC = () => {
    const { rpcAction } = useData();
    const { hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { confirm } = useNotification();

    const canManage = hasPermission('alliance:manage');

    const [peers, setPeers] = useState<AlliancePeer[]>([]);
    const [profile, setProfile] = useState<AllianceSelfProfile>({ orgName: '', directoryVisible: false });
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    // Pairing code
    const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: string } | null>(null);

    // Add-partner form
    const [newLabel, setNewLabel] = useState('');
    const [newUrl, setNewUrl] = useState('');
    const [newCode, setNewCode] = useState('');
    const [newType, setNewType] = useState<AllianceType>('Alliance' as AllianceType);

    // Receive-only feeds: one-way intel subscriptions (alliance_peers rows with
    // pairing_state 'manual'/'legacy'). Different setup from a handshake ally — no code
    // swap; we just hold the peer's API key to pull. Pulling runs in Intel → Feed Ingest.
    const [feeds, setFeeds] = useState<TrustedIntelFeed[]>([]);
    const [newFeedLabel, setNewFeedLabel] = useState('');
    const [newFeedUrl, setNewFeedUrl] = useState('');
    const [newFeedKey, setNewFeedKey] = useState('');

    const flash = useCallback((kind: 'ok' | 'err', text: string) => {
        setStatus({ kind, text });
        setTimeout(() => setStatus(null), 6000);
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [peerData, profileData, feedData] = await Promise.all([
                rpcAction('alliance:list_peers', {}),
                rpcAction('alliance:get_self_profile', {}),
                rpcAction('admin:get_trusted_feeds', {}),
            ]);
            setPeers(peerData || []);
            setFeeds(feedData || []);
            if (profileData) setProfile(profileData);
        } catch (e: any) {
            flash('err', e?.message || 'Failed to load alliances.');
        } finally {
            setLoading(false);
        }
    }, [rpcAction, flash]);

    // Mount data fetch. `loading` initializes to true (below), so the mount path needs no
    // synchronous setLoading(true): we inline the same fetch the shared `load` callback
    // performs, so the only setState calls are provably post-await and the
    // set-state-in-effect rule is satisfied without behavior change. `load` itself is left
    // intact (it keeps its leading setLoading(true)) for every other call site — the
    // realtime-refresh effect and the mutation handlers all rely on that loading flash.
    // A cancelled flag drops a late resolution after unmount / rpcAction change.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [peerData, profileData, feedData] = await Promise.all([
                    rpcAction('alliance:list_peers', {}),
                    rpcAction('alliance:get_self_profile', {}),
                    rpcAction('admin:get_trusted_feeds', {}),
                ]);
                if (cancelled) return;
                setPeers(peerData || []);
                setFeeds(feedData || []);
                if (profileData) setProfile(profileData);
            } catch (e: any) {
                if (!cancelled) flash('err', e?.message || 'Failed to load alliances.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [rpcAction, flash]);

    // Live refresh: the engine broadcasts alliance_update (ids only) on health
    // / alert transitions; DataCoreContext relays it as a window event. Coalesce
    // bursts into one re-pull.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onUpdate = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; load(); }, 500);
        };
        window.addEventListener('app:realtime:alliance-update', onUpdate);
        return () => {
            window.removeEventListener('app:realtime:alliance-update', onUpdate);
            if (timer) clearTimeout(timer);
        };
    }, [load]);

    const handleForceSync = async (peerId: string) => {
        setBusy(true);
        try {
            const res = await rpcAction('alliance:force_sync', { peerId });
            flash(res?.ok ? 'ok' : 'err', res?.message || 'Sync requested.');
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Sync failed.');
        } finally { setBusy(false); }
    };

    const handleSaveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            await rpcAction('alliance:save_self_profile', { profile });
            flash('ok', 'Directory profile saved.');
        } catch (e: any) {
            flash('err', e?.message || 'Failed to save profile.');
        } finally { setBusy(false); }
    };

    const handleGenerateCode = async () => {
        setBusy(true);
        try {
            const res = await rpcAction('alliance:generate_code', {});
            setPairingCode(res);
            flash('ok', 'Pairing code generated — send it to your partner securely.');
        } catch (e: any) {
            flash('err', e?.message || 'Failed to generate code.');
        } finally { setBusy(false); }
    };

    const handleAddPartner = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            await rpcAction('alliance:add_peer', { label: newLabel, baseUrl: newUrl, peerCode: newCode, type: newType });
            setNewLabel(''); setNewUrl(''); setNewCode('');
            flash('ok', 'Partner added. Once both sides have added each other, click Connect.');
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Failed to add partner.');
        } finally { setBusy(false); }
    };

    const handleConnect = async (peerId: string) => {
        setBusy(true);
        try {
            await rpcAction('alliance:connect_peer', { peerId });
            flash('ok', 'Handshake complete — alliance is active.');
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Handshake failed.');
            await load();
        } finally { setBusy(false); }
    };

    const handleRevoke = async (peer: AlliancePeer) => {
        const ok = await confirm({
            title: 'Revoke Alliance',
            message: `Dissolve the alliance with "${peer.label}" and destroy the shared keys? This cannot be undone — re-pairing requires a fresh handshake.`,
            confirmText: 'Revoke',
        });
        if (!ok) return;
        setBusy(true);
        try {
            await rpcAction('alliance:delete_peer', { peerId: peer.id });
            flash('ok', 'Alliance revoked.');
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Failed to revoke.');
        } finally { setBusy(false); }
    };

    const handleUpdatePeer = async (peerId: string, updates: Record<string, unknown>) => {
        setBusy(true);
        try {
            await rpcAction('alliance:update_peer', { peerId, updates });
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Failed to update peer.');
        } finally { setBusy(false); }
    };

    const handleAddFeed = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newFeedLabel.trim() || !newFeedUrl.trim() || !newFeedKey.trim()) return;
        setBusy(true);
        try {
            await rpcAction('admin:add_trusted_feed', { label: newFeedLabel.trim(), url: newFeedUrl.trim(), apiKey: newFeedKey.trim() });
            setNewFeedLabel(''); setNewFeedUrl(''); setNewFeedKey('');
            flash('ok', 'Feed added — pull its intel via Intel → Feed Ingest.');
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Failed to add feed.');
        } finally { setBusy(false); }
    };

    const handleDeleteFeed = async (id: string, label: string) => {
        const ok = await confirm({
            title: 'Remove Feed',
            message: `Remove the receive-only feed "${label}"? You will no longer pull intel from this source.`,
            confirmText: 'Remove',
        });
        if (!ok) return;
        setBusy(true);
        try {
            await rpcAction('admin:delete_trusted_feed', { feedId: id });
            flash('ok', 'Feed removed.');
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Failed to remove feed.');
        } finally { setBusy(false); }
    };

    const handleUpdateFeed = async (feedId: string, updates: Record<string, unknown>) => {
        setBusy(true);
        try {
            await rpcAction('admin:update_trusted_feed', { feedId, updates });
            await load();
        } catch (e: any) {
            flash('err', e?.message || 'Failed to update feed.');
        } finally { setBusy(false); }
    };

    return (
        <div className="p-4 md:p-8 space-y-6">
            <TabPageHeader
                title="Alliances"
                icon="fa-solid fa-handshake"
                accent="indigo"
                subtitle="Securely federate with allied organizations. Pairing is server-to-server with encrypted, per-peer keys — no data is shared until a handshake completes."
                meta={<span className="text-xs font-bold text-slate-500 uppercase">{peers.length} Peers</span>}
            />

            {status && (
                <div className={`rounded-lg border px-4 py-3 text-sm ${status.kind === 'ok' ? 'bg-green-500/10 border-green-500/30 text-green-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
                    {status.text}
                </div>
            )}

            {/* SELF PROFILE */}
            <form onSubmit={handleSaveProfile} className="bg-slate-900/40 rounded-xl border border-slate-700/50 p-6 space-y-4">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center">
                    <i className="fa-solid fa-id-card mr-3 text-slate-300"></i>Your Directory Card
                </h3>
                <p className="text-xs text-slate-500">This is what allied orgs see for you in their directory after pairing.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Org Name</label>
                        <input value={profile.orgName} onChange={e => setProfile(p => ({ ...p, orgName: e.target.value }))}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" required disabled={!canManage} />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Org Tag</label>
                        <input value={profile.orgTag || ''} onChange={e => setProfile(p => ({ ...p, orgTag: e.target.value }))}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="e.g. MYRSI" disabled={!canManage} />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Icon URL</label>
                        <input value={profile.iconUrl || ''} onChange={e => setProfile(p => ({ ...p, iconUrl: e.target.value }))}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="https://…" disabled={!canManage} />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Contact (Discord)</label>
                        <input value={profile.contactDiscord || ''} onChange={e => setProfile(p => ({ ...p, contactDiscord: e.target.value }))}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="discord.gg/…" disabled={!canManage} />
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Blurb</label>
                        <textarea value={profile.blurb || ''} onChange={e => setProfile(p => ({ ...p, blurb: e.target.value }))}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500 min-h-[70px]" maxLength={500} disabled={!canManage} />
                    </div>
                </div>
                <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={profile.directoryVisible} onChange={e => setProfile(p => ({ ...p, directoryVisible: e.target.checked }))}
                            className="accent-slate-400 w-4 h-4" disabled={!canManage} />
                        List us publicly in allied directories
                    </label>
                    <button type="submit" disabled={busy || !canManage}
                        className="bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white font-bold py-2 px-4 rounded-sm text-sm transition-colors disabled:opacity-50">
                        Save Profile
                    </button>
                </div>
            </form>

            {/* PAIRING */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 p-6 space-y-4">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center">
                    <i className="fa-solid fa-key mr-3 text-slate-300"></i>Pair with an Ally
                </h3>
                <p className="text-xs text-slate-500">
                    Both orgs generate a one-time code, swap them out-of-band (e.g. Discord), and each enters the
                    <em> other&apos;s</em> code below. Once both have added each other, one side clicks Connect.
                </p>

                <div className="flex flex-wrap items-center gap-4">
                    <button onClick={handleGenerateCode} disabled={busy || !canManage}
                        className="bg-indigo-600/80 hover:bg-indigo-500 border border-indigo-500/50 text-white font-bold py-2 px-4 rounded-sm text-sm transition-colors disabled:opacity-50">
                        <i className="fa-solid fa-dice mr-2"></i>Generate Pairing Code
                    </button>
                    {pairingCode && (
                        <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-600 rounded-sm px-3 py-2">
                            <code className="text-indigo-300 text-sm break-all">{pairingCode.code}</code>
                            <button onClick={() => navigator.clipboard?.writeText(pairingCode.code)} title="Copy"
                                className="text-slate-400 hover:text-white"><i className="fa-solid fa-copy"></i></button>
                            <span className="text-[10px] text-slate-500 uppercase">expires {fmt(pairingCode.expiresAt)}</span>
                        </div>
                    )}
                </div>

                <form onSubmit={handleAddPartner} className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end pt-2 border-t border-slate-700/50">
                    <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Partner Name</label>
                        <input value={newLabel} onChange={e => setNewLabel(e.target.value)} required disabled={!canManage}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="Allied Org" />
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Their Dashboard URL</label>
                        <input type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)} required disabled={!canManage}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="https://their-app" />
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Their Pairing Code</label>
                        <input value={newCode} onChange={e => setNewCode(e.target.value)} required disabled={!canManage}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="paste code" />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Type</label>
                        <select value={newType} onChange={e => setNewType(e.target.value as AllianceType)} disabled={!canManage}
                            className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500">
                            {TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </div>
                    <div className="md:col-span-7">
                        <button type="submit" disabled={busy || !canManage}
                            className="bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white font-bold py-2 px-4 rounded-sm text-sm transition-colors disabled:opacity-50">
                            Add Partner
                        </button>
                    </div>
                </form>
            </div>

            {/* PEER LIST */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex justify-between items-center">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center">
                        <i className="fa-solid fa-people-arrows mr-3 text-slate-300"></i>Alliance Partners
                    </h3>
                    <button onClick={load} className="text-xs text-slate-400 hover:text-white"><i className="fa-solid fa-rotate mr-1"></i>Refresh</button>
                </div>
                <div className="p-6 space-y-2">
                    {loading && <p className="text-center text-slate-500 py-4">Loading…</p>}
                    {!loading && peers.length === 0 && <p className="text-center text-slate-500 py-4 italic">No alliance partners yet.</p>}
                    {peers.map(peer => (
                        <div key={peer.id} className="p-3 bg-slate-800/30 rounded-sm border border-slate-700">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="font-semibold text-white truncate">{peer.peerOrgName || peer.label}</p>
                                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${statusClass(peer.status)}`}>{peer.status}</span>
                                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border bg-slate-600/20 text-slate-400 border-slate-600/40">{peer.type}</span>
                                        {peer.status === 'Active' && peer.syncHealth && SYNC_BADGES[peer.syncHealth] && (
                                            <span
                                                className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${SYNC_BADGES[peer.syncHealth].cls}`}
                                                title={peer.syncHealth === 'down' && peer.syncNextAttemptAt
                                                    ? `Unreachable — next retry ${fmt(peer.syncNextAttemptAt)}`
                                                    : peer.syncLastOkAt ? `Last successful sync ${fmt(peer.syncLastOkAt)}` : undefined}
                                            >
                                                <i className={`fa-solid ${SYNC_BADGES[peer.syncHealth].icon} mr-1`}></i>
                                                {SYNC_BADGES[peer.syncHealth].label}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500 truncate max-w-md">{peer.baseUrl}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    {peer.status === 'Active' && (
                                        <button onClick={() => handleForceSync(peer.id)} disabled={busy || !canManage}
                                            className="bg-slate-700/80 hover:bg-slate-600 border border-slate-600/60 text-slate-200 text-xs font-bold py-1.5 px-3 rounded-sm transition-colors disabled:opacity-50" title="Run every sync job for this peer now">
                                            <i className="fa-solid fa-arrows-rotate mr-1"></i>Sync now
                                        </button>
                                    )}
                                    {peer.status !== 'Active' && (
                                        <button onClick={() => handleConnect(peer.id)} disabled={busy || !canManage}
                                            className="bg-indigo-600/80 hover:bg-indigo-500 border border-indigo-500/50 text-white text-xs font-bold py-1.5 px-3 rounded-sm transition-colors disabled:opacity-50">
                                            <i className="fa-solid fa-link mr-1"></i>Connect
                                        </button>
                                    )}
                                    <button onClick={() => handleRevoke(peer)} disabled={busy || !canManage}
                                        className="text-red-400 hover:text-red-300 p-2 hover:bg-red-500/10 rounded-sm transition-colors disabled:opacity-50" title="Revoke">
                                        <i className="fa-solid fa-link-slash"></i>
                                    </button>
                                </div>
                            </div>
                            {peer.syncAlert && (
                                <div className="mt-2 flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                                    <i className="fa-solid fa-triangle-exclamation mt-0.5 shrink-0"></i>
                                    <span className="min-w-0">{peer.syncAlert}</span>
                                </div>
                            )}
                            {peer.status === 'Active' && (
                                <div className="mt-3 pt-3 border-t border-slate-700/50 space-y-2">
                                    <div className="flex flex-wrap items-center gap-3">
                                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Share Channels</span>
                                        {(([['reports', 'Reports'], ['warrants', 'Caution Notes'], ['bulletins', 'Bulletins'], ['operations', 'Joint Ops'], ['roster', 'Member Roster'], ['fleet', 'Fleet Summary']]) as Array<['reports' | 'warrants' | 'bulletins' | 'operations' | 'roster' | 'fleet', string]>).map(([key, label]) => {
                                            const on = peer.channels?.[key] === true;
                                            return (
                                                <label key={key} className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-300 hover:text-white">
                                                    <input type="checkbox" checked={on} disabled={busy || !canManage}
                                                        onChange={() => handleUpdatePeer(peer.id, { channels: { ...(peer.channels || {}), [key]: !on } })}
                                                        className="accent-slate-400 w-3.5 h-3.5" />
                                                    {label}
                                                </label>
                                            );
                                        })}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-4">
                                        <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                                            Outbound max
                                            <select value={peer.outboundMaxClearance ?? 0} disabled={busy || !canManage}
                                                onChange={e => handleUpdatePeer(peer.id, { outboundMaxClearance: Number(e.target.value) })}
                                                className="bg-slate-800 border border-slate-700 rounded-sm px-2 py-1 text-xs text-white outline-hidden">
                                                {[0, 1, 2, 3, 4, 5].map(l => <option key={l} value={l}>L{l}</option>)}
                                            </select>
                                        </label>
                                        <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                                            Inbound max
                                            <select value={peer.inboundMaxClearance ?? 0} disabled={busy || !canManage}
                                                onChange={e => handleUpdatePeer(peer.id, { inboundMaxClearance: Number(e.target.value) })}
                                                className="bg-slate-800 border border-slate-700 rounded-sm px-2 py-1 text-xs text-white outline-hidden">
                                                {[0, 1, 2, 3, 4, 5].map(l => <option key={l} value={l}>L{l}</option>)}
                                            </select>
                                        </label>
                                        <span className="text-[11px] text-slate-500 ml-auto">
                                            {peer.syncLastOkAt && <>Last sync: {fmt(peer.syncLastOkAt)}</>}
                                            {!peer.syncLastOkAt && peer.lastContactAt && <>Last contact: {fmt(peer.lastContactAt)}</>}
                                        </span>
                                    </div>
                                </div>
                            )}
                            {peer.status !== 'Active' && peer.lastContactAt && (
                                <p className="mt-2 pt-2 border-t border-slate-700/50 text-[11px] text-slate-500">Last contact: {fmt(peer.lastContactAt)}</p>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* RECEIVE-ONLY FEEDS */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex justify-between items-center">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center">
                        <i className="fa-solid fa-satellite-dish mr-3 text-slate-300"></i>Receive-Only Feeds
                    </h3>
                    <span className="text-[10px] font-bold text-slate-500 uppercase">{feeds.length} Configured</span>
                </div>
                <div className="p-6 space-y-4">
                    <p className="text-xs text-slate-500">
                        A one-way subscription — you hold the partner&apos;s API key and pull their intel; nothing is shared back and no handshake is needed.
                        Intel from feeds (and allied peers) is pulled in <span className="text-slate-300">Intel → Maintenance → Feed Ingest</span>.
                    </p>
                    <form onSubmit={handleAddFeed} className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end pt-2 border-t border-slate-700/50">
                        <div className="md:col-span-2">
                            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Source Name</label>
                            <input value={newFeedLabel} onChange={e => setNewFeedLabel(e.target.value)} required disabled={!canManage}
                                className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="Allied Org" />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Their Dashboard URL</label>
                            <input type="url" value={newFeedUrl} onChange={e => setNewFeedUrl(e.target.value)} required disabled={!canManage}
                                className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="https://their-app" />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Their API Key</label>
                            <input type="password" value={newFeedKey} onChange={e => setNewFeedKey(e.target.value)} required disabled={!canManage}
                                className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2 text-white text-sm outline-hidden focus:border-slate-500" placeholder="sk_…" />
                        </div>
                        <div>
                            <button type="submit" disabled={busy || !canManage}
                                className="w-full bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white font-bold py-2 rounded-sm text-sm transition-colors disabled:opacity-50">
                                Add Feed
                            </button>
                        </div>
                    </form>
                    <div className="space-y-2">
                        {feeds.length === 0 && <p className="text-center text-slate-500 py-4 italic">No receive-only feeds configured.</p>}
                        {feeds.map(feed => {
                            const f = feed as unknown as { id: string; label: string; url: string; last_synced_at?: string; sync_reports?: boolean; sync_warrants?: boolean; sync_bulletins?: boolean; inbound_max_clearance?: number };
                            return (
                                <div key={f.id} className="p-3 bg-slate-800/30 rounded-sm border border-slate-700">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="font-semibold text-white truncate">{f.label}</p>
                                            <p className="text-xs text-slate-500 truncate max-w-md">{f.url}</p>
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className="text-[11px] text-slate-500">Last synced: {f.last_synced_at ? fmt(f.last_synced_at) : 'Never'}</span>
                                            <button onClick={() => handleDeleteFeed(f.id, f.label)} disabled={busy || !canManage}
                                                className="text-red-400 hover:text-red-300 p-2 hover:bg-red-500/10 rounded-sm transition-colors disabled:opacity-50" title="Remove feed">
                                                <i className="fa-solid fa-trash"></i>
                                            </button>
                                        </div>
                                    </div>
                                    <div className="mt-3 pt-3 border-t border-slate-700/50 flex flex-wrap items-center gap-3">
                                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Sync Filters</span>
                                        {(([['syncReports', 'sync_reports', 'Reports'], ['syncWarrants', 'sync_warrants', 'Caution Notes'], ['syncBulletins', 'sync_bulletins', 'Bulletins']]) as Array<[string, 'sync_reports' | 'sync_warrants' | 'sync_bulletins', string]>).map(([camel, snake, label]) => {
                                            const on = f[snake] !== false;
                                            return (
                                                <label key={camel} className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-300 hover:text-white">
                                                    <input type="checkbox" checked={on} disabled={busy || !canManage}
                                                        onChange={() => handleUpdateFeed(f.id, { [camel]: !on })}
                                                        className="accent-slate-400 w-3.5 h-3.5" />
                                                    {label}
                                                </label>
                                            );
                                        })}
                                        <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider ml-auto">
                                            Inbound max
                                            <select value={f.inbound_max_clearance ?? 5} disabled={busy || !canManage}
                                                onChange={e => handleUpdateFeed(f.id, { inboundMaxClearance: Number(e.target.value) })}
                                                className="bg-slate-800 border border-slate-700 rounded-sm px-2 py-1 text-xs text-white outline-hidden">
                                                {[0, 1, 2, 3, 4, 5].map(l => <option key={l} value={l}>L{l}</option>)}
                                            </select>
                                        </label>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AllianceManagementTab;
