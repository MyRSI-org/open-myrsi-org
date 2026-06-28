
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useFleet } from '../../../contexts/FleetContext';

import { PlatformShip, UserShip, FleetGroup, ShipStatus, FleetGroupType, UserRole } from '../../../types';
import { ShipCard } from './ShipCard';
import ShipCatalogBrowser from './ShipCatalogBrowser';
import FleetOrgChart from './FleetOrgChart';
import WindowFrame from '../../layout/WindowFrame';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import { useNotification } from '../../../contexts/NotificationContext';

type FleetTab = 'hangar' | 'fleet' | 'organization';

// Stable keys for the fixed-length loading-skeleton placeholders. These rows
// carry no data and are never reordered or filtered, so module-scope constant
// keys are the correct stable identity (instead of the array index).
const STAT_SKELETON_KEYS = ['s0', 's1', 's2', 's3'] as const;
const CARD_SKELETON_KEYS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] as const;

interface AssignShipsPickerProps {
    assigningGroup: FleetGroup;
    userShips: UserShip[];
    assignSearch: string;
    setAssignSearch: (value: string) => void;
    assignExpandedOwners: Set<number>;
    setAssignExpandedOwners: (next: Set<number>) => void;
    toggleAssignOwner: (userId: number) => void;
    onAssign: (fleetGroupId: number, userShipId: number) => void;
}

/**
 * Owner-grouped + searchable ship picker for the "Assign Ships" modal. Extracted
 * from an inline render IIFE so the React Compiler can optimise it as a normal
 * component. Pure render: identical markup and behaviour to the previous inline
 * block; all editable state still lives in the parent and is passed via props.
 */
