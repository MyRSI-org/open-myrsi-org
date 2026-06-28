import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { AllianceDirectoryEntry, AllyRosterData, AllyFleetSummary } from '../../../types';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';

type StatusFilter = 'All' | 'Active' | 'Pending';
type TypeFilter = 'All' | 'Alliance' | 'Neutral' | 'Rivalry';

const typeStyles: Record<string, { ring: string; chip: string; icon: string }> = {
    Alliance: { ring: 'border-green-500/30', chip: 'bg-green-500/15 text-green-300 border-green-500/30', icon: 'fa-handshake' },
    Neutral: { ring: 'border-slate-600/40', chip: 'bg-slate-600/20 text-slate-300 border-slate-600/40', icon: 'fa-scale-balanced' },
    Rivalry: { ring: 'border-red-500/30', chip: 'bg-red-500/15 text-red-300 border-red-500/30', icon: 'fa-bolt' },
};

const FilterChip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
    <button onClick={onClick}
        className={`text-xs font-bold uppercase tracking-wide px-3 py-1.5 rounded-full border transition-colors ${active ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/50' : 'bg-slate-800/40 text-slate-400 border-slate-700 hover:text-slate-200'}`}>
        {children}
    </button>
);

const AllianceDirectoryView: React.FC = () => {
    const { rpcAction } = useData();
    const [entries, setEntries] = useState<AllianceDirectoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
    const [typeFilter, setTypeFilter] = useState<TypeFilter>('All');

    // Drill-in: an ally's shared roster / fleet summary (lazy-loaded server-to-server).
    const [openPeer, setOpenPeer] = useState<AllianceDirectoryEntry | null>(null);
    const [roster, setRoster] = useState<AllyRosterData | null>(null);
    const [fleet, setFleet] = useState<AllyFleetSummary | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const openPeerDetail = useCallback(async (entry: AllianceDirectoryEntry) => {
        setOpenPeer(entry);
        setRoster(null); setFleet(null); setDetailLoading(true);
        try {
            const [r, f] = await Promise.all([
                rpcAction('alliance:fetch_peer_roster', { peerId: entry.id }).catch(() => null),
                rpcAction('alliance:fetch_peer_fleet', { peerId: entry.id }).catch(() => null),
            ]);
            setRoster(r); setFleet(f);
        } finally { setDetailLoading(false); }
    }, [rpcAction]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await rpcAction('alliance:get_directory', {});
            setEntries(data || []);
        } catch {
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [rpcAction]);

    // Mount-time data fetch. `loading` already initializes to true, so the mount path
    // needs no synchronous setLoading(true) — we inline the async fetch directly in the
    // effect so the only setState calls (setEntries / setLoading(false)) are provably
    // post-await, satisfying the set-state-in-effect rule with no behavior change. The
    // shared `load` callback (used by the Refresh button, which does flip loading on
    // click) is unchanged. A cancelled flag drops a late resolution after unmount.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const data = await rpcAction('alliance:get_directory', {});
                if (!cancelled) setEntries(data || []);
            } catch {
                if (!cancelled) setEntries([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [rpcAction]);

    const filtered = useMemo(() => entries.filter(e =>
        (statusFilter === 'All' || e.status === statusFilter) &&
        (typeFilter === 'All' || e.type === typeFilter)
    ), [entries, statusFilter, typeFilter]);

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · ALLIANCES"
                chipIcon="fa-handshake"
                chipAccent="indigo"
                title="Alliance Directory"
                subtitle="Organizations your org has a standing diplomatic relationship with."
                actions={<HeroActionButton onClick={load} accent="slate" icon="fa-rotate">Refresh</HeroActionButton>}
                stats={<>
                    <HeroStat icon="fa-handshake" label="Total" value={entries.length} accent="indigo" emphasize={entries.length > 0} />
                    <HeroStat icon="fa-circle-check" label="Active" value={entries.filter((e) => e.status === 'Active').length} accent="emerald" emphasize={entries.some((e) => e.status === 'Active')} />
                    <HeroStat icon="fa-hourglass-half" label="Pending" value={entries.filter((e) => e.status === 'Pending').length} accent="amber" emphasize={entries.some((e) => e.status === 'Pending')} />
                    <HeroStat icon="fa-bolt" label="Rivalries" value={entries.filter((e) => e.type === 'Rivalry').length} accent="red" emphasize={entries.some((e) => e.type === 'Rivalry')} />
                </>}
            />

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 md:p-8 space-y-6">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mr-1">Status</span>
                {(['All', 'Active', 'Pending'] as StatusFilter[]).map(s => (
                    <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>{s}</FilterChip>
                ))}
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mx-1 ml-4">Type</span>
                {(['All', 'Alliance', 'Neutral', 'Rivalry'] as TypeFilter[]).map(t => (
                    <FilterChip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)}>{t}</FilterChip>
                ))}
            </div>

            {loading ? (
                <p className="text-center text-slate-500 py-10">Loading directory…</p>
            ) : filtered.length === 0 ? (
                <p className="text-center text-slate-500 py-10 italic">No alliances match these filters.</p>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filtered.map(entry => {
                        const ts = typeStyles[entry.type] || typeStyles.Neutral;
                        return (
                            <div key={entry.id} className={`bg-slate-900/40 rounded-xl border ${ts.ring} p-5 flex flex-col gap-3`}>
                                <div className="flex items-center gap-3">
                                    {entry.peerIconUrl ? (
                                        <img src={entry.peerIconUrl} alt="" className="h-11 w-11 rounded-lg object-cover border border-slate-700" />
                                    ) : (
                                        <span className="h-11 w-11 rounded-lg bg-slate-800 border border-slate-700 inline-flex items-center justify-center text-slate-500">
                                            <i className="fa-solid fa-shield-halved" />
                                        </span>
                                    )}
                                    <div className="min-w-0">
                                        <p className="font-bold text-white truncate">{entry.peerOrgName || 'Unknown Org'}</p>
                                        {entry.peerOrgTag && <p className="text-xs text-slate-500 font-mono truncate">[{entry.peerOrgTag}]</p>}
                                    </div>
                                </div>
                                {entry.peerBlurb && <p className="text-sm text-slate-400 line-clamp-3">{entry.peerBlurb}</p>}
                                <div className="mt-auto flex items-center gap-2 pt-1">
                                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${ts.chip}`}>
                                        <i className={`fa-solid ${ts.icon} mr-1`} />{entry.type}
                                    </span>
                                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${entry.status === 'Active' ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30'}`}>
                                        {entry.status}
                                    </span>
                                </div>
                                {entry.status === 'Active' && (
                                    <button onClick={() => openPeerDetail(entry)}
                                        className="mt-1 text-[11px] font-bold uppercase tracking-wider text-indigo-300 hover:text-indigo-200 self-start">
                                        <i className="fa-solid fa-users-viewfinder mr-1.5"></i>View roster &amp; fleet
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            </div>

            {openPeer && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpenPeer(null)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto custom-scrollbar" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50 sticky top-0 bg-slate-900">
                            <h3 className="text-lg font-bold text-white">{openPeer.peerOrgName || 'Ally'} <span className="text-slate-500 text-sm">· shared intelligence</span></h3>
                            <button onClick={() => setOpenPeer(null)} className="text-slate-400 hover:text-white"><i className="fa-solid fa-xmark"></i></button>
                        </div>
                        <div className="p-6 space-y-6">
                            {detailLoading && <p className="text-center text-slate-500 py-6">Fetching from {openPeer.peerOrgName || 'the ally'}…</p>}

                            {!detailLoading && (
                                <div>
                                    <h4 className="text-sm font-bold text-white uppercase tracking-wider mb-3"><i className="fa-solid fa-users mr-2 text-slate-400"></i>Member Roster</h4>
                                    {!roster ? (
                                        <p className="text-sm text-slate-500 italic">This ally hasn't shared their roster.</p>
                                    ) : (
                                        <>
                                            <p className="text-xs text-slate-500 mb-3">{roster.memberCount} member{roster.memberCount === 1 ? '' : 's'}</p>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto custom-scrollbar">
                                                {roster.members.map(m => (
                                                    <div key={m.id} className="flex items-center gap-2 p-2 rounded-lg bg-slate-800/40 border border-slate-700/40">
                                                        {m.avatarUrl ? <img src={m.avatarUrl} alt="" className="h-7 w-7 rounded-full border border-slate-700" /> : <span className="h-7 w-7 rounded-full bg-slate-700 inline-flex items-center justify-center text-slate-400 text-[10px]"><i className="fa-solid fa-user"></i></span>}
                                                        <div className="min-w-0">
                                                            <p className="text-xs font-semibold text-white truncate">{m.name}</p>
                                                            <p className="text-[10px] text-slate-500 truncate">{[m.rankName, m.unitName].filter(Boolean).join(' · ') || m.roleName}</p>
                                                        </div>
                                                        {m.isDuty && <span className="ml-auto h-2 w-2 rounded-full bg-green-500" title="On duty"></span>}
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {!detailLoading && (
                                <div>
                                    <h4 className="text-sm font-bold text-white uppercase tracking-wider mb-3"><i className="fa-solid fa-ship mr-2 text-slate-400"></i>Fleet Summary</h4>
                                    {!fleet ? (
                                        <p className="text-sm text-slate-500 italic">This ally hasn't shared their fleet.</p>
                                    ) : (
                                        <>
                                            <p className="text-xs text-slate-500 mb-3">{fleet.totalShips} ship{fleet.totalShips === 1 ? '' : 's'} across {fleet.groupCount} group{fleet.groupCount === 1 ? '' : 's'}</p>
                                            <div className="flex flex-wrap gap-2 mb-3">
                                                {fleet.shipsByCategory.map(c => (
                                                    <span key={c.category} className="text-[11px] px-2.5 py-1 rounded-md bg-slate-800/40 border border-slate-700/40 text-slate-300">{c.category}: <span className="text-white font-semibold">{c.count}</span></span>
                                                ))}
                                            </div>
                                            {fleet.groups.length > 0 && (
                                                <div className="space-y-1.5">
                                                    {fleet.groups.map(g => (
                                                        <div key={`${g.name}-${g.type}`} className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-800/30 border border-slate-700/30">
                                                            <span className="text-slate-200">{g.name} <span className="text-slate-500">· {g.type}</span></span>
                                                            <span className="text-slate-500">{g.totalShips} ship{g.totalShips === 1 ? '' : 's'}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AllianceDirectoryView;
