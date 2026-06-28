import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User, ToastVariant } from '../../types';
import { useMembers } from '../../contexts/MembersContext';
import { useAuth } from '../../contexts/AuthContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { VirtualizedList } from '../ui/VirtualizedList';
import EmptyState from '../shared/ui/EmptyState';
import AwardIcon from '../common/AwardIcon';
import FilterPopover from './FilterPopover';
import { useNotification } from '../../contexts/NotificationContext';

/**
 * MemberPicker — reusable scrollable list-of-members body for any picker
 * dialog. Search + filter + virtualized rendering means it stays performant
 * at orgs with 500+ members.
 *
 * Headless on purpose: the parent owns the modal shell, footer, and any
 * "currently assigned" chip strip. The picker only renders the list and the
 * toolbar above it. Selection state is the parent's responsibility — the
 * picker calls `onToggle(memberId, currentlyAssigned)` and the parent decides
 * how to commit (immediate via `addResponder/removeResponder`, or staged
 * batch via local `selectedIds` mirror).
 *
 * Click-row toggles assignment. Selected rows render with the same amber
 * highlight DispatchModal already used. Off-duty members are hidden behind a
 * "Show off-duty (N)" expander; bringing one on duty (per-row power button)
 * is permission-gated and committed inline (no confirm — interrupts the
 * dispatch flow; misclick is recoverable).
 */
export interface MemberPickerProps {
    /** Members currently assigned. Drives row-selected styling and the toggle direction passed to onToggle. */
    assignedIds: Set<number>;
    /**
     * Called when a row is clicked or its checkbox toggled. The parent runs
     * the appropriate write (addResponder vs removeResponder, or local set
     * mutation for staged batches) and returns a promise; the picker shows a
     * pending spinner on that row until the promise settles.
     */
    onToggle: (memberId: number, currentlyAssigned: boolean) => Promise<void>;
    /**
     * Optional keyword (typically `request.serviceType`) used to surface
     * members whose specialisations contain the keyword in the default
     * "Match first" sort. When omitted, default sort is by rank.
     */
    matchKeyword?: string;
    /** Permission-gated by parent (typically `hasPermission('admin:user:update')`). When true, each row shows a power-button to flip duty status. */
    allowDutyToggle?: boolean;
    /** Default off-duty section state. Off by default (collapsed). */
    showOffDutyDefault?: boolean;
}

type SortMode = 'match' | 'rank' | 'name';

