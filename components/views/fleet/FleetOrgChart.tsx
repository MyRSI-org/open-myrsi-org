
import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { FleetGroup, UserShip } from '../../../types';
import { usePersistentState } from '../../../hooks/usePersistentState';

// localStorage key scoped by hostname so expansion state doesn't bleed between
// separate deployments opened in different tabs.
const expandedStorageKey = () => `fleet:expanded:${typeof window !== 'undefined' ? window.location.hostname : 'default'}`;
const setSerialize = (v: Set<number>) => JSON.stringify(Array.from(v));
const setDeserialize = (s: string): Set<number> => {
    const arr = JSON.parse(s);
    return new Set(Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []);
};

interface FleetOrgChartProps {
    groups: FleetGroup[];
    allShips: UserShip[];
    canManage: boolean;
    onEditGroup: (group: FleetGroup) => void;
    onDeleteGroup: (id: number) => void;
    onAssignGroup: (group: FleetGroup) => void;
    onUnassignShip: (groupId: number, shipId: number) => void;
    // Drag-and-drop hooks. Optional so the chart degrades gracefully if a parent
    // doesn't wire them up (drag is enabled only when canManage is also true).
    onReorderGroups?: (orderedIds: number[]) => void;
    onReparentGroup?: (groupId: number, newParentId: number | null, newSortOrder: number) => void;
    onReorderGroupShips?: (fleetGroupId: number, orderedAssignmentIds: number[]) => void;
    onMoveShipToGroup?: (userShipId: number, fromGroupId: number, toGroupId: number) => void;
}

type DragItem =
    | { kind: 'group'; id: number; parentId: number | null }
    | { kind: 'ship'; userShipId: number; assignmentId: number; fromGroupId: number };

type DropTarget =
    | { kind: 'group'; id: number; position: 'before' | 'inside' | 'after' }
    | { kind: 'ship'; id: number; groupId: number; position: 'before' | 'after' };

interface LayoutNode {
    type: 'group' | 'ship' | 'overflow';
    id: number;
    x: number;
    y: number;
    group?: FleetGroup;
    ship?: UserShip;
    parentGroupId?: number;
    overflowCount?: number;
}

interface Edge {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    type: 'group-group' | 'group-ship';
}

const NODE_W = 280;
const NODE_H = 100;
const SHIP_W = 220;
const SHIP_H = 56;
const H_GAP = 40;
const V_GAP = 80;
const SHIP_V_GAP = 20;
const SHIP_H_GAP = 12;
// Ships stack into a wrapped grid under their parent group: 4 columns, 3 visible
// rows (12 ships) before an overflow "+N more" pill replaces the 12th cell.
// Clicking the pill toggles that group into expanded mode where every ship
// renders in the same 4-wide grid (more rows). This bounds subtree width so a
// group with 50 ships no longer blows the chart out to 11,000+ px.
const SHIPS_PER_ROW = 4;
const MAX_VISIBLE_ROWS = 3;
const COLLAPSED_VISIBLE = SHIPS_PER_ROW * MAX_VISIBLE_ROWS; // 12

const typeIcons: Record<string, string> = {
    Division: 'fa-solid fa-shield-halved',
    Squadron: 'fa-solid fa-jet-fighter',
    Wing: 'fa-solid fa-feather',
    Taskforce: 'fa-solid fa-crosshairs',
    Custom: 'fa-solid fa-folder',
};

const typeColors: Record<string, string> = {
    Division: 'text-purple-300 bg-purple-500/10 border-purple-500/30',
    Squadron: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
    Wing: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
    Taskforce: 'text-red-300 bg-red-500/10 border-red-500/30',
    Custom: 'text-slate-300 bg-slate-500/10 border-slate-500/30',
};

const typeIconColor: Record<string, string> = {
    Division: 'text-purple-300',
    Squadron: 'text-sky-300',
    Wing: 'text-amber-300',
    Taskforce: 'text-red-300',
    Custom: 'text-slate-300',
};

