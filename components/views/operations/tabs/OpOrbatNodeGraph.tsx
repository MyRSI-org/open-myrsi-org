import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { HydratedOperation, OperationCommandNode } from '../../../../types';

interface OpOrbatNodeGraphProps {
    operation: HydratedOperation;
    canManage: boolean;
    onAddNode: (parentId?: number) => void;
    onEditNode: (node: OperationCommandNode) => void;
    onDeleteNode: (nodeId: number) => void;
    fillParent?: boolean; // If true, fills parent height instead of using calc
}

const CMD_W = 300;
const CMD_H = 110;
const POS_W = 240;
const POS_H = 80;
const H_GAP = 40;
const V_GAP = 80;

const nodeTypeConfig: Record<string, { icon: string; color: string; label: string }> = {
    command: { icon: 'fa-solid fa-star', color: '#f59e0b', label: 'Command' },
    unit: { icon: 'fa-solid fa-people-group', color: '#3b82f6', label: 'Unit' },
    position: { icon: 'fa-solid fa-user', color: '#6b7280', label: 'Position' },
};

interface LayoutNode {
    id: number;
    x: number;
    y: number;
    node: OperationCommandNode;
    isPosition: boolean;
}

interface Edge {
    /** Stable identity for React keys: parent -> child node ids. */
    parentId: number;
    childId: number;
    x1: number; y1: number;
    x2: number; y2: number;
}

interface EnrichedNode extends Omit<OperationCommandNode, 'children'> { children: EnrichedNode[] }

function buildTree(nodes: OperationCommandNode[]): EnrichedNode[] {
    const nodeMap = new Map<number, EnrichedNode>();
    const roots: EnrichedNode[] = [];
    nodes.forEach(n => nodeMap.set(n.id, { ...n, children: [] } as EnrichedNode));
    nodes.forEach(n => {
        const enriched = nodeMap.get(n.id)!;
        if (n.parentId && nodeMap.has(n.parentId)) {
            nodeMap.get(n.parentId)!.children.push(enriched);
        } else {
            roots.push(enriched);
        }
    });
    nodeMap.forEach(n => n.children.sort((a, b) => a.sortOrder - b.sortOrder));
    return roots.sort((a, b) => a.sortOrder - b.sortOrder);
}

function computeLayout(roots: EnrichedNode[]): { layoutNodes: LayoutNode[]; edges: Edge[] } {
    const layoutNodes: LayoutNode[] = [];
    const edges: Edge[] = [];

    function getNodeDims(node: EnrichedNode) {
        const isPos = node.nodeType === 'position';
        return { w: isPos ? POS_W : CMD_W, h: isPos ? POS_H : CMD_H };
    }

    function getSubtreeWidth(node: EnrichedNode): number {
        const { w } = getNodeDims(node);
        if (node.children.length === 0) return w;
        const childrenWidth = node.children.reduce((sum, c) => sum + getSubtreeWidth(c) + H_GAP, 0) - H_GAP;
        return Math.max(w, childrenWidth);
    }

    function positionNode(node: EnrichedNode, x: number, y: number) {
        const { w, h } = getNodeDims(node);
        const subtreeW = getSubtreeWidth(node);
        const nodeX = x + (subtreeW - w) / 2;
        const isPos = node.nodeType === 'position';
        layoutNodes.push({ id: node.id, x: nodeX, y, node, isPosition: isPos });

        if (node.children.length > 0) {
            const childY = y + h + V_GAP;
            let childX = x;
            node.children.forEach(child => {
                const childW = getSubtreeWidth(child);
                const { w: cw } = getNodeDims(child);
                positionNode(child, childX, childY);
                edges.push({
                    parentId: node.id,
                    childId: child.id,
                    x1: nodeX + w / 2,
                    y1: y + h,
                    x2: childX + (childW - cw) / 2 + cw / 2,
                    y2: childY,
                });
                childX += childW + H_GAP;
            });
        }
    }

    let offsetX = 0;
    roots.forEach(root => {
        positionNode(root, offsetX, 0);
        offsetX += getSubtreeWidth(root) + H_GAP * 2;
    });

    return { layoutNodes, edges };
}

