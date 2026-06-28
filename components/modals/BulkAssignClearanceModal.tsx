import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useAuth } from '../../contexts/AuthContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { User, UserRole } from '../../types';
import WindowFrame from '../layout/WindowFrame';
import { VirtualizedList } from '../ui/VirtualizedList';
import { useNotification } from '../../contexts/NotificationContext';

interface BulkAssignClearanceModalProps {
    isOpen: boolean;
    onClose: () => void;
}

// Inline filter popover — same shape as DutyRosterView.FilterPopover but
// scoped to this modal so it doesn't depend on extracting the helper. Used
// for the optional unit-filter chip above the member list.
const FilterPopover: React.FC<{
    label: string;
    icon: string;
    options: { id: number; name: string }[];
    selected: Set<number>;
    onToggle: (id: number) => void;
    onClear: () => void;
}> = ({ label, icon, options, selected, onToggle, onClear }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);
    const count = selected.size;
    const summary = count === 0 ? `All ${label}s` : count === 1
        ? options.find(o => selected.has(o.id))?.name || `1 ${label}`
        : `${count} ${label}s`;
    return (
        <div ref={ref} className="relative">
            <button type="button" onClick={() => setOpen(o => !o)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[11px] font-bold uppercase tracking-wider transition-colors ${
                    count > 0
                        ? 'bg-red-500/10 text-red-200 border-red-500/30'
                        : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:text-slate-200'
                }`}>
                <i className={`fa-solid ${icon} text-[10px]`}></i>
                <span className="truncate max-w-[120px]">{summary}</span>
                <i className={`fa-solid fa-chevron-${open ? 'up' : 'down'} text-[8px] opacity-60`}></i>
            </button>
            {open && (
                <div className="absolute z-30 top-full left-0 mt-1 w-56 max-h-72 overflow-y-auto custom-scrollbar bg-slate-900 border border-slate-700 rounded-lg shadow-xl shadow-black/50 p-2 animate-fade-in">
                    {count > 0 && (
                        <button type="button" onClick={onClear}
                            className="w-full text-left text-[10px] font-bold text-slate-500 hover:text-amber-300 uppercase tracking-wider px-2 py-1 rounded-sm hover:bg-slate-800/50 transition-colors mb-1">
                            <i className="fa-solid fa-xmark mr-1"></i>Clear all
                        </button>
                    )}
                    {options.length === 0 ? (
                        <p className="text-[11px] text-slate-600 italic p-2">No {label.toLowerCase()}s.</p>
                    ) : options.map(opt => (
                        <label key={opt.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer hover:text-white p-1.5 rounded-sm hover:bg-slate-800/50 transition-colors">
                            <input type="checkbox" checked={selected.has(opt.id)} onChange={() => onToggle(opt.id)}
                                className="rounded-sm bg-slate-800 border-slate-600 text-red-500 focus:ring-0" />
                            <span className="truncate">{opt.name}</span>
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
};

const BulkAssignClearanceModal: React.FC<BulkAssignClearanceModalProps> = ({ isOpen, onClose }) => {
    const { rpcAction, refreshMainState } = useData();
    const { allUsers, units, securityClearances, limitingMarkers } = useMembers();
    const { addToast, confirm } = useNotification();
    const { hasPermission } = useAuth();

    const [selected, setSelected] = useState<Set<number>>(() => new Set());
    const [search, setSearch] = useState('');
    const debouncedSearch = useDebouncedValue(search, 200);
    const [unitFilter, setUnitFilter] = useState<Set<number>>(() => new Set());
    // 'unchanged' = leave the level alone server-side (sends undefined).
    // 'clear' = explicitly clear (sends null).
    // numeric string = set to that level id.
    const [levelChoice, setLevelChoice] = useState<'unchanged' | 'clear' | string>('unchanged');
    const [markerIds, setMarkerIds] = useState<Set<number>>(() => new Set());
    const [markerMode, setMarkerMode] = useState<'replace' | 'add'>('replace');
    const [submitting, setSubmitting] = useState(false);

    // Reset state every time the modal closes so the next open is clean.
    // These are transient local form fields (member selection, search, filters,
    // pending level/marker choices) — not auth/session state; the permission
    // gate below is unaffected. Implemented with the React "adjust state during
    // render" pattern (prev-value tracker): when isOpen transitions to false the
    // fields are re-seeded to their initial values before paint, equivalent to
    // the old reset-on-close effect.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (!isOpen) {
            setSelected(new Set());
            setSearch('');
            setUnitFilter(new Set());
            setLevelChoice('unchanged');
            setMarkerIds(new Set());
            setMarkerMode('replace');
            setSubmitting(false);
        }
    }

    // Filtered member list — clients are excluded since they don't carry
    // clearance, mirroring AdminUserDetailView's scope.
    const visibleMembers = useMemo(() => {
        const term = debouncedSearch.trim().toLowerCase();
        return allUsers
            .filter(u => u.role !== UserRole.Client)
            .filter(u => {
                if (unitFilter.size > 0) {
                    if (!u.unit || !unitFilter.has(u.unit.id)) return false;
                }
                if (!term) return true;
                return u.name.toLowerCase().includes(term)
                    || u.rsiHandle.toLowerCase().includes(term)
                    || (u.rank?.name || '').toLowerCase().includes(term);
            })
            .sort((a, b) => {
                const ra = a.rank?.sortOrder ?? 9999;
                const rb = b.rank?.sortOrder ?? 9999;
                if (ra !== rb) return ra - rb;
                return a.name.localeCompare(b.name);
            });
    }, [allUsers, debouncedSearch, unitFilter]);

    const sortedUnits = useMemo(() =>
        [...units].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)),
    [units]);

    const toggleMember = useCallback((id: number) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);
    const toggleUnit = useCallback((id: number) => {
        setUnitFilter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);
    const toggleMarker = useCallback((id: number) => {
        setMarkerIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const allVisibleSelected = visibleMembers.length > 0 && visibleMembers.every(m => selected.has(m.id));
    const handleSelectAllVisible = () => {
        setSelected(prev => {
            const next = new Set(prev);
            if (allVisibleSelected) {
                visibleMembers.forEach(m => next.delete(m.id));
            } else {
                visibleMembers.forEach(m => next.add(m.id));
            }
            return next;
        });
    };

    const canSubmit = selected.size > 0 && !submitting && (levelChoice !== 'unchanged' || markerIds.size > 0 || markerMode === 'replace');

    const summarizeAction = (): string => {
        const parts: string[] = [];
        if (levelChoice === 'clear') parts.push('clear clearance level');
        else if (levelChoice !== 'unchanged') {
            const lvl = securityClearances.find(c => c.id.toString() === levelChoice);
            if (lvl) parts.push(`set Level ${lvl.level} (${lvl.name})`);
        }
        const codes = Array.from(markerIds).map(id => limitingMarkers.find(m => m.id === id)?.code).filter(Boolean);
        if (markerMode === 'replace') {
            parts.push(codes.length > 0 ? `replace markers with [${codes.join(', ')}]` : 'clear all markers');
        } else if (codes.length > 0) {
            parts.push(`add markers [${codes.join(', ')}]`);
        }
        return parts.length > 0 ? parts.join(' and ') : '(no changes)';
    };

    const handleSubmit = async () => {
        if (!canSubmit) return;
        const confirmed = await confirm({
            title: 'Apply Bulk Clearance Update',
            message: `Apply: ${summarizeAction()} to ${selected.size} member${selected.size === 1 ? '' : 's'}?`,
            confirmText: 'Apply',
            variant: 'danger',
        });
        if (!confirmed) return;

        setSubmitting(true);
        try {
            const levelId =
                levelChoice === 'unchanged' ? undefined :
                levelChoice === 'clear' ? null :
                parseInt(levelChoice);
            const result: { updated?: number; total?: number } = await rpcAction('admin:bulk_update_user_clearances', {
                targetUserIds: Array.from(selected),
                levelId,
                markerIds: Array.from(markerIds),
                markerMode,
            });
            const updated = typeof result?.updated === 'number' ? result.updated : selected.size;
            const total = typeof result?.total === 'number' ? result.total : selected.size;
            await refreshMainState();
            if (updated < total) {
                addToast(
                    'Partial update',
                    <i className="fa-solid fa-triangle-exclamation"></i>,
                    'bg-amber-500/10 text-amber-300 border-amber-500/50',
                    { description: `Updated ${updated} of ${total} members. See console for skipped users.` }
                );
            } else {
                addToast(
                    'Clearance updated',
                    <i className="fa-solid fa-check"></i>,
                    'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
                    { description: `${updated} member${updated === 1 ? '' : 's'} updated.` }
                );
            }
            onClose();
        } catch (err: any) {
            console.error('[BulkAssignClearance] failed:', err);
            addToast('Update Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not apply the bulk update.' });
        } finally {
            setSubmitting(false);
        }
    };

    if (!hasPermission('admin:user:manage_clearance')) return null;

    const labelClass = 'block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2';

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Bulk Assign Clearance"
            subtitle="Apply clearance level + markers to multiple members"
            icon="fa-solid fa-users-gear"
            color="red"
            width="max-w-3xl"
        >
            <div className="flex flex-col h-full">
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-5">
                    {/* Member picker */}
                    <div>
                        <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
                            <label className={labelClass} style={{ marginBottom: 0 }}>Members ({selected.size} selected)</label>
                            <button type="button" onClick={handleSelectAllVisible}
                                className="text-[10px] font-bold text-red-300 hover:text-red-200 uppercase tracking-wider"
                                disabled={visibleMembers.length === 0}>
                                {allVisibleSelected ? 'Deselect visible' : 'Select all visible'}
                            </button>
                        </div>
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <div className="relative flex-1 min-w-[180px]">
                                <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                                <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                                    placeholder="Search by name, handle, rank…"
                                    className="w-full bg-slate-900/60 text-white pl-9 pr-3 py-2 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 text-sm focus:ring-1 focus:ring-red-500/50 focus:border-red-500/40 transition-all" />
                            </div>
                            <FilterPopover
                                label="Unit"
                                icon="fa-people-group"
                                options={sortedUnits.map(u => ({ id: u.id, name: u.name }))}
                                selected={unitFilter}
                                onToggle={toggleUnit}
                                onClear={() => setUnitFilter(new Set())}
                            />
                        </div>
                        <div id="bulk-clearance-list" className="bg-slate-950/40 border border-slate-800 rounded-lg max-h-[300px] overflow-y-auto custom-scrollbar">
                            {visibleMembers.length === 0 ? (
                                <p className="p-6 text-center text-xs text-slate-500 italic">No members match the current filters.</p>
                            ) : (
                                <VirtualizedList<User>
                                    items={visibleMembers}
                                    itemHeight={48}
                                    scrollContainerId="bulk-clearance-list"
                                    renderItem={(member) => {
                                        const isSel = selected.has(member.id);
                                        return (
                                            <label className={`flex items-center gap-3 h-full px-3 cursor-pointer border-b border-slate-800/60 transition-colors ${isSel ? 'bg-red-500/[0.07]' : 'hover:bg-slate-800/40'}`}>
                                                <input type="checkbox" checked={isSel} onChange={() => toggleMember(member.id)}
                                                    className="h-4 w-4 rounded-sm bg-slate-800 border-slate-600 text-red-500 focus:ring-0" />
                                                <img src={member.avatarUrl} className="w-7 h-7 rounded-full border border-slate-700 object-cover" alt="" />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-bold text-slate-200 truncate">{member.name}</p>
                                                    <p className="text-[10px] text-slate-500 font-mono truncate">
                                                        {member.rank?.name || 'Unranked'} · {member.unit?.name || 'Unassigned'}
                                                    </p>
                                                </div>
                                                {member.clearanceLevel && (
                                                    <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-slate-800 text-slate-300 border border-slate-700 whitespace-nowrap">
                                                        L{member.clearanceLevel.level}
                                                    </span>
                                                )}
                                            </label>
                                        );
                                    }}
                                />
                            )}
                        </div>
                    </div>

                    {/* Clearance level */}
                    <div>
                        <label className={labelClass}>Clearance Level</label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            <LevelChoice
                                value="unchanged"
                                current={levelChoice}
                                onChange={setLevelChoice}
                                label="No change"
                                hint="Leave each member's level alone"
                            />
                            <LevelChoice
                                value="clear"
                                current={levelChoice}
                                onChange={setLevelChoice}
                                label="Clear"
                                hint="Remove level"
                                accent="amber"
                            />
                            {securityClearances.map(c => (
                                <LevelChoice
                                    key={c.id}
                                    value={c.id.toString()}
                                    current={levelChoice}
                                    onChange={setLevelChoice}
                                    label={`L${c.level} ${c.name}`}
                                    accent="red"
                                />
                            ))}
                        </div>
                    </div>

                    {/* Markers */}
                    <div>
                        <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
                            <label className={labelClass} style={{ marginBottom: 0 }}>Limiting Markers</label>
                            <div className="flex items-center gap-1 bg-slate-900/60 rounded-lg border border-slate-700 p-0.5">
                                {(['replace', 'add'] as const).map(mode => (
                                    <button key={mode} type="button" onClick={() => setMarkerMode(mode)}
                                        className={`px-3 py-1 rounded text-[10px] font-black uppercase tracking-wider transition-colors ${
                                            markerMode === mode
                                                ? 'bg-red-500/20 text-red-200 border border-red-500/30'
                                                : 'text-slate-500 hover:text-slate-300 border border-transparent'
                                        }`}>
                                        {mode === 'replace' ? 'Replace' : 'Add'}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <p className="text-[10px] text-slate-500 italic mb-2">
                            {markerMode === 'replace'
                                ? 'Each member\'s markers will be REPLACED with the selected set (existing markers cleared).'
                                : 'Selected markers will be ADDED to each member; existing markers are not removed.'}
                        </p>
                        {limitingMarkers.length === 0 ? (
                            <p className="text-[11px] text-slate-600 italic">No limiting markers defined.</p>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {limitingMarkers.map(m => {
                                    const sel = markerIds.has(m.id);
                                    return (
                                        <button key={m.id} type="button" onClick={() => toggleMarker(m.id)}
                                            className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
                                                sel
                                                    ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                                                    : 'bg-slate-950/40 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                                            }`}>
                                            <div className="min-w-0">
                                                <span className="text-xs font-mono font-bold block truncate">{m.code}</span>
                                                <span className="text-[10px] text-slate-500 block truncate">{m.name}</span>
                                            </div>
                                            {m.syncRestricted && (
                                                <span className="text-[8px] bg-red-500/10 text-red-300 border border-red-500/30 px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-bold shrink-0">
                                                    No Sync
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex items-center justify-between gap-3 rounded-b-xl">
                    <span className="text-[10px] text-slate-500 italic truncate">
                        {selected.size === 0 ? 'Pick members above to enable Apply.' : summarizeAction()}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                        <button onClick={onClose} disabled={submitting}
                            className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-white transition-colors">
                            Cancel
                        </button>
                        <button onClick={handleSubmit} disabled={!canSubmit}
                            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-red-600 hover:bg-red-500 border border-red-500/40 text-white text-[11px] font-bold uppercase tracking-wider shadow-lg shadow-red-900/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none">
                            {submitting
                                ? <><i className="fa-solid fa-spinner animate-spin"></i> Applying</>
                                : <><i className="fa-solid fa-users-gear"></i> Apply to {selected.size}</>}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

const LevelChoice: React.FC<{
    value: string;
    current: string;
    onChange: (v: string) => void;
    label: string;
    hint?: string;
    accent?: 'red' | 'amber';
}> = ({ value, current, onChange, label, hint, accent }) => {
    const isActive = current === value;
    const accentClasses = accent === 'amber'
        ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
        : accent === 'red'
            ? 'bg-red-500/10 border-red-500/40 text-red-200'
            : 'bg-slate-700/40 border-slate-500 text-white';
    return (
        <button type="button" onClick={() => onChange(value)}
            className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded-lg border text-left transition-colors ${
                isActive
                    ? accentClasses
                    : 'bg-slate-950/40 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}>
            <span className="text-xs font-bold truncate w-full">{label}</span>
            {hint && <span className="text-[9px] text-slate-500 truncate w-full">{hint}</span>}
        </button>
    );
};

export default BulkAssignClearanceModal;