// How many ship cells a group should render and how that maps onto the wrapped
// grid. When overflowed and not expanded, the 12th cell becomes a `+N more`
// pill (`overflowCount` is set), and the visible count stops at 12.
function shipGridShape(shipCount: number, expanded: boolean) {
    if (shipCount === 0) return { visibleCount: 0, cols: 0, rows: 0, overflow: 0 };
    const overflowed = !expanded && shipCount > COLLAPSED_VISIBLE;
    const visibleCount = overflowed ? COLLAPSED_VISIBLE : shipCount;
    const cols = Math.min(SHIPS_PER_ROW, visibleCount);
    const rows = Math.ceil(visibleCount / SHIPS_PER_ROW);
    const overflow = overflowed ? shipCount - COLLAPSED_VISIBLE + 1 : 0; // +1 because cell 12 IS the pill
    return { visibleCount, cols, rows, overflow };
}

function shipsBlockWidth(cols: number) {
    return cols > 0 ? cols * (SHIP_W + SHIP_H_GAP) - SHIP_H_GAP : 0;
}

function shipsBlockHeight(rows: number) {
    return rows > 0 ? rows * (SHIP_H + SHIP_V_GAP) - SHIP_V_GAP : 0;
}

function computeLayout(groups: FleetGroup[], expandedGroupIds: Set<number>): { nodes: LayoutNode[]; edges: Edge[] } {
    const nodes: LayoutNode[] = [];
    const edges: Edge[] = [];
    const rootGroups = groups.filter(g => !g.parentId);

    function getSubtreeWidth(group: FleetGroup): number {
        const children = groups.filter(g => g.parentId === group.id);
        const shipCount = group.assignedShips?.length || 0;
        const { cols } = shipGridShape(shipCount, expandedGroupIds.has(group.id));
        const shipsW = shipsBlockWidth(cols);

        if (children.length === 0) {
            return Math.max(NODE_W, shipsW);
        }
        const childrenWidth = children.reduce((sum, c) => sum + getSubtreeWidth(c) + H_GAP, 0) - H_GAP;
        return Math.max(NODE_W, shipsW, childrenWidth);
    }

    function positionGroup(group: FleetGroup, x: number, y: number) {
        const subtreeW = getSubtreeWidth(group);
        const nodeX = x + (subtreeW - NODE_W) / 2;
        nodes.push({ type: 'group', id: group.id, x: nodeX, y, group });

        // Wrapped ship grid below the group node.
        const ships = group.assignedShips || [];
        const expanded = expandedGroupIds.has(group.id);
        const { visibleCount, cols, rows, overflow } = shipGridShape(ships.length, expanded);
        const blockW = shipsBlockWidth(cols);
        const blockStartX = nodeX + (NODE_W - blockW) / 2;
        const blockStartY = y + NODE_H + SHIP_V_GAP;

        for (let i = 0; i < visibleCount; i++) {
            const col = i % SHIPS_PER_ROW;
            const row = Math.floor(i / SHIPS_PER_ROW);
            const sx = blockStartX + col * (SHIP_W + SHIP_H_GAP);
            const sy = blockStartY + row * (SHIP_H + SHIP_V_GAP);

            const isOverflowSlot = overflow > 0 && i === visibleCount - 1;
            if (isOverflowSlot) {
                nodes.push({
                    type: 'overflow',
                    id: group.id, // overflow nodes key off their parent group
                    x: sx, y: sy,
                    parentGroupId: group.id,
                    overflowCount: overflow,
                });
            } else {
                const ship = ships[i];
                nodes.push({ type: 'ship', id: ship.id, x: sx, y: sy, ship, parentGroupId: group.id });
            }
            // Edges fan from the group's bottom-center to each visible cell's top-center.
            edges.push({
                x1: nodeX + NODE_W / 2,
                y1: y + NODE_H,
                x2: sx + SHIP_W / 2,
                y2: sy,
                type: 'group-ship',
            });
        }

        // Children sit below the ship grid (or directly below the node if no ships).
        const children = groups.filter(g => g.parentId === group.id);
        if (children.length > 0) {
            const shipsH = rows > 0 ? shipsBlockHeight(rows) + SHIP_V_GAP : 0;
            const childY = y + NODE_H + shipsH + V_GAP;
            let childX = x;
            children.forEach(child => {
                const childW = getSubtreeWidth(child);
                positionGroup(child, childX, childY);
                edges.push({
                    x1: nodeX + NODE_W / 2,
                    y1: y + NODE_H,
                    x2: childX + (childW - NODE_W) / 2 + NODE_W / 2,
                    y2: childY,
                    type: 'group-group',
                });
                childX += childW + H_GAP;
            });
        }
    }

    let offsetX = 0;
    rootGroups.forEach(root => {
        positionGroup(root, offsetX, 0);
        offsetX += getSubtreeWidth(root) + H_GAP * 2;
    });

    return { nodes, edges };
}