const AssignShipsPicker: React.FC<AssignShipsPickerProps> = ({
    assigningGroup,
    userShips,
    assignSearch,
    setAssignSearch,
    assignExpandedOwners,
    setAssignExpandedOwners,
    toggleAssignOwner,
    onAssign,
}) => {
    const assignedIds = new Set((assigningGroup.assignedShips || []).map(a => a.id));
    const available = userShips.filter(s => !assignedIds.has(s.id));
    const term = assignSearch.trim().toLowerCase();

    // Groups keyed by userId → { user, ships[], hasMatch }
    interface OwnerBucket { userId: number; userName: string; avatarUrl?: string; ships: UserShip[]; hasMatch: boolean }
    const bucketMap = new Map<number, OwnerBucket>();
    for (const s of available) {
        const userId = s.userId;
        const userName = s.user?.name || 'Unknown';
        const b = bucketMap.get(userId);
        const nameMatch = term ? (
            (s.customName || '').toLowerCase().includes(term)
            || (s.ship?.name || '').toLowerCase().includes(term)
            || (s.ship?.manufacturer || '').toLowerCase().includes(term)
            || userName.toLowerCase().includes(term)
        ) : false;
        if (b) {
            b.ships.push(s);
            b.hasMatch = b.hasMatch || nameMatch;
        } else {
            bucketMap.set(userId, {
                userId,
                userName,
                avatarUrl: s.user?.avatarUrl,
                ships: [s],
                hasMatch: nameMatch,
            });
        }
    }
    const buckets = Array.from(bucketMap.values()).sort((a, b) => a.userName.localeCompare(b.userName));

    // When searching, filter ships within each bucket and show only buckets
    // that have any match. Also auto-expand those buckets.
    const filteredBuckets = term
        ? buckets
            .map(b => ({
                ...b,
                ships: b.ships.filter(s =>
                    (s.customName || '').toLowerCase().includes(term)
                    || (s.ship?.name || '').toLowerCase().includes(term)
                    || (s.ship?.manufacturer || '').toLowerCase().includes(term)
                    || b.userName.toLowerCase().includes(term)
                ),
            }))
            .filter(b => b.ships.length > 0)
        : buckets;

    const isExpanded = (userId: number) => !!term || assignExpandedOwners.has(userId);

    return (
        <div className="flex flex-col" style={{ maxHeight: 'calc(70vh - 60px)' }}>
            {available.length > 0 && (
                <div className="p-3 border-b border-slate-800/60 shrink-0">
                    <div className="relative">
                        <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                        <input
                            type="search"
                            value={assignSearch}
                            onChange={(e) => setAssignSearch(e.target.value)}
                            placeholder="Search ships, owners, manufacturers…"
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/40 outline-hidden"
                        />
                    </div>
                    <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                            {filteredBuckets.reduce((sum, b) => sum + b.ships.length, 0)} ships · {filteredBuckets.length} owners
                        </span>
                        {!term && assignExpandedOwners.size > 0 && (
                            <button
                                onClick={() => setAssignExpandedOwners(new Set())}
                                className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
                            >
                                Collapse all
                            </button>
                        )}
                        {!term && assignExpandedOwners.size === 0 && filteredBuckets.length > 0 && (
                            <button
                                onClick={() => setAssignExpandedOwners(new Set(filteredBuckets.map(b => b.userId)))}
                                className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
                            >
                                Expand all
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {available.length === 0 ? (
                    <EmptyState
                        icon="fa-circle-check"
                        accent="emerald"
                        heading="All ships assigned"
                        description="Every ship in the org is already in a fleet group."
                        compact
                    />
                ) : filteredBuckets.length === 0 ? (
                    <EmptyState
                        icon="fa-filter"
                        accent="slate"
                        heading="No matches"
                        description="Try a different search term."
                        compact
                    />
                ) : filteredBuckets.map(b => {
                    const expanded = isExpanded(b.userId);
                    return (
                        <div key={b.userId} className="bg-slate-900/60 border border-slate-700/50 rounded-lg overflow-hidden">
                            <button
                                onClick={() => toggleAssignOwner(b.userId)}
                                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-800/60 transition-colors"
                            >
                                {b.avatarUrl && (
                                    <img src={b.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-white truncate">{b.userName}</p>
                                    <p className="text-[10px] text-slate-500 font-mono">{b.ships.length} {b.ships.length === 1 ? 'ship' : 'ships'}</p>
                                </div>
                                <i className={`fa-solid fa-chevron-${expanded ? 'up' : 'down'} text-slate-500 text-xs shrink-0`}></i>
                            </button>
                            {expanded && (
                                <div className="border-t border-slate-800/80 divide-y divide-slate-800/60">
                                    {b.ships.map(us => (
                                        <div key={us.id} className="flex items-center justify-between p-3 hover:bg-slate-800/40 transition-colors">
                                            <div className="flex items-center gap-3 min-w-0">
                                                {us.ship?.imageUrl && (
                                                    <img src={us.ship.imageUrl} alt="" className="w-10 h-7 object-cover rounded-sm opacity-70 shrink-0" />
                                                )}
                                                <div className="min-w-0">
                                                    <p className="text-sm font-bold text-white truncate">{us.customName || us.ship?.name}</p>
                                                    <p className="text-[10px] text-slate-500 truncate">
                                                        {us.customName && us.ship?.name ? <><span className="text-orange-300/80 font-mono">{us.ship.name}</span> · </> : null}
                                                        {us.ship?.manufacturer}
                                                    </p>
                                                </div>
                                            </div>
                                            <button onClick={() => onAssign(assigningGroup.id, us.id)}
                                                className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-orange-300 bg-orange-500/10 border border-orange-500/30 hover:bg-orange-500/20 rounded-lg transition-colors shrink-0">
                                                <i className="fa-solid fa-plus"></i>Assign
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const FleetManagerView: React.FC = () => {
    const { currentUser, hasPermission } = useAuth();
    const { rpcAction } = useData();
    const { allUsers } = useMembers();
    const { shipCatalog, userShips, fleetGroups, refreshFleet } = useFleet();
    const { addToast, confirm } = useNotification();
    const [activeTab, setActiveTab] = useState<FleetTab>('hangar');
    const [showCatalog, setShowCatalog] = useState(false);
    const [editingShip, setEditingShip] = useState<UserShip | null>(null);
    const [editForm, setEditForm] = useState({ customName: '', loadoutNotes: '', status: 'Active' as ShipStatus });
    const [filterManufacturer, setFilterManufacturer] = useState('');
    const [filterSize, setFilterSize] = useState('');
    const [groupBy, setGroupBy] = useState<'none' | 'member' | 'manufacturer' | 'role'>('none');
    const [searchTerm, setSearchTerm] = useState('');

    const [showGroupModal, setShowGroupModal] = useState(false);
    const [editingGroup, setEditingGroup] = useState<FleetGroup | null>(null);
    const [groupForm, setGroupForm] = useState({ name: '', type: 'Custom' as string, description: '', commanderId: '', parentId: '' });
    const [assigningGroup, setAssigningGroup] = useState<FleetGroup | null>(null);
    const [isBusy, setIsBusy] = useState(false);
    const [selectMode, setSelectMode] = useState(false);
    const [selectedShips, setSelectedShips] = useState<Set<number>>(() => new Set());

    // Org Fleet display mode — "stacked" (default) collapses duplicates of the
    // same platform ship into one card with a count, avoiding the 20-Arrow wall
    // of cards. "individual" is the legacy one-card-per-instance view.
    const [fleetViewMode, setFleetViewMode] = useState<'stacked' | 'individual'>('stacked');
    /** Per-group (groupName + shipId) expansion state for stacked cards. */
    const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
    const toggleStack = useCallback((key: string) => {
        setExpandedStacks(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    // Unassigned Ships panel collapse state — on by default; auto-collapsed
    // when the list is large to keep the chart workspace usable.
    const [unassignedExpanded, setUnassignedExpanded] = useState(true);

    // Assign-to-Group picker state
    const [assignSearch, setAssignSearch] = useState('');
    const [assignExpandedOwners, setAssignExpandedOwners] = useState<Set<number>>(() => new Set());
    const toggleAssignOwner = useCallback((userId: number) => {
        setAssignExpandedOwners(prev => {
            const next = new Set(prev);
            if (next.has(userId)) next.delete(userId); else next.add(userId);
            return next;
        });
    }, []);
    // Reset search + collapse owners when the modal closes/opens on a new group.
    // Done with a render-time previous-id tracker (React's "adjust state during
    // render" pattern) so the reset happens before paint without an effect — and
    // covers the same transitions the effect did (null->id, id->id', id->null).
    const assigningGroupId = assigningGroup?.id;
    const [prevAssigningGroupId, setPrevAssigningGroupId] = useState(assigningGroupId);
    if (assigningGroupId !== prevAssigningGroupId) {
        setPrevAssigningGroupId(assigningGroupId);
        setAssignSearch('');
        setAssignExpandedOwners(new Set());
    }

    const canManageOwn = hasPermission('fleet:manage_own');
    const canViewFleet = hasPermission('fleet:view');
    const canManageFleet = hasPermission('fleet:manage');

    const [isInitialLoading, setIsInitialLoading] = useState(true);
    useEffect(() => { Promise.resolve(refreshFleet()).finally(() => setIsInitialLoading(false)); }, [refreshFleet]);

    const myShips = useMemo(() =>
        userShips.filter(s => s.userId === currentUser?.id),
    [userShips, currentUser]);

    const handleAddShips = useCallback(async (ships: PlatformShip[]) => {
        if (isBusy || ships.length === 0) return;
        setIsBusy(true);
        try {
            if (ships.length === 1) {
                await rpcAction('fleet:add_ship', { shipId: ships[0].id });
            } else {
                await rpcAction('fleet:add_ships', { shipIds: ships.map(s => s.id) });
            }
            await refreshFleet();
            setShowCatalog(false);
            const msg = ships.length === 1 ? `${ships[0].name} added to your hangar` : `${ships.length} ships added to your hangar`;
            addToast('Ship Added', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: msg });
        } catch (e: any) {
            addToast('Add Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to add ships to your hangar.' });
        } finally {
            setIsBusy(false);
        }
    }, [isBusy, rpcAction, refreshFleet, addToast]);

    const handleUpdateShip = useCallback(async () => {
        if (!editingShip || isBusy) return;
        setIsBusy(true);
        try {
            await rpcAction('fleet:update_ship', { userShipId: editingShip.id, updates: editForm });
            await refreshFleet();
            setEditingShip(null);
            addToast('Ship Updated', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: 'Ship details have been saved.' });
        } catch (e: any) { addToast('Update Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to update the ship.' }); }
        finally { setIsBusy(false); }
    }, [editingShip, editForm, isBusy, rpcAction, refreshFleet, addToast]);

    const handleRemoveShip = useCallback(async (id: number) => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            await rpcAction('fleet:remove_ship', { userShipId: id });
            await refreshFleet();
            addToast('Ship Removed', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: 'The ship has been removed from your hangar.' });
        } catch (e: any) { addToast('Remove Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to remove the ship.' }); }
        finally { setIsBusy(false); }
    }, [isBusy, rpcAction, refreshFleet, addToast]);

    const handleBulkRemoveShips = useCallback(async () => {
        if (isBusy || selectedShips.size === 0) return;
        setIsBusy(true);
        try {
            await rpcAction('fleet:remove_ships', { userShipIds: Array.from(selectedShips) });
            await refreshFleet();
            addToast('Ships Removed', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: `${selectedShips.size} ship${selectedShips.size > 1 ? 's' : ''} removed from your hangar.` });
            setSelectedShips(new Set());
            setSelectMode(false);
        } catch (e: any) { addToast('Remove Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to remove the selected ships.' }); }
        finally { setIsBusy(false); }
    }, [isBusy, selectedShips, rpcAction, refreshFleet, addToast]);

    const toggleShipSelection = useCallback((id: number) => {
        setSelectedShips(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const handleSaveGroup = useCallback(async () => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            const payload = { ...groupForm, commanderId: groupForm.commanderId ? parseInt(groupForm.commanderId) : null, parentId: groupForm.parentId ? parseInt(groupForm.parentId) : null };
            if (editingGroup) {
                await rpcAction('fleet:update_group', { groupId: editingGroup.id, updates: payload });
            } else {
                await rpcAction('fleet:create_group', { groupData: payload });
            }
            await refreshFleet();
            setShowGroupModal(false);
            setEditingGroup(null);
            addToast(editingGroup ? 'Group Updated' : 'Group Created', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: editingGroup ? 'Fleet group settings have been saved.' : 'A new fleet group has been created.' });
        } catch (e: any) { addToast('Group Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to save fleet group.' }); }
        finally { setIsBusy(false); }
    }, [isBusy, editingGroup, groupForm, rpcAction, refreshFleet, addToast]);

    const handleDeleteGroup = useCallback(async (id: number) => {
        if (isBusy) return;

        // Pre-flight counts from local state so the admin sees exactly what
        // the cascade will touch. assignedShips covers the ON DELETE CASCADE
        // on fleet_group_ships; childCount covers the server's reparent step
        // (children get promoted to the deleted group's parent, not orphaned).
        const target = fleetGroups.find(g => g.id === id);
        const groupName = target?.name || 'this group';
        const shipCount = target?.assignedShips?.length || 0;
        const childCount = fleetGroups.filter(g => g.parentId === id).length;

        let message = `Permanently delete the fleet group "${groupName}"? This cannot be undone.`;
        if (shipCount > 0 || childCount > 0) {
            const parts: string[] = [];
            if (shipCount > 0) parts.push(`${shipCount} ship${shipCount === 1 ? '' : 's'} will be unassigned (they will remain in their owners' hangars)`);
            if (childCount > 0) parts.push(`${childCount} sub-group${childCount === 1 ? '' : 's'} will be promoted to the parent level`);
            message = `Delete the fleet group "${groupName}"? ${parts.join('; ')}. This cannot be undone.`;
        }

        const confirmed = await confirm({
            title: 'Delete Fleet Group',
            message,
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (!confirmed) return;

        setIsBusy(true);
        try {
            await rpcAction('fleet:delete_group', { groupId: id });
            await refreshFleet();
            addToast('Group Deleted', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: 'The fleet group has been deleted.' });
        } catch (e: any) { addToast('Delete Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to delete the fleet group.' }); }
        finally { setIsBusy(false); }
    }, [isBusy, fleetGroups, confirm, rpcAction, refreshFleet, addToast]);

    const handleAssignShip = useCallback(async (fleetGroupId: number, userShipId: number) => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            await rpcAction('fleet:assign_ship', { fleetGroupId, userShipId });
            await refreshFleet();
            addToast('Ship Assigned', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: 'The ship has been assigned to the fleet group.' });
        } catch (e: any) { addToast('Assign Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to assign the ship.' }); }
        finally { setIsBusy(false); }
    }, [isBusy, rpcAction, refreshFleet, addToast]);

    const handleUnassignShip = useCallback(async (fleetGroupId: number, userShipId: number) => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            await rpcAction('fleet:unassign_ship', { fleetGroupId, userShipId });
            await refreshFleet();
            addToast('Ship Unassigned', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: 'The ship has been removed from the fleet group.' });
        } catch (e: any) { addToast('Unassign Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to unassign the ship.' }); }
        finally { setIsBusy(false); }
    }, [isBusy, rpcAction, refreshFleet, addToast]);

    // Drag-and-drop reorder/reparent for the org chart. Each handler is a thin
    // wrapper around the RPC + toast, mirroring the pattern above. The chart is
    // responsible for computing the new ordered id list before calling these.
    const handleReorderGroups = useCallback(async (orderedIds: number[]) => {
        try {
            await rpcAction('fleet:reorder_groups', { orderedIds });
            await refreshFleet();
        } catch (e: any) {
            addToast('Reorder Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to save the new order.' });
        }
    }, [rpcAction, refreshFleet, addToast]);

    const handleReparentGroup = useCallback(async (groupId: number, newParentId: number | null, newSortOrder: number) => {
        try {
            await rpcAction('fleet:reparent_group', { groupId, newParentId, newSortOrder });
            await refreshFleet();
        } catch (e: any) {
            addToast('Move Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to move the group.' });
        }
    }, [rpcAction, refreshFleet, addToast]);

    const handleReorderGroupShips = useCallback(async (fleetGroupId: number, orderedAssignmentIds: number[]) => {
        try {
            await rpcAction('fleet:reorder_group_ships', { fleetGroupId, orderedAssignmentIds });
            await refreshFleet();
        } catch (e: any) {
            addToast('Reorder Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to save the new ship order.' });
        }
    }, [rpcAction, refreshFleet, addToast]);

    // Move a ship from one group to another by remove+assign. Two RPCs each
    // emit a fleet_update; that's acceptable for an infrequent drag operation.
    const handleMoveShipToGroup = useCallback(async (userShipId: number, fromGroupId: number, toGroupId: number) => {
        if (fromGroupId === toGroupId) return;
        try {
            await rpcAction('fleet:unassign_ship', { fleetGroupId: fromGroupId, userShipId });
            await rpcAction('fleet:assign_ship', { fleetGroupId: toGroupId, userShipId });
            await refreshFleet();
        } catch (e: any) {
            addToast('Move Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e.message || 'Failed to move the ship.' });
        }
    }, [rpcAction, refreshFleet, addToast]);

    const fleetStats = useMemo(() => {
        const byManufacturer: Record<string, number> = {};
        const byRole: Record<string, number> = {};
        const bySize: Record<string, number> = {};
        for (const us of userShips) {
            const s = us.ship;
            if (!s) continue;
            byManufacturer[s.manufacturer] = (byManufacturer[s.manufacturer] || 0) + 1;
            if (s.role) byRole[s.role] = (byRole[s.role] || 0) + 1;
            if (s.size) bySize[s.size] = (bySize[s.size] || 0) + 1;
        }
        return { byManufacturer, byRole, bySize, total: userShips.length };
    }, [userShips]);

    const filteredFleet = useMemo(() => {
        return userShips.filter(s => {
            if (filterManufacturer && s.ship?.manufacturer !== filterManufacturer) return false;
            if (filterSize && s.ship?.size !== filterSize) return false;
            if (searchTerm) {
                const term = searchTerm.toLowerCase();
                const matchName = (s.customName || s.ship?.name || '').toLowerCase().includes(term);
                const matchUser = (s.user?.name || '').toLowerCase().includes(term);
                const matchMfr = (s.ship?.manufacturer || '').toLowerCase().includes(term);
                if (!matchName && !matchUser && !matchMfr) return false;
            }
            return true;
        });
    }, [userShips, filterManufacturer, filterSize, searchTerm]);

    // Ships in user_ships that aren't in any fleet_group_ships. Surfaced on
    // the Manage Fleet tab so admins can assign or remove them — closes the
    // "I deleted a group and my ships vanished" loop, and recovers any
    // pre-existing orphans from before the cascade migration landed.
    const unassignedShips = useMemo(() => {
        const assignedIds = new Set<number>();
        for (const g of fleetGroups) {
            for (const s of g.assignedShips || []) assignedIds.add(s.id);
        }
        return userShips.filter(s => !assignedIds.has(s.id));
    }, [userShips, fleetGroups]);

    const groupedFleet = useMemo(() => {
        if (groupBy === 'none') return { '': filteredFleet };
        const groups: Record<string, UserShip[]> = {};
        for (const s of filteredFleet) {
            let key = '';
            if (groupBy === 'member') key = s.user?.name || 'Unknown';
            else if (groupBy === 'manufacturer') key = s.ship?.manufacturer || 'Unknown';
            else if (groupBy === 'role') key = s.ship?.role || 'General';
            if (!groups[key]) groups[key] = [];
            groups[key].push(s);
        }
        return groups;
    }, [filteredFleet, groupBy]);

    const tabs = useMemo(() => {
        const t: { key: FleetTab; label: string; icon: string }[] = [
            { key: 'hangar', label: 'My Hangar', icon: 'fa-solid fa-warehouse' },
        ];
        if (canViewFleet) {
            t.push({ key: 'fleet', label: 'Org Fleet', icon: 'fa-solid fa-layer-group' });
            t.push({ key: 'organization', label: 'Manage Fleet', icon: 'fa-solid fa-sitemap' });
        }
        return t;
    }, [canViewFleet]);

    const labelClass = 'block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5';
    const inputClass = 'w-full bg-slate-900/60 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-orange-500/40 focus:ring-1 focus:ring-orange-500/50 outline-hidden transition-all';
    const selectClass = 'bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-hidden focus:border-orange-500/40 focus:ring-1 focus:ring-orange-500/50 transition-all';

    const ownersCount = useMemo(() => new Set(userShips.map(s => s.userId)).size, [userShips]);

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · FLEET MANAGER"
                chipIcon="fa-rocket"
                chipAccent="orange"
                title="Fleet Manager"
                subtitle="Hangar, org fleet, and fleet group management. Ship catalog synced from the Star Citizen Wiki."
                actions={<>
                    {activeTab === 'hangar' && canManageOwn && (
                        selectMode ? (
                            <>
                                <HeroActionButton
                                    onClick={() => {
                                        const visibleIds = myShips.filter(s => {
                                            if (!searchTerm) return true;
                                            const term = searchTerm.toLowerCase();
                                            return (s.customName || s.ship?.name || '').toLowerCase().includes(term) ||
                                                (s.ship?.manufacturer || '').toLowerCase().includes(term);
                                        }).map(s => s.id);
                                        setSelectedShips(prev => prev.size === visibleIds.length ? new Set() : new Set(visibleIds));
                                    }}
                                    accent="slate"
                                    icon="fa-check-double"
                                >
                                    {selectedShips.size === myShips.length && myShips.length > 0 ? 'Deselect All' : 'Select All'}
                                </HeroActionButton>
                                <HeroActionButton
                                    onClick={handleBulkRemoveShips}
                                    disabled={selectedShips.size === 0 || isBusy}
                                    accent="red"
                                    icon="fa-trash"
                                >
                                    {isBusy ? 'Removing…' : `Delete${selectedShips.size > 0 ? ` (${selectedShips.size})` : ''}`}
                                </HeroActionButton>
                                <button onClick={() => { setSelectMode(false); setSelectedShips(new Set()); }}
                                    className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition whitespace-nowrap">
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <>
                                {myShips.length > 0 && (
                                    <HeroActionButton onClick={() => setSelectMode(true)} accent="slate" icon="fa-check-square">
                                        Select
                                    </HeroActionButton>
                                )}
                                <HeroActionButton onClick={() => setShowCatalog(true)} accent="orange" icon="fa-plus">
                                    Add Ship
                                </HeroActionButton>
                            </>
                        )
                    )}
                    {activeTab === 'organization' && canManageFleet && (
                        <HeroActionButton
                            onClick={() => { setEditingGroup(null); setGroupForm({ name: '', type: FleetGroupType.Division, description: '', commanderId: '', parentId: '' }); setShowGroupModal(true); }}
                            accent="orange"
                            icon="fa-plus"
                        >
                            Create Group
                        </HeroActionButton>
                    )}
                </>}
                stats={<>
                    <HeroStat icon="fa-warehouse" label="My Hangar" value={myShips.length} accent="orange" emphasize={myShips.length > 0} onClick={() => setActiveTab('hangar')} />
                    <HeroStat icon="fa-rocket" label="Org Ships" value={fleetStats.total} accent="sky" emphasize={fleetStats.total > 0} onClick={canViewFleet ? () => setActiveTab('fleet') : undefined} />
                    <HeroStat icon="fa-sitemap" label="Fleet Groups" value={fleetGroups.length} accent="indigo" emphasize={fleetGroups.length > 0} onClick={canViewFleet ? () => setActiveTab('organization') : undefined} />
                    <HeroStat icon="fa-users" label="Members w/ Ships" value={ownersCount} accent="emerald" emphasize={ownersCount > 0} />
                </>}
                tabs={tabs.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${activeTab === tab.key
                            ? 'text-orange-300 border-orange-400'
                            : 'text-slate-500 border-transparent hover:text-slate-300'
                            }`}
                    >
                        <i className={tab.icon}></i>
                        {tab.label}
                    </button>
                ))}
            />

            <div className={`flex-1 min-h-0 flex flex-col ${activeTab === 'organization' ? 'overflow-hidden p-4 sm:p-6 gap-6' : 'overflow-y-auto p-4 sm:p-6 space-y-6'}`}>
                {(activeTab === 'hangar' || activeTab === 'fleet') && (
                    <div className="flex flex-col lg:flex-row gap-3">
                        <div className="relative flex-1 max-w-2xl">
                            <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                            <input
                                type="search"
                                placeholder={activeTab === 'hangar' ? 'Search your hangar…' : 'Search fleet ships, owners, manufacturers…'}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="w-full bg-slate-900/60 text-white pl-12 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-500 font-mono text-sm focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/40 transition-all"
                            />
                        </div>
                        {activeTab === 'fleet' && (
                            <div className="flex flex-wrap gap-2 items-center">
                                <select value={filterManufacturer} onChange={(e) => setFilterManufacturer(e.target.value)} className={selectClass}>
                                    <option value="">All Manufacturers</option>
                                    {Object.entries(fleetStats.byManufacturer).sort((a, b) => b[1] - a[1]).map(([m, c]) => (
                                        <option key={m} value={m}>{m} ({c})</option>
                                    ))}
                                </select>
                                <select value={filterSize} onChange={(e) => setFilterSize(e.target.value)} className={selectClass}>
                                    <option value="">All Sizes</option>
                                    {Object.entries(fleetStats.bySize).sort((a, b) => b[1] - a[1]).map(([s, c]) => (
                                        <option key={s} value={s}>{s} ({c})</option>
                                    ))}
                                </select>
                                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)} className={selectClass}>
                                    <option value="none">No Grouping</option>
                                    <option value="member">By Member</option>
                                    <option value="manufacturer">By Manufacturer</option>
                                    <option value="role">By Role</option>
                                </select>
                                {/* Stacked / Individual toggle — fixes the 20×Arrow wall of cards for bulk-ship orgs. */}
                                <div className="flex items-center gap-0.5 bg-slate-900/60 border border-slate-700 rounded-lg p-0.5">
                                    <button
                                        onClick={() => setFleetViewMode('stacked')}
                                        title="Group duplicate ship types with a count"
                                        className={`px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-widest transition ${
                                            fleetViewMode === 'stacked' ? 'bg-orange-500/20 text-orange-200' : 'text-slate-400 hover:text-slate-200'
                                        }`}
                                    >
                                        <i className="fa-solid fa-layer-group mr-1" />Stacked
                                    </button>
                                    <button
                                        onClick={() => setFleetViewMode('individual')}
                                        title="Show every ship instance as its own card"
                                        className={`px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-widest transition ${
                                            fleetViewMode === 'individual' ? 'bg-orange-500/20 text-orange-200' : 'text-slate-400 hover:text-slate-200'
                                        }`}
                                    >
                                        <i className="fa-solid fa-grip mr-1" />Individual
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className={activeTab === 'organization' ? 'w-full flex-1 min-h-0 flex flex-col' : 'max-w-7xl mx-auto w-full'}>
                {isInitialLoading ? (
                    <div className="space-y-6 animate-pulse">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {STAT_SKELETON_KEYS.map(key => (
                                <div key={key} className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                                    <div className="h-8 bg-slate-800 rounded-sm w-16 mx-auto mb-2"></div>
                                    <div className="h-3 bg-slate-800 rounded-sm w-20 mx-auto"></div>
                                </div>
                            ))}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {CARD_SKELETON_KEYS.map(key => (
                                <div key={key} className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
                                    <div className="h-32 bg-slate-800"></div>
                                    <div className="p-3 space-y-2">
                                        <div className="h-4 bg-slate-800 rounded-sm w-3/4"></div>
                                        <div className="h-3 bg-slate-800/60 rounded-sm w-1/2"></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : <>
                {activeTab === 'hangar' && (
                    <div>
                        {myShips.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                                <EmptyState
                                    icon="fa-rocket"
                                    accent="orange"
                                    heading="Your hangar is empty"
                                    description="Add ships from the catalog to build your fleet."
                                    action={canManageOwn ? (
                                        <button onClick={() => setShowCatalog(true)}
                                            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-orange-600 hover:bg-orange-500 border border-orange-500/40 rounded-lg shadow-lg shadow-orange-900/30 transition">
                                            <i className="fa-solid fa-book-open"></i>Browse Catalog
                                        </button>
                                    ) : undefined}
                                />
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                {myShips.filter(s => {
                                    if (!searchTerm) return true;
                                    const term = searchTerm.toLowerCase();
                                    return (s.customName || s.ship?.name || '').toLowerCase().includes(term) ||
                                        (s.ship?.manufacturer || '').toLowerCase().includes(term);
                                }).map(us => (
                                    <div key={us.id} className={`relative group ${selectMode && selectedShips.has(us.id) ? 'ring-2 ring-orange-500 rounded-xl' : ''}`}>
                                        <ShipCard ship={us.ship!} userShip={us} onClick={selectMode ? () => toggleShipSelection(us.id) : canManageOwn ? () => {
                                            setEditingShip(us);
                                            setEditForm({ customName: us.customName || '', loadoutNotes: us.loadoutNotes || '', status: us.status });
                                        } : undefined} />
                                        {selectMode && (
                                            <button onClick={(e) => { e.stopPropagation(); toggleShipSelection(us.id); }}
                                                className={`absolute top-2 left-2 w-6 h-6 rounded-md border-2 flex items-center justify-center text-[10px] transition-all z-10 ${selectedShips.has(us.id) ? 'bg-orange-500 border-orange-500 text-white' : 'bg-slate-900/80 border-slate-500 text-transparent hover:border-orange-400'}`}>
                                                <i className="fa-solid fa-check"></i>
                                            </button>
                                        )}
                                        {!selectMode && canManageOwn && (
                                            <button onClick={(e) => { e.stopPropagation(); handleRemoveShip(us.id); }}
                                                className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 bg-red-600/80 hover:bg-red-500 text-white w-6 h-6 rounded-full text-[10px] transition-all z-10">
                                                <i className="fa-solid fa-trash"></i>
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'fleet' && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <HeroStat icon="fa-rocket" label="Total Ships" value={fleetStats.total} accent="orange" />
                            <HeroStat icon="fa-industry" label="Manufacturers" value={Object.keys(fleetStats.byManufacturer).length} accent="sky" />
                            <HeroStat icon="fa-tags" label="Ship Roles" value={Object.keys(fleetStats.byRole).length} accent="amber" />
                            <HeroStat icon="fa-users" label="Ship Owners" value={new Set(userShips.map(s => s.userId)).size} accent="emerald" />
                        </div>

                        {/* Fleet Grid — Stacked or Individual */}
                        {Object.entries(groupedFleet).map(([groupName, ships]) => {
                            // In stacked mode, collapse instances of the same platform ship into
                            // one card with a count badge and owner avatars. Individual mode keeps
                            // the legacy one-card-per-instance layout.
                            if (fleetViewMode === 'stacked') {
                                const stacks = new Map<number, UserShip[]>();
                                for (const s of ships) {
                                    const key = s.shipId;
                                    const arr = stacks.get(key);
                                    if (arr) arr.push(s); else stacks.set(key, [s]);
                                }
                                // Sort stacks: largest first, then alphabetical by ship name.
                                const stackList = Array.from(stacks.entries()).sort((a, b) => {
                                    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
                                    return (a[1][0].ship?.name || '').localeCompare(b[1][0].ship?.name || '');
                                });
                                return (
                                    <div key={groupName}>
                                        {groupName && <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 mt-4">{groupName} <span className="text-slate-600 font-mono">({ships.length})</span></h3>}
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                            {stackList.map(([shipId, instances]) => {
                                                const first = instances[0];
                                                const count = instances.length;
                                                const stackKey = `${groupName}::${shipId}`;
                                                const expanded = expandedStacks.has(stackKey);
                                                // Distinct owners with avatar; show up to 5 then "+N" overflow.
                                                const owners = Array.from(new Map(instances.map(i => [i.userId, i.user])).values())
                                                    .filter((u): u is NonNullable<typeof u> => !!u);
                                                const overflowCount = Math.max(0, owners.length - 5);
                                                return (
                                                    <div key={stackKey} className="relative">
                                                        {count > 1 ? (
                                                            <>
                                                                {/* Layered card illusion — subtle stack indicator behind the main card */}
                                                                <div className="absolute inset-0 translate-x-1 translate-y-1 bg-slate-900/40 border border-slate-800 rounded-xl pointer-events-none" aria-hidden />
                                                                <div className="absolute inset-0 translate-x-0.5 translate-y-0.5 bg-slate-900/60 border border-slate-800 rounded-xl pointer-events-none" aria-hidden />
                                                                <div className="relative">
                                                                    <ShipCard ship={first.ship!} userShip={first} />
                                                                    <span className="absolute top-2 left-2 z-10 bg-orange-500/90 text-white text-xs font-black px-2 py-0.5 rounded-lg shadow-lg shadow-orange-900/40 border border-orange-400/40 backdrop-blur-xs">
                                                                        ×{count}
                                                                    </span>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <div className="relative">
                                                                <ShipCard ship={first.ship!} userShip={first} />
                                                                <div className="absolute bottom-2 right-2 text-[9px] text-slate-300 bg-slate-900/80 border border-slate-700 px-2 py-0.5 rounded-sm backdrop-blur-xs">
                                                                    <i className="fa-solid fa-user mr-1 text-slate-500"></i>{first.user?.name || 'Unknown'}
                                                                </div>
                                                            </div>
                                                        )}
                                                        {count > 1 && (
                                                            <div className="mt-2 bg-slate-900/60 border border-slate-800 rounded-lg p-2">
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <div className="flex items-center gap-1 min-w-0">
                                                                        {owners.slice(0, 5).map(u => (
                                                                            <img
                                                                                key={u.id}
                                                                                src={u.avatarUrl}
                                                                                alt={u.name}
                                                                                title={u.name}
                                                                                className="w-5 h-5 rounded-full border border-slate-700 shrink-0"
                                                                            />
                                                                        ))}
                                                                        {overflowCount > 0 && (
                                                                            <span className="text-[9px] font-mono text-slate-400 bg-slate-800 border border-slate-700 rounded-full w-5 h-5 flex items-center justify-center">+{overflowCount}</span>
                                                                        )}
                                                                        <span className="text-[10px] text-slate-400 ml-1 truncate">
                                                                            {owners.length} {owners.length === 1 ? 'owner' : 'owners'}
                                                                        </span>
                                                                    </div>
                                                                    <button
                                                                        onClick={() => toggleStack(stackKey)}
                                                                        className="text-[10px] font-bold uppercase tracking-widest text-orange-300 hover:text-orange-200 flex items-center gap-1 shrink-0"
                                                                    >
                                                                        {expanded ? 'Hide' : 'Details'}
                                                                        <i className={`fa-solid fa-chevron-${expanded ? 'up' : 'down'} text-[9px]`} />
                                                                    </button>
                                                                </div>
                                                                {expanded && (
                                                                    <ul className="mt-2 pt-2 border-t border-slate-800/80 space-y-1 max-h-60 overflow-y-auto">
                                                                        {instances.map(inst => (
                                                                            <li key={inst.id} className="flex items-center gap-2 text-[11px] text-slate-300">
                                                                                <img src={inst.user?.avatarUrl} alt="" className="w-4 h-4 rounded-full shrink-0" />
                                                                                <span className="truncate min-w-0 flex-1">
                                                                                    {inst.customName ? (
                                                                                        <>
                                                                                            <span className="text-white font-bold">{inst.customName}</span>
                                                                                            <span className="text-slate-500"> · {inst.user?.name || 'Unknown'}</span>
                                                                                        </>
                                                                                    ) : (
                                                                                        <span>{inst.user?.name || 'Unknown'}</span>
                                                                                    )}
                                                                                </span>
                                                                                <span className={`text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
                                                                                    inst.status === 'Active' ? 'text-green-400 bg-green-500/10 border-green-500/30' :
                                                                                    inst.status === 'Stored' ? 'text-slate-400 bg-slate-500/10 border-slate-500/30' :
                                                                                    inst.status === 'Damaged' ? 'text-red-400 bg-red-500/10 border-red-500/30' :
                                                                                    inst.status === 'Lent' ? 'text-amber-400 bg-amber-500/10 border-amber-500/30' :
                                                                                    'text-slate-500 bg-slate-700/50 border-slate-600'
                                                                                }`}>{inst.status}</span>
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            }
                            // Individual mode (legacy layout)
                            return (
                                <div key={groupName}>
                                    {groupName && <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 mt-4">{groupName} <span className="text-slate-600 font-mono">({ships.length})</span></h3>}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                        {ships.map(us => (
                                            <div key={us.id} className="relative">
                                                <ShipCard ship={us.ship!} userShip={us} />
                                                <div className="absolute bottom-2 right-2 text-[9px] text-slate-300 bg-slate-900/80 border border-slate-700 px-2 py-0.5 rounded-sm backdrop-blur-xs">
                                                    <i className="fa-solid fa-user mr-1 text-slate-500"></i>{us.user?.name || 'Unknown'}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                        {filteredFleet.length === 0 && (
                            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                                <EmptyState
                                    icon="fa-filter"
                                    accent="orange"
                                    heading="No ships match your filters"
                                    description={searchTerm ? 'Try a different search term or clear filters.' : 'Adjust manufacturer or size filters to see more.'}
                                    compact
                                />
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'organization' && (
                    <div className="flex-1 min-h-0 flex flex-col gap-3">
                        {/* Unassigned Ships drawer — only shown to fleet admins when
                            (a) there's at least one group to assign into, and
                            (b) at least one ship exists without an assignment. */}
                        {canManageFleet && fleetGroups.length > 0 && unassignedShips.length > 0 && (
                            <div className="shrink-0 rounded-xl border border-amber-500/30 bg-amber-500/5 backdrop-blur-md overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setUnassignedExpanded(v => !v)}
                                    className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-amber-500/10 transition-colors"
                                >
                                    <div className="flex items-center gap-2.5">
                                        <i className="fa-solid fa-triangle-exclamation text-amber-400 text-sm"></i>
                                        <span className="text-xs font-black uppercase tracking-widest text-amber-200">
                                            Unassigned Ships ({unassignedShips.length})
                                        </span>
                                        <span className="text-[11px] text-amber-300/70 hidden sm:inline">
                                            Not in any fleet group — assign or remove
                                        </span>
                                    </div>
                                    <i className={`fa-solid ${unassignedExpanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-amber-300/70 text-xs`}></i>
                                </button>
                                {unassignedExpanded && (
                                    <div className="border-t border-amber-500/20 p-3 max-h-56 overflow-y-auto">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                                            {unassignedShips.map(s => (
                                                <div key={s.id} className="flex items-center gap-2 p-2 bg-slate-900/60 border border-slate-700/50 rounded-lg hover:border-amber-500/30 transition-colors">
                                                    <img src={s.ship?.imageUrl || ''} alt={s.ship?.name || ''}
                                                        className="w-12 h-8 object-cover rounded-sm bg-slate-950 shrink-0"
                                                        onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-xs font-bold text-white truncate">{s.customName || s.ship?.name}</p>
                                                        <p className="text-[10px] text-slate-500 truncate">{s.user?.name || 'Unknown owner'}</p>
                                                    </div>
                                                    <select
                                                        defaultValue=""
                                                        disabled={isBusy}
                                                        onChange={(e) => {
                                                            const gid = parseInt(e.target.value, 10);
                                                            if (!Number.isFinite(gid)) return;
                                                            handleAssignShip(gid, s.id);
                                                            e.target.value = '';
                                                        }}
                                                        className="bg-slate-950/80 border border-slate-700 rounded-sm text-[10px] text-slate-300 px-1.5 py-1 max-w-[7.5rem] focus:border-amber-500/40 outline-hidden"
                                                        title="Assign to fleet group"
                                                    >
                                                        <option value="" disabled>Assign to…</option>
                                                        {fleetGroups.map(g => (
                                                            <option key={g.id} value={g.id}>{g.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {fleetGroups.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                                <EmptyState
                                    icon="fa-sitemap"
                                    accent="orange"
                                    heading="No fleet groups yet"
                                    description="Create a division or squadron to start organizing ships."
                                    action={canManageFleet ? (
                                        <button onClick={() => { setEditingGroup(null); setGroupForm({ name: '', type: FleetGroupType.Division, description: '', commanderId: '', parentId: '' }); setShowGroupModal(true); }}
                                            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-orange-600 hover:bg-orange-500 border border-orange-500/40 rounded-lg shadow-lg shadow-orange-900/30 transition">
                                            <i className="fa-solid fa-plus"></i>Create Group
                                        </button>
                                    ) : undefined}
                                />
                            </div>
                        ) : (
                            <FleetOrgChart
                                groups={fleetGroups}
                                allShips={userShips}
                                canManage={canManageFleet}
                                onEditGroup={(g) => { setEditingGroup(g); setGroupForm({ name: g.name, type: g.type, description: g.description || '', commanderId: g.commanderId?.toString() || '', parentId: g.parentId?.toString() || '' }); setShowGroupModal(true); }}
                                onDeleteGroup={handleDeleteGroup}
                                onAssignGroup={(g) => setAssigningGroup(g)}
                                onUnassignShip={handleUnassignShip}
                                onReorderGroups={handleReorderGroups}
                                onReparentGroup={handleReparentGroup}
                                onReorderGroupShips={handleReorderGroupShips}
                                onMoveShipToGroup={handleMoveShipToGroup}
                            />
                        )}
                    </div>
                )}
                </>}
                </div>
            </div>

            <ShipCatalogBrowser isOpen={showCatalog} onSelect={handleAddShips} onClose={() => setShowCatalog(false)} />

            <WindowFrame
                title="Edit Ship"
                subtitle="Hangar Management"
                icon="fa-solid fa-pen"
                color="orange"
                width="max-w-md"
                isOpen={!!editingShip}
                onClose={() => setEditingShip(null)}
            >
                <div className="p-5 space-y-4">
                    <div>
                        <label className={labelClass}>Custom Name</label>
                        <input type="text" value={editForm.customName} onChange={(e) => setEditForm(f => ({ ...f, customName: e.target.value }))}
                            placeholder={editingShip?.ship?.name} className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Loadout Notes</label>
                        <textarea value={editForm.loadoutNotes} onChange={(e) => setEditForm(f => ({ ...f, loadoutNotes: e.target.value }))}
                            className={`${inputClass} resize-none`} rows={3} />
                    </div>
                    <div>
                        <label className={labelClass}>Status</label>
                        <select value={editForm.status} onChange={(e) => setEditForm(f => ({ ...f, status: e.target.value as ShipStatus }))}
                            className={inputClass}>
                            {Object.values(ShipStatus).map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>
                </div>
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={() => setEditingShip(null)} disabled={isBusy}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={handleUpdateShip} disabled={isBusy}
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-orange-600 hover:bg-orange-500 border border-orange-500/40 rounded-lg shadow-lg shadow-orange-900/30 transition disabled:opacity-50">
                        {isBusy ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-check"></i> Save</>}
                    </button>
                </div>
            </WindowFrame>

            <WindowFrame
                title={editingGroup ? 'Edit Group' : 'Create Group'}
                subtitle="Fleet Organization"
                icon="fa-solid fa-sitemap"
                color="orange"
                width="max-w-md"
                isOpen={showGroupModal}
                onClose={() => { setShowGroupModal(false); setEditingGroup(null); }}
            >
                <div className="p-5 space-y-4">
                    <div>
                        <label className={labelClass}>Name</label>
                        <input type="text" value={groupForm.name} onChange={(e) => setGroupForm(f => ({ ...f, name: e.target.value }))}
                            className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Type</label>
                        {Object.values(FleetGroupType).includes(groupForm.type as FleetGroupType) ? (
                            <div className="flex gap-2">
                                <select value={groupForm.type} onChange={(e) => setGroupForm(f => ({ ...f, type: e.target.value === '__custom__' ? '' : e.target.value }))}
                                    className={`${inputClass} flex-1`}>
                                    {Object.values(FleetGroupType).filter(t => t !== FleetGroupType.Custom).map(t => <option key={t} value={t}>{t}</option>)}
                                    <option value="__custom__">Custom...</option>
                                </select>
                            </div>
                        ) : (
                            <div className="flex gap-2">
                                <input type="text" value={groupForm.type} onChange={(e) => setGroupForm(f => ({ ...f, type: e.target.value }))}
                                    placeholder="Enter custom type..."
                                    className={`${inputClass} flex-1`}
                                    autoFocus />
                                <button type="button" onClick={() => setGroupForm(f => ({ ...f, type: FleetGroupType.Division }))}
                                    className="px-3 py-2 text-slate-300 hover:text-orange-300 bg-slate-900/60 border border-slate-700 hover:border-orange-500/40 hover:bg-orange-500/10 rounded-lg text-xs transition-colors shrink-0"
                                    title="Back to presets">
                                    <i className="fa-solid fa-list"></i>
                                </button>
                            </div>
                        )}
                    </div>
                    <div>
                        <label className={labelClass}>Parent Group</label>
                        <select value={groupForm.parentId} onChange={(e) => setGroupForm(f => ({ ...f, parentId: e.target.value }))}
                            className={inputClass}>
                            <option value="">None (Top Level)</option>
                            {fleetGroups.filter(g => g.id !== editingGroup?.id).map(g => (
                                <option key={g.id} value={g.id}>{g.name} ({g.type})</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Commander</label>
                        <select value={groupForm.commanderId} onChange={(e) => setGroupForm(f => ({ ...f, commanderId: e.target.value }))}
                            className={inputClass}>
                            <option value="">None</option>
                            {allUsers.filter(u => u.role !== UserRole.Client).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Description</label>
                        <textarea value={groupForm.description} onChange={(e) => setGroupForm(f => ({ ...f, description: e.target.value }))}
                            className={`${inputClass} resize-none`} rows={2} />
                    </div>
                </div>
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={() => { setShowGroupModal(false); setEditingGroup(null); }} disabled={isBusy}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={handleSaveGroup} disabled={!groupForm.name || isBusy}
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-orange-600 hover:bg-orange-500 border border-orange-500/40 rounded-lg shadow-lg shadow-orange-900/30 transition disabled:opacity-50">
                        {isBusy ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-check"></i> Save</>}
                    </button>
                </div>
            </WindowFrame>

            {/* Assign Ship to Group Modal — owner-grouped + searchable. Prior version
                was a flat list of every org ship, which at 100-ship orgs was a mile long. */}
            <WindowFrame
                title="Assign Ships"
                subtitle={assigningGroup?.name || ''}
                icon="fa-solid fa-link"
                color="orange"
                width="max-w-lg"
                isOpen={!!assigningGroup}
                onClose={() => setAssigningGroup(null)}
            >
                {assigningGroup && (
                    <AssignShipsPicker
                        assigningGroup={assigningGroup}
                        userShips={userShips}
                        assignSearch={assignSearch}
                        setAssignSearch={setAssignSearch}
                        assignExpandedOwners={assignExpandedOwners}
                        setAssignExpandedOwners={setAssignExpandedOwners}
                        toggleAssignOwner={toggleAssignOwner}
                        onAssign={handleAssignShip}
                    />
                )}
            </WindowFrame>
        </div>
    );
};

export default FleetManagerView;