const MemberPicker: React.FC<MemberPickerProps> = ({
    assignedIds,
    onToggle,
    matchKeyword,
    allowDutyToggle = false,
    showOffDutyDefault = false,
}) => {
    const { members, units, ranks } = useMembers();
    const { toggleDutyStatus } = useAuth();
    const { addToast } = useNotification();

    const [searchTerm, setSearchTerm] = useState('');
    const [unitFilter, setUnitFilter] = useState<Set<number>>(() => new Set());
    const [rankFilter, setRankFilter] = useState<Set<number>>(() => new Set());
    const [showOffDuty, setShowOffDuty] = useState(showOffDutyDefault);
    const [hasUserToggledOffDuty, setHasUserToggledOffDuty] = useState(false);
    const [sortMode, setSortMode] = useState<SortMode>(matchKeyword ? 'match' : 'rank');
    const [pendingToggle, setPendingToggle] = useState<Set<number>>(() => new Set());
    const [pendingDuty, setPendingDuty] = useState<Set<number>>(() => new Set());
    const searchRef = useRef<HTMLInputElement>(null);
    const debouncedSearch = useDebouncedValue(searchTerm, 200);

    const sortedRanks = useMemo(
        () => [...ranks].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
        [ranks],
    );

    const matchKeywordLower = useMemo(() => (matchKeyword || '').toLowerCase().trim(), [matchKeyword]);
    const memberHasMatch = useCallback((m: User) => {
        if (!matchKeywordLower) return false;
        return (m.specializations || []).some(s => s.name.toLowerCase().includes(matchKeywordLower));
    }, [matchKeywordLower]);

    const matches = useCallback((m: User) => {
        if (unitFilter.size > 0 && (!m.unit || !unitFilter.has(m.unit.id))) return false;
        if (rankFilter.size > 0 && (!m.rank || !rankFilter.has(m.rank.id))) return false;
        if (debouncedSearch) {
            const s = debouncedSearch.toLowerCase();
            const hit = m.name.toLowerCase().includes(s)
                || m.rsiHandle.toLowerCase().includes(s)
                || (m.rank?.name || '').toLowerCase().includes(s)
                || (m.specializations || []).some(spec => spec.name.toLowerCase().includes(s));
            if (!hit) return false;
        }
        return true;
    }, [unitFilter, rankFilter, debouncedSearch]);

    const compareMembers = useCallback((a: User, b: User): number => {
        if (sortMode === 'match' && matchKeywordLower) {
            const am = memberHasMatch(a) ? 0 : 1;
            const bm = memberHasMatch(b) ? 0 : 1;
            if (am !== bm) return am - bm;
        }
        if (sortMode === 'name') {
            return a.name.localeCompare(b.name);
        }
        // 'rank' (and tail-break for 'match'): rank sortOrder ascending, then name
        const ra = a.rank?.sortOrder ?? 9999;
        const rb = b.rank?.sortOrder ?? 9999;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
    }, [sortMode, matchKeywordLower, memberHasMatch]);

    const onDutyMembers = useMemo(
        () => members.filter(m => m.isDuty && matches(m)).sort(compareMembers),
        [members, matches, compareMembers],
    );
    const offDutyMembers = useMemo(
        () => members.filter(m => !m.isDuty && matches(m)).sort(compareMembers),
        [members, matches, compareMembers],
    );

    const toggleUnitFilter = useCallback((id: number) => {
        setUnitFilter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);
    const toggleRankFilter = useCallback((id: number) => {
        setRankFilter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const handleRowClick = useCallback(async (member: User) => {
        if (pendingToggle.has(member.id)) return;
        const currentlyAssigned = assignedIds.has(member.id);
        setPendingToggle(prev => new Set(prev).add(member.id));
        try {
            await onToggle(member.id, currentlyAssigned);
        } finally {
            setPendingToggle(prev => {
                const next = new Set(prev);
                next.delete(member.id);
                return next;
            });
        }
    }, [pendingToggle, assignedIds, onToggle]);

    const handleDutyToggle = useCallback(async (member: User, e: React.MouseEvent) => {
        e.stopPropagation();
        if (pendingDuty.has(member.id)) return;
        setPendingDuty(prev => new Set(prev).add(member.id));
        try {
            await toggleDutyStatus(member.id);
            addToast(
                member.isDuty ? 'Off Duty' : 'On Duty',
                <i className={`fa-solid ${member.isDuty ? 'fa-moon' : 'fa-bolt'}`}></i>,
                member.isDuty ? 'bg-slate-500/10 text-slate-400 border-slate-500/30' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                { description: `${member.name} is now ${member.isDuty ? 'off duty' : 'on duty'}.`, variant: (member.isDuty ? 'info' : 'success') as ToastVariant },
            );
        } catch (err: any) {
            addToast(
                'Toggle Failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Failed to update duty status.' },
            );
        } finally {
            setPendingDuty(prev => {
                const next = new Set(prev);
                next.delete(member.id);
                return next;
            });
        }
    }, [pendingDuty, toggleDutyStatus, addToast]);

    // Auto-expand the off-duty section when there are no on-duty matches
    // but off-duty members exist that DO match. Without this, dispatchers
    // hit the "no on-duty members match" empty state and have to discover
    // the off-duty toggle themselves. We only auto-expand once: if the
    // user has manually toggled the section, their preference sticks.
    //
    // Adjusted during render (React's "adjust state during render" pattern)
    // rather than in an effect: showOffDuty stays user-controllable, and the
    // hasUserToggledOffDuty + !showOffDuty guards make this a self-terminating
    // one-shot (no render loop). onDutyMembers/offDutyMembers are the memoized
    // lists computed above, so they're available here during render.
    if (!hasUserToggledOffDuty && onDutyMembers.length === 0 && offDutyMembers.length > 0 && !showOffDuty) {
        setShowOffDuty(true);
    }

    // -- Keyboard nav: '/' focuses search, 'Esc' clears search and blurs --
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                e.preventDefault();
                searchRef.current?.focus();
            } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
                setSearchTerm('');
                searchRef.current?.blur();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, []);

    const totalOffDuty = members.filter(m => !m.isDuty).length;
    const hasActiveFilter = !!debouncedSearch || unitFilter.size > 0 || rankFilter.size > 0;

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Toolbar: search + filter chips + sort */}
            <div className="px-4 pt-3 pb-2 space-y-2 border-b border-slate-800/60">
                <div className="relative">
                    <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                    <input
                        ref={searchRef}
                        type="search"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Search by name, handle, rank, or specialty…"
                        className="w-full bg-slate-950/60 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:ring-1 focus:ring-emerald-500/50 focus:border-emerald-500/40 outline-hidden"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <FilterPopover
                        label="Unit"
                        icon="fa-people-group"
                        options={units.map(u => ({ id: u.id, name: u.name }))}
                        selected={unitFilter}
                        onToggle={toggleUnitFilter}
                        onClear={() => setUnitFilter(new Set())}
                    />
                    <FilterPopover
                        label="Rank"
                        icon="fa-medal"
                        options={sortedRanks.map(r => ({ id: r.id, name: r.name }))}
                        selected={rankFilter}
                        onToggle={toggleRankFilter}
                        onClear={() => setRankFilter(new Set())}
                    />
                    {/* Sort segmented control */}
                    <div className="flex bg-slate-900/60 rounded-lg border border-slate-700 p-0.5">
                        {matchKeyword && (
                            <button
                                onClick={() => setSortMode('match')}
                                title={`Surface members whose specialisations match "${matchKeyword}"`}
                                className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${
                                    sortMode === 'match' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'
                                }`}
                            >
                                <i className="fa-solid fa-bullseye mr-1"></i>Match
                            </button>
                        )}
                        <button
                            onClick={() => setSortMode('rank')}
                            className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${
                                sortMode === 'rank' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'
                            }`}
                        >
                            Rank
                        </button>
                        <button
                            onClick={() => setSortMode('name')}
                            className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${
                                sortMode === 'name' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'
                            }`}
                        >
                            Name
                        </button>
                    </div>
                </div>
                <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                    {onDutyMembers.length} on duty
                    {(unitFilter.size > 0 || rankFilter.size > 0 || debouncedSearch) && ` matching`}
                </div>
            </div>

            {/* On-duty list — owns its own scroll container so VirtualizedList's
                tall inner div doesn't push the off-duty toggle below the fold. */}
            <div id="member-picker-list" className="flex-1 min-h-0 overflow-y-auto custom-scrollbar relative">
                {onDutyMembers.length > 0 ? (
                    <VirtualizedList<User>
                        items={onDutyMembers}
                        itemHeight={56}
                        scrollContainerId="member-picker-list"
                        renderItem={(member) => (
                            <MemberRow
                                member={member}
                                isAssigned={assignedIds.has(member.id)}
                                isPending={pendingToggle.has(member.id)}
                                isDutyPending={pendingDuty.has(member.id)}
                                allowDutyToggle={allowDutyToggle}
                                onClick={() => handleRowClick(member)}
                                onDutyToggle={(e) => handleDutyToggle(member, e)}
                            />
                        )}
                    />
                ) : (
                    /* Flow layout (not absolute) so the empty state contributes
                       intrinsic height — keeps the off-duty section reachable
                       in tight viewports rather than being squeezed by an
                       absolutely-positioned overlay that fills its flex parent. */
                    <div className="flex items-center justify-center px-6 py-8">
                        <EmptyState
                            icon="fa-user-slash"
                            accent="emerald"
                            heading="No on-duty members match"
                            description={debouncedSearch || unitFilter.size > 0 || rankFilter.size > 0 ? 'Try clearing filters or expanding to off-duty.' : 'No members are currently on duty.'}
                            compact
                        />
                    </div>
                )}
            </div>

            {/* Off-duty section — lifted out of the on-duty scroll container so
                the toggle button stays clickable regardless of on-duty list
                length. When expanded, off-duty has its own bounded scroll region. */}
            {totalOffDuty > 0 && (
                <div className="shrink-0 border-t border-slate-800/60">
                    <button
                        onClick={() => { setShowOffDuty(s => !s); setHasUserToggledOffDuty(true); }}
                        className="w-full flex items-center justify-between px-4 py-3 text-[11px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 transition-colors"
                    >
                        <span>
                            <i className={`fa-solid fa-chevron-${showOffDuty ? 'up' : 'down'} mr-2 text-[9px]`}></i>
                            Off Duty ({offDutyMembers.length}{offDutyMembers.length !== totalOffDuty ? ` of ${totalOffDuty}` : ''})
                        </span>
                        {allowDutyToggle && showOffDuty && (
                            <span className="text-[9px] font-mono text-slate-500 normal-case">
                                Click <i className="fa-solid fa-power-off mx-1"></i> to bring on duty
                            </span>
                        )}
                    </button>
                    {showOffDuty && (
                        <div className="max-h-64 overflow-y-auto custom-scrollbar border-t border-slate-800/40">
                            {!hasActiveFilter ? (
                                /* Off-duty list is gated on an active search/filter so a
                                   500-member org doesn't dump 495 names into the scroll
                                   region. Dispatchers typically know who they're looking
                                   for or which specialty they need — search is faster than
                                   scanning a wall of names. */
                                <div className="px-4 py-6 text-center">
                                    <i className="fa-solid fa-magnifying-glass text-2xl text-slate-700 mb-2"></i>
                                    <p className="text-[11px] text-slate-500 leading-relaxed">
                                        Use the search box or filter chips above to find
                                        specific off-duty members from the {totalOffDuty} available.
                                    </p>
                                    <button
                                        onClick={() => searchRef.current?.focus()}
                                        className="mt-2 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 uppercase tracking-widest"
                                    >
                                        Focus search
                                    </button>
                                </div>
                            ) : offDutyMembers.length > 0 ? (
                                offDutyMembers.map(member => (
                                    <OffDutyRow
                                        key={member.id}
                                        member={member}
                                        isDutyPending={pendingDuty.has(member.id)}
                                        allowDutyToggle={allowDutyToggle}
                                        onDutyToggle={(e) => handleDutyToggle(member, e)}
                                    />
                                ))
                            ) : (
                                <p className="text-[11px] text-slate-600 italic px-4 py-3">No off-duty members match the current filters.</p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// -- On-duty row --
interface MemberRowProps {
    member: User;
    isAssigned: boolean;
    isPending: boolean;
    isDutyPending: boolean;
    allowDutyToggle: boolean;
    onClick: () => void;
    onDutyToggle: (e: React.MouseEvent) => void;
}

const MemberRow: React.FC<MemberRowProps> = ({ member, isAssigned, isPending, isDutyPending, allowDutyToggle, onClick, onDutyToggle }) => (
    <div
        role="option"
        aria-selected={isAssigned}
        onClick={onClick}
        className={`flex items-center justify-between h-full px-4 cursor-pointer border-b border-slate-800/40 transition-colors ${
            isAssigned
                ? 'bg-amber-500/10 border-amber-500/40 hover:bg-amber-500/15'
                : 'hover:bg-slate-800/50'
        }`}
    >
        <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="relative shrink-0">
                <img src={member.avatarUrl} alt={member.name} className={`w-9 h-9 rounded-full border-2 ${isAssigned ? 'border-amber-400' : 'border-slate-700'} object-cover`} />
                <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-900 bg-emerald-500"></div>
                {isAssigned && (
                    <div className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-500 rounded-full border border-slate-900 flex items-center justify-center">
                        <i className="fa-solid fa-check text-[7px] text-black leading-none"></i>
                    </div>
                )}
            </div>
            <div className="min-w-0 flex-1">
                <p className={`text-sm font-bold truncate ${isAssigned ? 'text-white' : 'text-slate-200'}`}>{member.name}</p>
                <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                    <span className="truncate">{member.rank?.name || 'Operative'}</span>
                    {member.specializations && member.specializations.length > 0 && (
                        <>
                            <span className="text-slate-700">·</span>
                            <span className="flex items-center gap-1.5 truncate">
                                {member.specializations.slice(0, 2).map(spec => (
                                    <span key={spec.id} className="flex items-center gap-1" title={spec.name}>
                                        <AwardIcon imageUrl={spec.imageUrl} icon={spec.icon} fallbackIcon="fa-solid fa-star" className="w-3 h-3" alt={spec.name} />
                                    </span>
                                ))}
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
            {allowDutyToggle && (
                <button
                    onClick={onDutyToggle}
                    disabled={isDutyPending}
                    title="Toggle duty (set off duty)"
                    className="p-1.5 text-emerald-400 hover:bg-emerald-500/10 rounded-sm transition-colors disabled:opacity-50"
                >
                    <i className={`fa-solid ${isDutyPending ? 'fa-circle-notch animate-spin' : 'fa-power-off'} text-xs`}></i>
                </button>
            )}
            <div className="w-6 flex justify-center">
                {isPending ? (
                    <i className="fa-solid fa-circle-notch animate-spin text-amber-400 text-xs"></i>
                ) : isAssigned ? (
                    <i className="fa-solid fa-check text-amber-400 text-sm"></i>
                ) : (
                    <i className="fa-solid fa-plus text-slate-600 text-xs"></i>
                )}
            </div>
        </div>
    </div>
);

// -- Off-duty row (compact, greyed) --
interface OffDutyRowProps {
    member: User;
    isDutyPending: boolean;
    allowDutyToggle: boolean;
    onDutyToggle: (e: React.MouseEvent) => void;
}

const OffDutyRow: React.FC<OffDutyRowProps> = ({ member, isDutyPending, allowDutyToggle, onDutyToggle }) => (
    <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/30 opacity-60 hover:opacity-90 transition-opacity">
        <div className="flex items-center gap-3 min-w-0 flex-1">
            <img src={member.avatarUrl} alt={member.name} className="w-7 h-7 rounded-full border border-slate-700 object-cover grayscale" />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-400 truncate">{member.name}</p>
                <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest truncate">{member.rank?.name || 'Operative'}</p>
            </div>
        </div>
        {allowDutyToggle && (
            <button
                onClick={onDutyToggle}
                disabled={isDutyPending}
                title="Bring on duty"
                className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-md transition-colors disabled:opacity-50"
            >
                <i className={`fa-solid ${isDutyPending ? 'fa-circle-notch animate-spin' : 'fa-power-off'} mr-1 text-[9px]`}></i>
                Bring on
            </button>
        )}
    </div>
);

export default MemberPicker;