const OpOrbatNodeGraph: React.FC<OpOrbatNodeGraphProps> = ({ operation, canManage, onAddNode, onEditNode, onDeleteNode, fillParent }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);
    const [zoom, setZoom] = useState(1.0);
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

    const nodes = useMemo(() => operation.commandNodes || [], [operation.commandNodes]);
    const roots = useMemo(() => buildTree(nodes), [nodes]);
    const { layoutNodes, edges } = useMemo(() => computeLayout(roots), [roots]);

    // Bounding box for fit-to-view
    const bbox = useMemo(() => {
        if (layoutNodes.length === 0) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of layoutNodes) {
            const w = n.isPosition ? POS_W : CMD_W;
            const h = n.isPosition ? POS_H : CMD_H;
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + w);
            maxY = Math.max(maxY, n.y + h);
        }
        return { minX, minY, maxX, maxY };
    }, [layoutNodes]);

    const fitToView = useCallback(() => {
        if (!containerRef.current || layoutNodes.length === 0) return;
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
    }, [bbox, layoutNodes.length]);

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

    const zoomRef = useRef({ zoom, panX, panY });
    // Mirror the latest transform into a ref so the once-registered wheel handler
    // can read current values without re-subscribing. Written in an effect (post-commit)
    // rather than during render; the handler only reads it at event time, so timing is identical.
    useEffect(() => {
        zoomRef.current = { zoom, panX, panY };
    }, [zoom, panX, panY]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const { zoom: z, panX: px, panY: py } = zoomRef.current;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.min(Math.max(z * delta, 0.3), 2.0);
            const scale = newZoom / z;
            setPanX(mouseX - scale * (mouseX - px));
            setPanY(mouseY - scale * (mouseY - py));
            setZoom(newZoom);
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
    }, []);

    // Reserve pool: participants not assigned to any command node
    const assignedUserIds = useMemo(() => {
        const set = new Set<number>();
        nodes.forEach(n => { if (n.assignedUserId) set.add(n.assignedUserId); });
        return set;
    }, [nodes]);

    const reservePool = useMemo(() =>
        (operation.participants || []).filter(p => p.timeLeft === null && !assignedUserIds.has(p.userId)),
    [operation.participants, assignedUserIds]);

    return (
        <div className={fillParent ? "flex flex-col h-full" : "flex flex-col"} style={fillParent ? { minHeight: '300px' } : { height: 'calc(100vh - 300px)', minHeight: '350px' }}>
            {/* Graph Area */}
            <div className="relative flex-1 rounded-xl border border-slate-700/50 bg-slate-950/30 overflow-hidden">
                <div
                    ref={containerRef}
                    className={`w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <div style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transformOrigin: '0 0', position: 'relative' }}>
                        {/* SVG Connection Lines */}
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
                                        key={`e-${edge.parentId}-${edge.childId}`}
                                        d={`M ${edge.x1},${edge.y1} C ${edge.x1},${edge.y1 + offset} ${edge.x2},${edge.y2 - offset} ${edge.x2},${edge.y2}`}
                                        fill="none"
                                        stroke="rgb(56,189,248)"
                                        strokeOpacity={0.25}
                                        strokeWidth={2}
                                    />
                                );
                            })}
                        </svg>

                        {/* Command/Unit Nodes */}
                        {layoutNodes.filter(n => !n.isPosition).map(n => {
                            const cfg = nodeTypeConfig[n.node.nodeType] || nodeTypeConfig.command;
                            const participant = n.node.assignedUserId
                                ? (operation.participants || []).find(p => p.userId === n.node.assignedUserId && p.timeLeft === null)
                                : null;
                            return (
                                <div
                                    key={`n-${n.id}`}
                                    className="absolute bg-slate-900/80 border border-purple-500/30 rounded-xl p-4 shadow-lg backdrop-blur-xs group/node hover:border-purple-500/60 transition-colors"
                                    style={{ left: n.x, top: n.y, width: CMD_W, height: CMD_H }}
                                >
                                    <div className="flex items-start justify-between h-full">
                                        <div className="flex items-start gap-3 min-w-0 flex-1">
                                            <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border-2"
                                                style={{ backgroundColor: (n.node.color || cfg.color) + '15', borderColor: (n.node.color || cfg.color) + '40' }}>
                                                <i className={cfg.icon} style={{ color: n.node.color || cfg.color }}></i>
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <h4 className="text-xs font-black text-white uppercase tracking-wider truncate">{n.node.label}</h4>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-400">{cfg.label}</span>
                                                    {n.node.liveStatus && (
                                                        <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded flex items-center gap-1 ${
                                                            n.node.liveStatus === 'Engaged' ? 'bg-red-500/15 text-red-400' :
                                                            n.node.liveStatus === 'Holding' ? 'bg-amber-500/15 text-amber-400' :
                                                            n.node.liveStatus === 'RTB' ? 'bg-green-500/15 text-green-400' :
                                                            n.node.liveStatus === 'Regrouping' ? 'bg-yellow-500/15 text-yellow-400' :
                                                            n.node.liveStatus === 'Disengaging' ? 'bg-orange-500/15 text-orange-400' :
                                                            'bg-slate-500/15 text-slate-400'
                                                        }`}>
                                                            <span className={`w-1.5 h-1.5 rounded-full ${
                                                                n.node.liveStatus === 'Engaged' ? 'bg-red-500' :
                                                                n.node.liveStatus === 'Holding' ? 'bg-amber-500' :
                                                                n.node.liveStatus === 'RTB' ? 'bg-green-500' :
                                                                n.node.liveStatus === 'Regrouping' ? 'bg-yellow-500' :
                                                                n.node.liveStatus === 'Disengaging' ? 'bg-orange-500' :
                                                                'bg-slate-500'
                                                            }`}></span>
                                                            {n.node.liveStatus}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 mt-1.5 text-[10px] text-slate-500 flex-wrap">
                                                    {n.node.assignedUser && (
                                                        <span className="flex items-center gap-1 truncate">
                                                            {n.node.assignedUser.avatarUrl && <img src={n.node.assignedUser.avatarUrl} className="w-4 h-4 rounded-full object-cover shrink-0" alt="" />}
                                                            {n.node.assignedUser.name}
                                                        </span>
                                                    )}
                                                    {n.node.assignedUnit && (
                                                        <span className="flex items-center gap-1"><i className="fa-solid fa-people-group"></i> {n.node.assignedUnit.name}</span>
                                                    )}
                                                    {participant && (participant.ship || participant.shipUtilized) ? (
                                                        <span className="flex items-center gap-1 text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-sm">
                                                            {participant.ship?.imageUrl ? (
                                                                <img src={participant.ship.imageUrl} alt="" className="w-5 h-3 object-cover rounded-sm" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                                            ) : (
                                                                <i className="fa-solid fa-rocket text-[8px]"></i>
                                                            )}
                                                            {participant.ship?.name || participant.shipUtilized}
                                                        </span>
                                                    ) : participant ? (
                                                        <span className="flex items-center gap-1 text-slate-400 bg-slate-500/10 border border-slate-500/20 px-1.5 py-0.5 rounded-sm">
                                                            <i className="fa-solid fa-person-walking text-[8px]"></i>
                                                            On Foot
                                                        </span>
                                                    ) : null}
                                                    {!n.node.assignedUser && !n.node.assignedUnit && <span className="text-slate-600 italic">Unassigned</span>}
                                                </div>
                                            </div>
                                        </div>
                                        {canManage && (
                                            <div className="flex gap-1 opacity-0 group-hover/node:opacity-100 transition-opacity shrink-0">
                                                <button onClick={(e) => { e.stopPropagation(); onAddNode(n.node.id); }}
                                                    className="w-6 h-6 flex items-center justify-center text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 rounded-sm transition-colors text-[10px]" title="Add Child">
                                                    <i className="fa-solid fa-plus"></i>
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); onEditNode(n.node); }}
                                                    className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-white hover:bg-slate-700 rounded-sm transition-colors text-[10px]" title="Edit">
                                                    <i className="fa-solid fa-pen"></i>
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); onDeleteNode(n.node.id); }}
                                                    className="w-6 h-6 flex items-center justify-center text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded-sm transition-colors text-[10px]" title="Delete">
                                                    <i className="fa-solid fa-trash"></i>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}

                        {/* Position Nodes */}
                        {layoutNodes.filter(n => n.isPosition).map(n => {
                            const participant = n.node.assignedUserId
                                ? (operation.participants || []).find(p => p.userId === n.node.assignedUserId && p.timeLeft === null)
                                : null;

                            return (
                                <div
                                    key={`p-${n.id}`}
                                    className="absolute bg-slate-900/60 border border-slate-700 rounded-lg flex items-center gap-2.5 px-3 group/pos hover:border-slate-500 transition-colors"
                                    style={{ left: n.x, top: n.y, width: POS_W, height: POS_H }}
                                >
                                    {/* Avatar */}
                                    {participant?.user?.avatarUrl ? (
                                        <img src={participant.user.avatarUrl} alt="" className={`w-10 h-10 rounded-full shrink-0 object-cover border-2 ${participant?.isReady ? 'border-green-500' : 'border-slate-600'}`} />
                                    ) : (
                                        <div className={`w-10 h-10 rounded-full shrink-0 border-2 bg-slate-800 flex items-center justify-center ${participant?.isReady ? 'border-green-500' : 'border-slate-600'}`}>
                                            <i className="fa-solid fa-user text-slate-500 text-xs"></i>
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[10px] font-bold text-white truncate">{n.node.label}</p>
                                        {participant ? (
                                            <p className="text-[9px] text-slate-400 truncate">{participant.user?.name || 'Unknown'}</p>
                                        ) : n.node.assignedUser ? (
                                            <p className="text-[9px] text-slate-400 truncate">{n.node.assignedUser.name}</p>
                                        ) : (
                                            <p className="text-[9px] text-slate-600 italic">Unassigned</p>
                                        )}
                                        {participant && (participant.ship || participant.shipUtilized) ? (
                                            <div className="flex items-center gap-1 mt-0.5">
                                                {participant.ship?.imageUrl ? (
                                                    <img src={participant.ship.imageUrl} alt="" className="w-5 h-3 object-cover rounded-sm" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                                ) : (
                                                    <i className="fa-solid fa-rocket text-[7px] text-amber-400"></i>
                                                )}
                                                <span className="text-[8px] text-amber-400 truncate">{participant.ship?.name || participant.shipUtilized}</span>
                                            </div>
                                        ) : participant ? (
                                            <div className="flex items-center gap-1 mt-0.5">
                                                <i className="fa-solid fa-person-walking text-[7px] text-slate-500"></i>
                                                <span className="text-[8px] text-slate-500">On Foot</span>
                                            </div>
                                        ) : null}
                                    </div>
                                    {participant?.isReady && (
                                        <div className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center shrink-0">
                                            <i className="fa-solid fa-check text-[7px] text-black"></i>
                                        </div>
                                    )}
                                    {canManage && (
                                        <div className="flex gap-0.5 opacity-0 group-hover/pos:opacity-100 transition-opacity shrink-0">
                                            <button onClick={(e) => { e.stopPropagation(); onEditNode(n.node); }}
                                                className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-white hover:bg-slate-700 rounded-sm transition-colors text-[9px]" title="Edit">
                                                <i className="fa-solid fa-pen"></i>
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); onDeleteNode(n.node.id); }}
                                                className="w-5 h-5 flex items-center justify-center text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded-sm transition-colors text-[9px]" title="Delete">
                                                <i className="fa-solid fa-trash"></i>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Empty state */}
                    {nodes.length === 0 && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="text-center text-slate-600 opacity-50">
                                <i className="fa-solid fa-sitemap text-5xl mb-3"></i>
                                <p className="text-sm font-medium">ORBAT Structure</p>
                                <p className="text-xs">{canManage ? 'Add a root node to start building the command structure.' : 'No command structure defined.'}</p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Zoom Controls */}
                <div className="absolute bottom-3 right-3 bg-slate-900/90 border border-slate-700 rounded-lg backdrop-blur-xs p-1 flex flex-col gap-1 z-10">
                    <button onClick={() => setZoom(z => Math.min(z * 1.2, 2.0))}
                        className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 rounded-sm transition-colors text-sm" title="Zoom In">
                        <i className="fa-solid fa-plus"></i>
                    </button>
                    <button onClick={() => setZoom(z => Math.max(z * 0.8, 0.3))}
                        className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 rounded-sm transition-colors text-sm" title="Zoom Out">
                        <i className="fa-solid fa-minus"></i>
                    </button>
                    <div className="border-t border-slate-700 my-0.5"></div>
                    <button onClick={fitToView}
                        className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 rounded-sm transition-colors text-sm" title="Fit to View">
                        <i className="fa-solid fa-expand"></i>
                    </button>
                </div>
                <div className="absolute bottom-3 left-3 text-[9px] text-slate-600 font-mono z-10">{Math.round(zoom * 100)}%</div>
            </div>

            {/* Reserve Pool */}
            {reservePool.length > 0 && (
                <div className="mt-3 bg-slate-800/30 border border-slate-700/30 rounded-lg p-3">
                    <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-2">
                        <i className="fa-solid fa-users mr-1"></i> Reserve Pool ({reservePool.length} unassigned)
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {reservePool.map(p => (
                            <div key={p.userId} className="flex items-center gap-2 bg-slate-800/50 border border-slate-700/30 rounded-lg px-2.5 py-1.5">
                                {p.user?.avatarUrl ? (
                                    <img src={p.user.avatarUrl} alt="" className="w-6 h-6 rounded-full border border-slate-600 object-cover shrink-0" />
                                ) : (
                                    <div className="w-6 h-6 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center">
                                        <i className="fa-solid fa-user text-[8px] text-slate-500"></i>
                                    </div>
                                )}
                                <span className="text-[10px] text-white font-bold">{p.user?.name || 'Unknown'}</span>
                                {(p.ship || p.shipUtilized) ? (
                                    <span className="text-[8px] text-amber-400 flex items-center gap-1">
                                        {p.ship?.imageUrl ? (
                                            <img src={p.ship.imageUrl} alt="" className="w-4 h-3 object-cover rounded-sm" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                        ) : (
                                            <i className="fa-solid fa-rocket text-[7px]"></i>
                                        )}
                                        {p.ship?.name || p.shipUtilized}
                                    </span>
                                ) : (
                                    <span className="text-[8px] text-slate-500 flex items-center gap-1">
                                        <i className="fa-solid fa-person-walking text-[7px]"></i>
                                        On Foot
                                    </span>
                                )}
                                {p.isReady && <div className="w-3 h-3 bg-green-500 rounded-full flex items-center justify-center"><i className="fa-solid fa-check text-[5px] text-black"></i></div>}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default OpOrbatNodeGraph;