// Ship-count badge on a group node: a plain count when within the visible
// budget, or a toggle button when the group's ship grid overflows. Hoisted to
// module scope (was an in-JSX IIFE the React Compiler can't optimize).
const ShipCountBadge: React.FC<{
    group: FleetGroup;
    isExpanded: boolean;
    onToggle: (groupId: number) => void;
}> = ({ group, isExpanded, onToggle }) => {
    const shipCount = group.assignedShips?.length || 0;
    if (shipCount === 0) return null;
    const isOverflowed = shipCount > COLLAPSED_VISIBLE;
    if (!isOverflowed) {
        return <span><i className="fa-solid fa-rocket mr-1 text-slate-600"></i>{shipCount}</span>;
    }
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onToggle(group.id); }}
            className="inline-flex items-center gap-1 text-orange-300/80 hover:text-orange-200 transition-colors"
            title={isExpanded ? 'Collapse ship list' : 'Expand all ships'}
        >
            <i className="fa-solid fa-rocket text-slate-600"></i>
            <span>{shipCount}</span>
            <i className={`fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-[8px]`}></i>
        </button>
    );
};

const FleetOrgChart: React.FC<FleetOrgChartProps> = ({
    groups, allShips, canManage, onEditGroup, onDeleteGroup, onAssignGroup, onUnassignShip,
    onReorderGroups, onReparentGroup, onReorderGroupShips, onMoveShipToGroup,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);
    const [zoom, setZoom] = useState(1.0);
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

    // Per-group expansion of the wrapped ship grid, persisted to localStorage so
    // the admin doesn't have to re-expand their working set after every reload.
    const [expandedGroupIds, setExpandedGroupIds] = usePersistentState<Set<number>>(
        expandedStorageKey(),
        new Set<number>(),
        { serialize: setSerialize, deserialize: setDeserialize },
    );
    const toggleExpanded = useCallback((groupId: number) => {
        setExpandedGroupIds(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
            return next;
        });
    }, [setExpandedGroupIds]);

    // ── Drag-and-drop state ──
    const [drag, setDrag] = useState<DragItem | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    const dndEnabled = canManage && !!(onReorderGroups || onReparentGroup || onReorderGroupShips || onMoveShipToGroup);

    const clearDnd = useCallback(() => {
        setDrag(null);
        setDropTarget(null);
    }, []);

    // Compute siblings ordered by sortOrder for a given parent. Used to derive
    // new ordered id lists on drop without a server round-trip.
    const siblingsOf = useCallback((parentId: number | null): FleetGroup[] => {
        return groups
            .filter(g => (g.parentId ?? null) === parentId)
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }, [groups]);

    // Insert `dragId` at the right index in the target sibling list relative
    // to `targetId` (before/after). Returns the full ordered id list.
    const computeReorderedSiblings = useCallback((siblings: FleetGroup[], dragId: number, targetId: number, position: 'before' | 'after'): number[] => {
        const without = siblings.filter(g => g.id !== dragId);
        const idx = without.findIndex(g => g.id === targetId);
        if (idx < 0) return siblings.map(g => g.id);
        const insertAt = position === 'before' ? idx : idx + 1;
        const result = without.slice();
        result.splice(insertAt, 0, { id: dragId } as FleetGroup);
        return result.map(g => g.id);
    }, []);

    const handleDrop = useCallback((target: DropTarget) => {
        if (!drag) return;

        // GROUP → GROUP
        if (drag.kind === 'group' && target.kind === 'group') {
            if (drag.id === target.id) return;
            const targetGroup = groups.find(g => g.id === target.id);
            if (!targetGroup) return;

            if (target.position === 'inside') {
                // Reparent dragged group under target as the last child.
                const targetChildren = siblingsOf(target.id);
                const newSortOrder = (targetChildren.length + 1) * 10;
                onReparentGroup?.(drag.id, target.id, newSortOrder);
                return;
            }

            const targetParentId = targetGroup.parentId ?? null;
            const dragParentId = drag.parentId;

            if (targetParentId === dragParentId) {
                // Same-parent reorder.
                const sibs = siblingsOf(dragParentId);
                const orderedIds = computeReorderedSiblings(sibs, drag.id, target.id, target.position);
                onReorderGroups?.(orderedIds);
            } else {
                // Cross-parent: reparent first (place at end with a sentinel),
                // then reorder the new parent's siblings to put the drag at
                // the correct slot. Two RPCs; fine for an infrequent action.
                const sibs = siblingsOf(targetParentId);
                const orderedIds = computeReorderedSiblings(sibs, drag.id, target.id, target.position);
                const newIdx = orderedIds.indexOf(drag.id);
                onReparentGroup?.(drag.id, targetParentId, (newIdx + 1) * 10);
                if (onReorderGroups) {
                    // Defer slightly so the reparent commits before reorder
                    // (reorder filters by .eq('id', ...) only, so it works
                    // either way, but the broadcast ordering is cleaner).
                    setTimeout(() => onReorderGroups(orderedIds), 0);
                }
            }
            return;
        }

        // SHIP → SHIP
        if (drag.kind === 'ship' && target.kind === 'ship') {
            const targetGroup = groups.find(g => g.id === target.groupId);
            if (!targetGroup) return;

            if (drag.fromGroupId === target.groupId) {
                // In-group reorder.
                const ships = (targetGroup.assignedShips || []).slice();
                const without = ships.filter(s => s.assignmentId !== drag.assignmentId);
                const tgtIdx = without.findIndex(s => s.id === target.id);
                if (tgtIdx < 0) return;
                const insertAt = target.position === 'before' ? tgtIdx : tgtIdx + 1;
                without.splice(insertAt, 0, { assignmentId: drag.assignmentId } as UserShip);
                const orderedAssignmentIds = without
                    .map(s => s.assignmentId)
                    .filter((id): id is number => typeof id === 'number');
                onReorderGroupShips?.(target.groupId, orderedAssignmentIds);
            } else {
                // Cross-group ship-on-ship: simplify to "append to target group".
                // Inserting at a precise position requires three RPCs; v1 keeps
                // the moved ship at the end and lets the user tidy with a
                // follow-up drag if they care.
                onMoveShipToGroup?.(drag.userShipId, drag.fromGroupId, target.groupId);
            }
            return;
        }

        // SHIP → GROUP body (append).
        if (drag.kind === 'ship' && target.kind === 'group' && target.position === 'inside') {
            if (drag.fromGroupId === target.id) return;
            onMoveShipToGroup?.(drag.userShipId, drag.fromGroupId, target.id);
        }
    }, [drag, groups, siblingsOf, computeReorderedSiblings, onReorderGroups, onReparentGroup, onReorderGroupShips, onMoveShipToGroup]);

    const { nodes, edges } = useMemo(() => computeLayout(groups, expandedGroupIds), [groups, expandedGroupIds]);

    // Compute bounding box for fit-to-view
    const bbox = useMemo(() => {
        if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            const w = n.type === 'group' ? NODE_W : SHIP_W;
            const h = n.type === 'group' ? NODE_H : SHIP_H; // overflow pills share ship dimensions
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + w);
            maxY = Math.max(maxY, n.y + h);
        }
        return { minX, minY, maxX, maxY };
    }, [nodes]);

    const fitToView = useCallback(() => {
        if (!containerRef.current || nodes.length === 0) return;
        const rect = containerRef.current.getBoundingClientRect();
        const contentW = bbox.maxX - bbox.minX + 80;
        const contentH = bbox.maxY - bbox.minY + 80;
        const scaleX = rect.width / contentW;
        const scaleY = rect.height / contentH;
        const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.3), 2.0);
        const newPanX = (rect.width - contentW * newZoom) / 2 - bbox.minX * newZoom;
        const newPanY = (rect.height - contentH * newZoom) / 2 - bbox.minY * newZoom + 20;
        setZoom(newZoom);
        setPanX(newPanX);
        setPanY(newPanY);
    }, [bbox, nodes.length]);

    // Auto-fit on mount and when groups change
    useEffect(() => {
        const timer = setTimeout(fitToView, 50);
        return () => clearTimeout(timer);
    }, [fitToView]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
    }, [panX, panY]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDragging || !dragStartRef.current) return;
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        setPanX(dragStartRef.current.panX + dx);
        setPanY(dragStartRef.current.panY + dy);
    }, [isDragging]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
        dragStartRef.current = null;
    }, []);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.min(Math.max(zoom * delta, 0.3), 2.0);
        const scale = newZoom / zoom;
        setPanX(mouseX - scale * (mouseX - panX));
        setPanY(mouseY - scale * (mouseY - panY));
        setZoom(newZoom);
    }, [zoom, panX, panY]);

    // ── DnD event helpers ──
    // Group nodes use 3-zone detection (before/inside/after). Ship nodes use
    // 2-zone (before/after). Group `inside` is also the drop target when a ship
    // is being dragged onto a group's body.
    const handleGroupDragOver = useCallback((e: React.DragEvent, groupId: number) => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const h = rect.height;
        let position: 'before' | 'inside' | 'after';
        if (drag.kind === 'ship') {
            // Ships only ever go "inside" a group when targeting a group body.
            position = 'inside';
        } else if (y < h * 0.25) {
            position = 'before';
        } else if (y > h * 0.75) {
            position = 'after';
        } else {
            position = 'inside';
        }
        setDropTarget({ kind: 'group', id: groupId, position });
    }, [drag]);

    const handleShipDragOver = useCallback((e: React.DragEvent, shipId: number, groupId: number) => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const h = rect.height;
        const position: 'before' | 'after' = y < h / 2 ? 'before' : 'after';
        setDropTarget({ kind: 'ship', id: shipId, groupId, position });
    }, [drag]);

    const handleNodeDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (drag && dropTarget) handleDrop(dropTarget);
        clearDnd();
    }, [drag, dropTarget, handleDrop, clearDnd]);

    return (
        <div className="relative rounded-xl border border-slate-700/50 bg-slate-900/40 backdrop-blur-md overflow-hidden flex-1 min-h-[400px]">
            <div
                ref={containerRef}
                className={`w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
            >
                <div style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transformOrigin: '0 0', position: 'relative' }}>
                    <svg
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: bbox.maxX + 200,
                            height: bbox.maxY + 200,
                            pointerEvents: 'none',
                            overflow: 'visible',
                        }}
                    >
                        {edges.map((edge) => {
                            const offset = Math.abs(edge.y2 - edge.y1) * 0.5;
                            return (
                                <path
                                    key={`${edge.type}:${edge.x1},${edge.y1}-${edge.x2},${edge.y2}`}
                                    d={`M ${edge.x1},${edge.y1} C ${edge.x1},${edge.y1 + offset} ${edge.x2},${edge.y2 - offset} ${edge.x2},${edge.y2}`}
                                    fill="none"
                                    stroke={edge.type === 'group-group' ? 'rgb(249,115,22)' : 'rgb(100,116,139)'}
                                    strokeOpacity={edge.type === 'group-group' ? 0.35 : 0.25}
                                    strokeWidth={edge.type === 'group-group' ? 2 : 1.5}
                                    strokeDasharray={edge.type === 'group-ship' ? '4 4' : undefined}
                                />
                            );
                        })}
                    </svg>

                    {nodes.filter(n => n.type === 'group').map(n => {
                        const isDropTarget = dropTarget?.kind === 'group' && dropTarget.id === n.id;
                        const insideHighlight = isDropTarget && dropTarget.position === 'inside';
                        const beforeHighlight = isDropTarget && dropTarget.position === 'before';
                        const afterHighlight = isDropTarget && dropTarget.position === 'after';
                        const isBeingDragged = drag?.kind === 'group' && drag.id === n.id;
                        return (
                        <div
                            key={`g-${n.id}`}
                            className={`absolute bg-slate-900/80 border rounded-xl p-4 shadow-lg backdrop-blur-md group/node transition-all ${
                                insideHighlight
                                    ? 'border-orange-400 shadow-orange-500/40 ring-2 ring-orange-400/50'
                                    : 'border-slate-700/50 hover:border-orange-500/40 hover:shadow-orange-900/20'
                            } ${isBeingDragged ? 'opacity-40' : ''}`}
                            style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                            draggable={dndEnabled}
                            onMouseDown={dndEnabled ? (e) => e.stopPropagation() : undefined}
                            onDragStart={dndEnabled ? (e) => {
                                e.stopPropagation();
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('application/x-fleet', JSON.stringify({ kind: 'group', id: n.group!.id }));
                                setDrag({ kind: 'group', id: n.group!.id, parentId: n.group!.parentId ?? null });
                            } : undefined}
                            onDragOver={dndEnabled ? (e) => handleGroupDragOver(e, n.id) : undefined}
                            onDrop={dndEnabled ? handleNodeDrop : undefined}
                            onDragEnd={dndEnabled ? clearDnd : undefined}
                        >
                            {beforeHighlight && <div className="absolute -top-1 left-0 right-0 h-1 bg-orange-400 rounded-full shadow-[0_0_8px_rgba(249,115,22,0.6)] pointer-events-none" />}
                            {afterHighlight && <div className="absolute -bottom-1 left-0 right-0 h-1 bg-orange-400 rounded-full shadow-[0_0_8px_rgba(249,115,22,0.6)] pointer-events-none" />}
                            <div className="flex items-start justify-between h-full">
                                <div className="flex items-start gap-3 min-w-0 flex-1">
                                    <i className={`${typeIcons[n.group!.type] || 'fa-solid fa-folder'} ${typeIconColor[n.group!.type] || typeIconColor.Custom} text-lg mt-0.5 shrink-0`}></i>
                                    <div className="min-w-0 flex-1">
                                        <h4 className="text-xs font-black text-white uppercase tracking-wider truncate">{n.group!.name}</h4>
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${typeColors[n.group!.type] || typeColors.Custom}`}>
                                                {n.group!.type}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-slate-500">
                                            {n.group!.commander && (
                                                <span className="truncate"><i className="fa-solid fa-user-shield mr-1 text-amber-400"></i>{n.group!.commander.name}</span>
                                            )}
                                            <ShipCountBadge
                                                group={n.group!}
                                                isExpanded={expandedGroupIds.has(n.group!.id)}
                                                onToggle={toggleExpanded}
                                            />
                                        </div>
                                    </div>
                                </div>
                                {canManage && (
                                    <div className="flex gap-1 opacity-0 group-hover/node:opacity-100 transition-opacity shrink-0">
                                        <button onClick={(e) => { e.stopPropagation(); onAssignGroup(n.group!); }}
                                            className="w-6 h-6 flex items-center justify-center text-orange-300 hover:text-orange-200 hover:bg-orange-500/10 rounded-sm transition-colors text-[10px]" title="Assign Ships">
                                            <i className="fa-solid fa-plus"></i>
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); onEditGroup(n.group!); }}
                                            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 rounded-sm transition-colors text-[10px]" title="Edit">
                                            <i className="fa-solid fa-pen"></i>
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); onDeleteGroup(n.group!.id); }}
                                            className="w-6 h-6 flex items-center justify-center text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-sm transition-colors text-[10px]" title="Delete">
                                            <i className="fa-solid fa-trash"></i>
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                        );
                    })}

                    {nodes.filter(n => n.type === 'ship').map(n => {
                        const isDropTarget = dropTarget?.kind === 'ship' && dropTarget.id === n.id;
                        const beforeHighlight = isDropTarget && dropTarget.position === 'before';
                        const afterHighlight = isDropTarget && dropTarget.position === 'after';
                        const isBeingDragged = drag?.kind === 'ship' && drag.userShipId === n.ship!.id;
                        return (
                        <div
                            key={`s-${n.id}`}
                            className={`absolute bg-slate-900/60 backdrop-blur-xs border rounded-lg flex items-center gap-2.5 px-3 group/ship transition-colors ${
                                isDropTarget ? 'border-orange-400' : 'border-slate-700/50 hover:border-orange-500/30'
                            } ${isBeingDragged ? 'opacity-40' : ''}`}
                            style={{ left: n.x, top: n.y, width: SHIP_W, height: SHIP_H }}
                            draggable={dndEnabled}
                            onMouseDown={dndEnabled ? (e) => e.stopPropagation() : undefined}
                            onDragStart={dndEnabled && n.ship!.assignmentId !== undefined ? (e) => {
                                e.stopPropagation();
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('application/x-fleet', JSON.stringify({ kind: 'ship', id: n.ship!.id }));
                                setDrag({ kind: 'ship', userShipId: n.ship!.id, assignmentId: n.ship!.assignmentId!, fromGroupId: n.parentGroupId! });
                            } : undefined}
                            onDragOver={dndEnabled ? (e) => handleShipDragOver(e, n.id, n.parentGroupId!) : undefined}
                            onDrop={dndEnabled ? handleNodeDrop : undefined}
                            onDragEnd={dndEnabled ? clearDnd : undefined}
                        >
                            {beforeHighlight && <div className="absolute -top-1 left-0 right-0 h-0.5 bg-orange-400 rounded-full shadow-[0_0_8px_rgba(249,115,22,0.6)] pointer-events-none" />}
                            {afterHighlight && <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-orange-400 rounded-full shadow-[0_0_8px_rgba(249,115,22,0.6)] pointer-events-none" />}
                            {n.ship!.ship?.imageUrl && (
                                <img src={n.ship!.ship.imageUrl} alt="" className="w-8 h-6 object-cover rounded-sm shrink-0 opacity-70" />
                            )}
                            <div className="min-w-0 flex-1">
                                {/* Custom-named ships get a two-line display: callsign on top, platform
                                    type underneath. Without the type line a "Pillar of Autumn" is
                                    impossible to identify as an Idris-P on the node graph. */}
                                {n.ship!.customName ? (
                                    <>
                                        <p className="text-[10px] font-bold text-white truncate">{n.ship!.customName}</p>
                                        <p className="text-[9px] text-orange-300/80 truncate font-mono">{n.ship!.ship?.name || 'Unknown'}</p>
                                    </>
                                ) : (
                                    <>
                                        <p className="text-[10px] font-bold text-white truncate">{n.ship!.ship?.name || 'Unknown'}</p>
                                        <p className="text-[9px] text-slate-500 truncate uppercase tracking-widest">{n.ship!.user?.name || 'Unknown'}</p>
                                    </>
                                )}
                            </div>
                            <span className={`text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
                                n.ship!.status === 'Active' ? 'text-green-400 bg-green-500/10 border-green-500/30' :
                                n.ship!.status === 'Stored' ? 'text-slate-400 bg-slate-500/10 border-slate-500/30' :
                                n.ship!.status === 'Damaged' ? 'text-red-400 bg-red-500/10 border-red-500/30' :
                                n.ship!.status === 'Lent' ? 'text-amber-400 bg-amber-500/10 border-amber-500/30' :
                                'text-slate-500 bg-slate-700/50 border-slate-600'
                            }`}>{n.ship!.status}</span>
                            {canManage && n.parentGroupId && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onUnassignShip(n.parentGroupId!, n.ship!.id); }}
                                    className="absolute -top-1.5 -right-1.5 opacity-0 group-hover/ship:opacity-100 bg-red-600/80 hover:bg-red-500 text-white w-4 h-4 rounded-full text-[7px] transition-all flex items-center justify-center border border-red-500/60"
                                >
                                    <i className="fa-solid fa-xmark"></i>
                                </button>
                            )}
                        </div>
                        );
                    })}

                    {/* Overflow pills — replace the 12th ship cell when a group has > 12 assigned ships. */}
                    {nodes.filter(n => n.type === 'overflow').map(n => (
                        <button
                            key={`o-${n.parentGroupId}`}
                            onClick={(e) => { e.stopPropagation(); toggleExpanded(n.parentGroupId!); }}
                            className="absolute bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 hover:border-orange-500/50 rounded-lg flex items-center justify-center gap-2 px-3 transition-colors text-orange-300 hover:text-orange-200"
                            style={{ left: n.x, top: n.y, width: SHIP_W, height: SHIP_H }}
                            title="Show all ships in this group"
                        >
                            <i className="fa-solid fa-plus text-xs"></i>
                            <span className="text-xs font-black uppercase tracking-wider">{n.overflowCount} more</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="absolute bottom-3 right-3 bg-slate-900/90 border border-slate-700/50 rounded-xl backdrop-blur-md p-1 flex flex-col gap-1 z-10 shadow-lg">
                <button
                    onClick={() => setZoom(z => Math.min(z * 1.2, 2.0))}
                    className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-orange-300 hover:bg-orange-500/10 rounded-lg transition-colors text-sm"
                    title="Zoom In"
                >
                    <i className="fa-solid fa-plus"></i>
                </button>
                <button
                    onClick={() => setZoom(z => Math.max(z * 0.8, 0.3))}
                    className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-orange-300 hover:bg-orange-500/10 rounded-lg transition-colors text-sm"
                    title="Zoom Out"
                >
                    <i className="fa-solid fa-minus"></i>
                </button>
                <div className="border-t border-white/5 my-0.5"></div>
                <button
                    onClick={fitToView}
                    className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-orange-300 hover:bg-orange-500/10 rounded-lg transition-colors text-sm"
                    title="Fit to View"
                >
                    <i className="fa-solid fa-expand"></i>
                </button>
            </div>

            <div className="absolute bottom-3 left-3 text-[10px] text-slate-500 font-mono z-10 uppercase tracking-widest bg-slate-900/90 border border-slate-700/50 rounded-sm px-2 py-1 backdrop-blur-md">
                {Math.round(zoom * 100)}%
            </div>
        </div>
    );
};

export default FleetOrgChart;
