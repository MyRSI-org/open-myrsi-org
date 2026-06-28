

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useMembers } from '../../../contexts/MembersContext';
import { useAuth } from '../../../contexts/AuthContext';
import { User, OrganizationalUnit } from '../../../types';
import { VirtualizedList } from '../../ui/VirtualizedList';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { buildUnitTree, type UnitNode } from '../../../lib/unitTree';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import EmptyState from '../../shared/ui/EmptyState';
import FilterPopover from '../../shared/FilterPopover';
import SortableColumnHeader from '../../shared/SortableColumnHeader';
import { useNotification } from '../../../contexts/NotificationContext';
import { useNavigation } from '../../../contexts/NavigationContext';

// Helper types for the flattened list
type RosterItemType = 'unit' | 'member';

interface RosterItem {
    id: string; // Unique key for VirtualizedList
    type: RosterItemType;
    data: User | OrganizationalUnit;
    level: number;
}

type RosterMode = 'hierarchy' | 'flat';
type FlatSortKey = 'name' | 'rank' | 'position' | 'unit' | 'isDuty';
type SortDir = 'asc' | 'desc';

const DutyRosterView: React.FC = () => {
    const { members, units, ranks } = useMembers();
    const { confirm } = useNotification();
    const { viewMemberProfile } = useNavigation();
    const { hasPermission, toggleDutyStatus } = useAuth();
    const [searchTerm, setSearchTerm] = useState('');
    const [viewMode, setViewMode] = useState<'on-duty' | 'off-duty' | 'all'>('all');
    const [isLoading, setIsLoading] = useState(true);
    const [togglingId, setTogglingId] = useState<number | null>(null);

    // Dual-mode rendering + cross-cutting filter chips. State persists across
    // mode switches so the user's filter selections aren't lost.
    const [rosterMode, setRosterMode] = useState<RosterMode>('hierarchy');
    const [unitFilter, setUnitFilter] = useState<Set<number>>(() => new Set());
    const [rankFilter, setRankFilter] = useState<Set<number>>(() => new Set());
    const [flatSortKey, setFlatSortKey] = useState<FlatSortKey>('name');
    const [flatSortDir, setFlatSortDir] = useState<SortDir>('asc');

    const handleToggleDuty = async (member: User) => {
        if (togglingId !== null) return;
        const ok = await confirm({
            title: member.isDuty ? 'Force Off Duty' : 'Force On Duty',
            message: `Toggle duty status for ${member.name}?`,
            confirmText: member.isDuty ? 'Set Off Duty' : 'Set On Duty',
            variant: member.isDuty ? 'warning' : 'info',
        });
        if (!ok) return;
        setTogglingId(member.id);
        try {
            await toggleDutyStatus(member.id);
        } finally {
            setTogglingId(null);
        }
    };

    const debouncedSearchTerm = useDebouncedValue(searchTerm, 300);
    const canManageDuty = hasPermission('admin:user:update');

    const toggleUnit = useCallback((id: number) => {
        setUnitFilter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);
    const toggleRank = useCallback((id: number) => {
        setRankFilter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    // Pre-index members by unit ID for O(1) lookups instead of O(n) filter per unit
    const membersByUnitId = useMemo(() => {
        const map = new Map<number | null, User[]>();
        for (const m of members) {
            const unitId = m.unit?.id ?? null;
            let list = map.get(unitId);
            if (!list) {
                list = [];
                map.set(unitId, list);
            }
            list.push(m);
        }
        return map;
    }, [members]);

    // One-way loading latch on data arrival. The moment members are available
    // we release the loading state during render (React re-renders before paint,
    // so this is equivalent to the old effect-set but without a post-paint flash).
    // isLoading is never set back to true, so this is self-terminating and cannot
    // loop. The empty-roster grace fallback below keeps its async timer.
    if (isLoading && members.length > 0) {
        setIsLoading(false);
    }

    // Fallback timeout for an empty roster or a fetch delay: if members never
    // arrive, release the loading state after 500ms. (The async set inside the
    // timer is not a synchronous effect set.)
    useEffect(() => {
        if (members.length > 0) return; // arrival is handled during render above
        const timer = setTimeout(() => setIsLoading(false), 500);
        return () => clearTimeout(timer);
    }, [members]);

    // Centralised member predicate so hierarchy + flat use the same filter logic.
    const memberMatches = useCallback((m: User) => {
        if (viewMode === 'on-duty' && !m.isDuty) return false;
        if (viewMode === 'off-duty' && m.isDuty) return false;
        if (unitFilter.size > 0 && (!m.unit || !unitFilter.has(m.unit.id))) return false;
        if (rankFilter.size > 0 && (!m.rank || !rankFilter.has(m.rank.id))) return false;
        if (debouncedSearchTerm) {
            const s = debouncedSearchTerm.toLowerCase();
            if (!(m.name.toLowerCase().includes(s) ||
                  m.rsiHandle.toLowerCase().includes(s) ||
                  (m.rank?.name || '').toLowerCase().includes(s))) return false;
        }
        return true;
    }, [viewMode, unitFilter, rankFilter, debouncedSearchTerm]);

    // 1. Build Unit Hierarchy Tree (shared with OrganisationView)
    const unitTree = useMemo(() => buildUnitTree(units), [units]);

    // 2a. Hierarchy mode: tree of units with members nested under each. Empty
    // subtrees (whose unit AND descendants have no surviving members after
    // filtering) are pruned so users don't see empty headers.
    const hierarchicalRoster = useMemo<RosterItem[]>(() => {
        if (isLoading || rosterMode !== 'hierarchy') return [];

        const result: RosterItem[] = [];

        const getSortedMembers = (unitId: number | null): User[] => {
            const list = (membersByUnitId.get(unitId) || []).filter(memberMatches);
            return list.sort((a, b) => {
                const rankA = a.rank?.sortOrder ?? 9999;
                const rankB = b.rank?.sortOrder ?? 9999;
                if (rankA !== rankB) return rankA - rankB;
                return a.name.localeCompare(b.name);
            });
        };

        // Returns true if the node or any descendant has surviving members.
        const subtreeHasMembers = (node: UnitNode): boolean => {
            if (getSortedMembers(node.id).length > 0) return true;
            return node.children.some(subtreeHasMembers);
        };

        const processNode = (node: UnitNode, level: number) => {
            if (!subtreeHasMembers(node)) return;

            const unitMembers = getSortedMembers(node.id);

            result.push({ id: `unit-${node.id}`, type: 'unit', data: node, level });
            unitMembers.forEach(m => {
                result.push({ id: `member-${m.id}`, type: 'member', data: m, level: level + 1 });
            });
            node.children.forEach(child => processNode(child, level + 1));
        };

        const processUnassigned = () => {
            const unassigned = getSortedMembers(null);
            if (unassigned.length > 0) {
                result.push({
                    id: 'unit-unassigned',
                    type: 'unit',
                    data: { id: 0, name: 'Unassigned Personnel', sortOrder: 9999 } as OrganizationalUnit,
                    level: 0
                });
                unassigned.forEach(m => {
                    result.push({ id: `member-${m.id}`, type: 'member', data: m, level: 1 });
                });
            }
        };

        unitTree.forEach(root => processNode(root, 0));
        processUnassigned();

        return result;
    }, [unitTree, membersByUnitId, memberMatches, isLoading, rosterMode]);

    // 2b. Flat mode: a single sortable list of all matching members. No unit
    // grouping rows; the Unit column is rendered alongside Rank instead.
    const flatRoster = useMemo<User[]>(() => {
        if (isLoading || rosterMode !== 'flat') return [];

        const filtered = members.filter(memberMatches);
        const dirMul = flatSortDir === 'asc' ? 1 : -1;

        const cmp = (a: User, b: User): number => {
            switch (flatSortKey) {
                case 'name':
                    return a.name.localeCompare(b.name) * dirMul;
                case 'rank': {
                    const ra = a.rank?.sortOrder ?? 9999;
                    const rb = b.rank?.sortOrder ?? 9999;
                    if (ra !== rb) return (ra - rb) * dirMul;
                    return a.name.localeCompare(b.name);
                }
                case 'position': {
                    const pa = a.position?.name || '';
                    const pb = b.position?.name || '';
                    if (pa !== pb) return pa.localeCompare(pb) * dirMul;
                    return a.name.localeCompare(b.name);
                }
                case 'unit': {
                    const ua = a.unit?.name || '';
                    const ub = b.unit?.name || '';
                    if (ua !== ub) return ua.localeCompare(ub) * dirMul;
                    return a.name.localeCompare(b.name);
                }
                case 'isDuty':
                    if (a.isDuty === b.isDuty) return a.name.localeCompare(b.name);
                    return (a.isDuty ? -1 : 1) * dirMul;
            }
        };
        return [...filtered].sort(cmp);
    }, [members, memberMatches, isLoading, rosterMode, flatSortKey, flatSortDir]);

    const requestFlatSort = (key: FlatSortKey) => {
        if (flatSortKey === key) {
            setFlatSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setFlatSortKey(key);
            setFlatSortDir('asc');
        }
    };

    const onDutyCount = useMemo(() => members.filter(m => m.isDuty).length, [members]);
    const filteredCount = rosterMode === 'flat'
        ? flatRoster.length
        : hierarchicalRoster.filter(r => r.type === 'member').length;

    const viewModeTabs: Array<{ key: 'on-duty' | 'off-duty' | 'all'; label: string; icon: string; count: number }> = [
        { key: 'on-duty', label: 'On Duty', icon: 'fa-bolt', count: onDutyCount },
        { key: 'off-duty', label: 'Off Duty', icon: 'fa-moon', count: members.length - onDutyCount },
        { key: 'all', label: 'All', icon: 'fa-users', count: members.length },
    ];

    const sortedRanks = useMemo(() => [...ranks].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)), [ranks]);

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · DUTY ROSTER"
                chipIcon="fa-users"
                chipAccent="emerald"
                title="Duty Roster"
                subtitle="Operational status and unit hierarchy. Toggle duty, inspect profiles, and review personnel structure."
                statsCols={3}
                stats={<>
                    <HeroStat icon="fa-bolt" label="On Duty" value={onDutyCount} accent="emerald" emphasize={onDutyCount > 0} />
                    <HeroStat icon="fa-moon" label="Off Duty" value={members.length - onDutyCount} accent="slate" />
                    <HeroStat icon="fa-users" label="Total Personnel" value={members.length} accent="cyan" />
                </>}
                tabs={viewModeTabs.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setViewMode(tab.key)}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                            viewMode === tab.key
                                ? 'text-emerald-300 border-emerald-400'
                                : 'text-slate-500 border-transparent hover:text-slate-300'
                        }`}
                    >
                        <i className={`fa-solid ${tab.icon}`}></i>
                        {tab.label}
                        <span className="ml-1 min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center bg-emerald-500/20 text-emerald-300">
                            {tab.count}
                        </span>
                    </button>
                ))}
            />

            <div className="flex-1 overflow-hidden p-4 sm:p-6 flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex bg-slate-900/60 rounded-lg border border-slate-700 p-0.5">
                        {(['hierarchy', 'flat'] as RosterMode[]).map(m => (
                            <button
                                key={m}
                                onClick={() => setRosterMode(m)}
                                className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${
                                    rosterMode === m
                                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                        : 'text-slate-500 hover:text-slate-300 border border-transparent'
                                }`}
                            >
                                <i className={`fa-solid ${m === 'hierarchy' ? 'fa-sitemap' : 'fa-list'} mr-1.5`}></i>
                                {m === 'hierarchy' ? 'Hierarchy' : 'Flat'}
                            </button>
                        ))}
                    </div>
                    <FilterPopover
                        label="Unit"
                        icon="fa-people-group"
                        options={units.map(u => ({ id: u.id, name: u.name }))}
                        selected={unitFilter}
                        onToggle={toggleUnit}
                        onClear={() => setUnitFilter(new Set())}
                    />
                    <FilterPopover
                        label="Rank"
                        icon="fa-medal"
                        options={sortedRanks.map(r => ({ id: r.id, name: r.name }))}
                        selected={rankFilter}
                        onToggle={toggleRank}
                        onClear={() => setRankFilter(new Set())}
                    />
                    {(unitFilter.size > 0 || rankFilter.size > 0) && (
                        <span className="text-[10px] text-slate-500 ml-auto font-mono">
                            {filteredCount} match{filteredCount === 1 ? '' : 'es'}
                        </span>
                    )}
                </div>

                <div className="relative max-w-2xl">
                    <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                        type="search"
                        placeholder="Search personnel by name, handle, or rank…"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-slate-900/60 text-white pl-12 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-emerald-500/50 focus:border-emerald-500/40 transition-all"
                    />
                </div>

                {/* Roster body. `@container/roster` lets the column visibility
                    classes below respond to the actual panel width — crucial
                    when a sidebar narrows the panel even though the viewport
                    itself is wide. Names must stay visible, so rank/position
                    only appear once their dedicated columns can fit alongside
                    a readable identity column. */}
                <div className="@container/roster bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden flex-1 min-h-0 flex flex-col relative">
                    {rosterMode === 'flat' ? (
                        <FlatColumnHeaders
                            sortKey={flatSortKey}
                            sortDir={flatSortDir}
                            onSort={requestFlatSort}
                        />
                    ) : (
                        <div className="flex bg-white/5 border-b border-white/5 px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest shrink-0">
                            <div className="flex-1">Identity</div>
                            <div className="w-48 hidden @3xl/roster:block">Rank</div>
                            <div className="w-44 hidden @5xl/roster:block">Position</div>
                            <div className="w-32 text-center hidden @xl/roster:block">Status</div>
                            <div className="w-24 text-right">Actions</div>
                        </div>
                    )}

                    {isLoading ? (
                        <div className="absolute inset-0 flex items-center justify-center z-10 bg-slate-900/60 backdrop-blur-xs">
                            <div className="flex flex-col items-center">
                                <i className="fa-solid fa-circle-notch animate-spin text-3xl text-emerald-400 mb-3"></i>
                                <span className="text-[10px] font-black text-emerald-300 uppercase tracking-widest">Loading Roster...</span>
                            </div>
                        </div>
                    ) : rosterMode === 'flat' ? (
                        <div id="duty-roster-list" className="flex-1 relative overflow-y-auto custom-scrollbar">
                            {flatRoster.length > 0 ? (
                                <VirtualizedList<User>
                                    items={flatRoster}
                                    itemHeight={50}
                                    scrollContainerId="duty-roster-list"
                                    renderItem={(member) => (
                                        <FlatMemberRow
                                            member={member}
                                            canManageDuty={canManageDuty}
                                            togglingId={togglingId}
                                            onView={() => viewMemberProfile(member)}
                                            onToggleDuty={() => handleToggleDuty(member)}
                                        />
                                    )}
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center p-6">
                                    <EmptyState
                                        icon="fa-user-slash"
                                        accent="emerald"
                                        heading="No personnel found"
                                        description="Try a different search term or clear your filters."
                                        compact
                                    />
                                </div>
                            )}
                        </div>
                    ) : (
                        <div id="duty-roster-list" className="flex-1 relative overflow-y-auto custom-scrollbar">
                            {hierarchicalRoster.length > 0 ? (
                                <VirtualizedList<RosterItem>
                                    items={hierarchicalRoster}
                                    itemHeight={50}
                                    scrollContainerId="duty-roster-list"
                                    renderItem={(item) => {
                                        const paddingLeft = Math.min(item.level, 5);
                                        if (item.type === 'unit') {
                                            const unit = item.data as OrganizationalUnit;
                                            return (
                                                <div
                                                    className="flex items-center px-4 h-full bg-slate-800/40 border-b border-slate-700/50"
                                                    style={{ paddingLeft: `${paddingLeft + 1}rem` }}
                                                >
                                                    {item.level > 0 && (
                                                        <div className="w-4 h-4 border-l-2 border-b-2 border-slate-600 rounded-bl mr-3 -mt-3"></div>
                                                    )}
                                                    <div className="flex items-center gap-2">
                                                        <i className={`fa-solid ${item.level === 0 ? 'fa-sitemap text-emerald-400' : 'fa-people-group text-slate-500'} text-xs`}></i>
                                                        <span className={`text-xs font-black uppercase tracking-widest ${item.level === 0 ? 'text-emerald-100' : 'text-slate-400'}`}>
                                                            {unit.name}
                                                        </span>
                                                    </div>
                                                </div>
                                            );
                                        }
                                        const member = item.data as User;
                                        return (
                                            <div
                                                className="flex items-center px-4 h-full hover:bg-slate-800/50 transition-colors border-b border-slate-700/30 group"
                                                style={{ paddingLeft: `${paddingLeft + 1}rem` }}
                                            >
                                                {item.level > 0 && (
                                                    <div className="w-4 h-4 border-l-2 border-b-2 border-slate-600 rounded-bl mr-3 -mt-3"></div>
                                                )}
                                                <div className="flex-1 flex items-center gap-3 min-w-0">
                                                    <div className="relative shrink-0">
                                                        <img src={member.avatarUrl} className="w-8 h-8 rounded-full border border-slate-600 object-cover" alt="" />
                                                        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-800 ${member.isDuty ? 'bg-green-500' : 'bg-slate-600'}`}></div>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-bold text-slate-200 truncate group-hover:text-white transition-colors">{member.name}</p>
                                                        <p className="text-[10px] text-slate-500 font-mono truncate @3xl/roster:hidden">{member.rank?.name}</p>
                                                    </div>
                                                </div>
                                                <div className="w-48 hidden @3xl/roster:flex items-center gap-2 text-xs text-slate-400">
                                                    {member.rank?.iconUrl && <img src={member.rank.iconUrl} className="w-4 h-4 object-contain" alt="" />}
                                                    <span className="truncate">{member.rank?.name || '-'}</span>
                                                </div>
                                                <div className="w-44 hidden @5xl/roster:flex items-center text-xs text-slate-400 truncate">
                                                    {member.position?.icon && <i className={`${member.position.icon} text-[10px] mr-1.5 text-slate-500 shrink-0`}></i>}
                                                    <span className="truncate">{member.position?.name || <span className="text-slate-600 italic">—</span>}</span>
                                                </div>
                                                <div className="w-32 text-center hidden @xl/roster:block">
                                                    <span className={`px-2 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-wider ${member.isDuty ? 'bg-green-500/10 text-green-400' : 'text-slate-600'}`}>
                                                        {member.isDuty ? 'Active' : 'Offline'}
                                                    </span>
                                                </div>
                                                <div className="w-24 text-right flex justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
                                                    <button onClick={() => viewMemberProfile(member)} className="p-1.5 text-emerald-300 hover:bg-emerald-500/10 rounded-sm transition-colors" title="View Profile">
                                                        <i className="fa-solid fa-id-card"></i>
                                                    </button>
                                                    {canManageDuty && (
                                                        <button
                                                            onClick={() => handleToggleDuty(member)}
                                                            disabled={togglingId === member.id}
                                                            className={`p-1.5 rounded-sm transition-colors disabled:opacity-60 disabled:cursor-wait ${member.isDuty ? 'text-red-400 hover:bg-red-500/10' : 'text-green-400 hover:bg-green-500/10'}`}
                                                            title={member.isDuty ? "Force Off Duty" : "Force On Duty"}
                                                        >
                                                            <i className={`fa-solid ${togglingId === member.id ? 'fa-circle-notch animate-spin' : 'fa-power-off'}`}></i>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center p-6">
                                    <EmptyState
                                        icon="fa-user-slash"
                                        accent="emerald"
                                        heading="No personnel found"
                                        description={searchTerm || unitFilter.size > 0 || rankFilter.size > 0 ? 'Try a different search term or clear filters.' : 'No personnel match the selected view.'}
                                        compact
                                    />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// Flat-mode helpers
const FlatColumnHeaders: React.FC<{
    sortKey: FlatSortKey;
    sortDir: SortDir;
    onSort: (key: FlatSortKey) => void;
}> = ({ sortKey, sortDir, onSort }) => (
    <div className="flex items-center bg-white/5 border-b border-white/5 px-4 py-3 shrink-0">
        <div className="flex-1">
            <SortableColumnHeader label="Name" sortKey="name" activeKey={sortKey} sortDir={sortDir} onSort={onSort} accent="emerald" showInactiveIndicator />
        </div>
        <div className="w-44 hidden @3xl/roster:block">
            <SortableColumnHeader label="Rank" sortKey="rank" activeKey={sortKey} sortDir={sortDir} onSort={onSort} accent="emerald" showInactiveIndicator />
        </div>
        <div className="w-44 hidden @4xl/roster:block">
            <SortableColumnHeader label="Position" sortKey="position" activeKey={sortKey} sortDir={sortDir} onSort={onSort} accent="emerald" showInactiveIndicator />
        </div>
        <div className="w-44 hidden @5xl/roster:block">
            <SortableColumnHeader label="Unit" sortKey="unit" activeKey={sortKey} sortDir={sortDir} onSort={onSort} accent="emerald" showInactiveIndicator />
        </div>
        <div className="w-28 hidden @xl/roster:flex justify-center">
            <SortableColumnHeader label="Status" sortKey="isDuty" activeKey={sortKey} sortDir={sortDir} onSort={onSort} accent="emerald" showInactiveIndicator />
        </div>
        <div className="w-24 text-right text-[10px] font-black text-slate-500 uppercase tracking-widest">Actions</div>
    </div>
);

const FlatMemberRow: React.FC<{
    member: User;
    canManageDuty: boolean;
    togglingId: number | null;
    onView: () => void;
    onToggleDuty: () => void;
}> = ({ member, canManageDuty, togglingId, onView, onToggleDuty }) => (
    <div className="flex items-center px-4 h-full hover:bg-slate-800/50 transition-colors border-b border-slate-700/30 group">
        <div className="flex-1 flex items-center gap-3 min-w-0">
            <div className="relative shrink-0">
                <img src={member.avatarUrl} className="w-8 h-8 rounded-full border border-slate-600 object-cover" alt="" />
                <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-800 ${member.isDuty ? 'bg-green-500' : 'bg-slate-600'}`}></div>
            </div>
            <div className="min-w-0">
                <p className="text-sm font-bold text-slate-200 truncate group-hover:text-white transition-colors">{member.name}</p>
                <p className="text-[10px] text-slate-500 font-mono truncate @3xl/roster:hidden">{member.rank?.name}</p>
            </div>
        </div>
        <div className="w-44 hidden @3xl/roster:flex items-center gap-2 text-xs text-slate-400">
            {member.rank?.iconUrl && <img src={member.rank.iconUrl} className="w-4 h-4 object-contain" alt="" />}
            <span className="truncate">{member.rank?.name || '-'}</span>
        </div>
        <div className="w-44 hidden @4xl/roster:flex items-center text-xs text-slate-400 truncate">
            {member.position?.icon && <i className={`${member.position.icon} text-[10px] mr-1.5 text-slate-500 shrink-0`}></i>}
            <span className="truncate">{member.position?.name || <span className="text-slate-600 italic">—</span>}</span>
        </div>
        <div className="w-44 hidden @5xl/roster:flex items-center text-xs text-slate-400 truncate">
            {member.unit?.name || <span className="text-slate-600 italic">Unassigned</span>}
        </div>
        <div className="w-28 text-center hidden @xl/roster:block">
            <span className={`px-2 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-wider ${member.isDuty ? 'bg-green-500/10 text-green-400' : 'text-slate-600'}`}>
                {member.isDuty ? 'Active' : 'Offline'}
            </span>
        </div>
        <div className="w-24 text-right flex justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
            <button onClick={onView} className="p-1.5 text-emerald-300 hover:bg-emerald-500/10 rounded-sm transition-colors" title="View Profile">
                <i className="fa-solid fa-id-card"></i>
            </button>
            {canManageDuty && (
                <button
                    onClick={onToggleDuty}
                    disabled={togglingId === member.id}
                    className={`p-1.5 rounded-sm transition-colors disabled:opacity-60 disabled:cursor-wait ${member.isDuty ? 'text-red-400 hover:bg-red-500/10' : 'text-green-400 hover:bg-green-500/10'}`}
                    title={member.isDuty ? "Force Off Duty" : "Force On Duty"}
                >
                    <i className={`fa-solid ${togglingId === member.id ? 'fa-circle-notch animate-spin' : 'fa-power-off'}`}></i>
                </button>
            )}
        </div>
    </div>
);

export default DutyRosterView;
