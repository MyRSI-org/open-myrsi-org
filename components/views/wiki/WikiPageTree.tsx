import React, { useState, useCallback, useMemo } from 'react';
import { WikiPage } from '../../../types';

interface WikiPageTreeProps {
    pages: WikiPage[];
    selectedPageId: string | null;
    onSelect: (page: WikiPage) => void;
    onAddChild?: (parentId: string | null) => void;
    onReorder?: (updates: { id: string; sortOrder: number }[]) => void;
    canEdit: boolean;
}

type DropPosition = 'before' | 'after';

interface DragState {
    draggedId: string | null;
    targetId: string | null;
    position: DropPosition | null;
}

interface TreeNodeProps {
    page: WikiPage;
    childPages: WikiPage[];
    allPages: WikiPage[];
    selectedPageId: string | null;
    onSelect: (page: WikiPage) => void;
    onAddChild?: (parentId: string | null) => void;
    canEdit: boolean;
    canReorder: boolean;
    depth: number;
    dragState: DragState;
    onDragStart: (id: string) => void;
    onDragOver: (id: string, position: DropPosition) => void;
    onDragLeave: () => void;
    onDrop: () => void;
    onDragEnd: () => void;
    // Expansion state is lifted to the parent so collapse/expand-all and
    // selected-page auto-reveal can drive every node from one source of truth.
    expandedIds: Set<string>;
    onToggleExpanded: (id: string) => void;
}

const TreeNode: React.FC<TreeNodeProps> = ({
    page, childPages, allPages, selectedPageId, onSelect, onAddChild, canEdit, canReorder, depth,
    dragState, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
    expandedIds, onToggleExpanded,
}) => {
    const isExpanded = expandedIds.has(page.id);
    const isSelected = selectedPageId === page.id;
    const hasChildren = childPages.length > 0;
    const isBeingDragged = dragState.draggedId === page.id;
    const showDropAbove = dragState.targetId === page.id && dragState.position === 'before';
    const showDropBelow = dragState.targetId === page.id && dragState.position === 'after';

    const getChildPages = useCallback(
        (parentId: string) => allPages.filter((p) => p.parentPageId === parentId).sort((a, b) => a.sortOrder - b.sortOrder),
        [allPages]
    );

    const handleDragOver = (e: React.DragEvent) => {
        if (!canReorder || !dragState.draggedId || dragState.draggedId === page.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const position: DropPosition = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
        onDragOver(page.id, position);
    };

    return (
        <div>
            {showDropAbove && (
                <div className="h-0.5 bg-sky-400 rounded-sm mx-2" style={{ marginLeft: `${depth * 16 + 8}px` }} />
            )}
            <div
                draggable={canReorder}
                onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(page.id);
                }}
                onDragOver={handleDragOver}
                onDragLeave={onDragLeave}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDrop();
                }}
                onDragEnd={onDragEnd}
                className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer transition-all text-sm ${
                    isSelected
                        ? 'bg-sky-600/20 text-sky-300 border border-sky-500/30'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white border border-transparent'
                } ${isBeingDragged ? 'opacity-40' : ''}`}
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
                onClick={() => onSelect(page)}
            >
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpanded(page.id);
                    }}
                    className={`w-4 h-4 flex items-center justify-center text-[10px] text-slate-500 hover:text-white transition-colors ${
                        !hasChildren ? 'invisible' : ''
                    }`}
                >
                    <i className={`fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'}`}></i>
                </button>

                <i className={`fa-solid ${hasChildren ? 'fa-folder-open' : 'fa-file-lines'} text-xs ${isSelected ? 'text-sky-400' : 'text-slate-500'}`}></i>

                <span className="truncate flex-1 font-medium text-xs">{page.title}</span>

                {/* Menu lock indicator. Visual only — sibling reordering is
                    still permitted; only re-parenting is blocked. */}
                {page.menuStructureLocked && (
                    <i className="fa-solid fa-lock text-[9px] text-amber-400/70" title="Menu position locked"></i>
                )}

                {page.classificationLevel > 0 && (
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                        page.classificationLevel >= 3
                            ? 'bg-red-900/30 text-red-400'
                            : page.classificationLevel >= 2
                            ? 'bg-orange-900/30 text-orange-400'
                            : 'bg-yellow-900/30 text-yellow-400'
                    }`}>
                        L{page.classificationLevel}
                    </span>
                )}

                {canEdit && onAddChild && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onAddChild(page.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-[10px] text-slate-500 hover:text-sky-400 transition-all"
                        title="Add child page"
                    >
                        <i className="fa-solid fa-plus"></i>
                    </button>
                )}
            </div>
            {showDropBelow && (
                <div className="h-0.5 bg-sky-400 rounded-sm mx-2" style={{ marginLeft: `${depth * 16 + 8}px` }} />
            )}

            {isExpanded && hasChildren && (
                <div>
                    {childPages.map((child) => (
                        <TreeNode
                            key={child.id}
                            page={child}
                            childPages={getChildPages(child.id)}
                            allPages={allPages}
                            selectedPageId={selectedPageId}
                            onSelect={onSelect}
                            onAddChild={onAddChild}
                            canEdit={canEdit}
                            canReorder={canReorder}
                            depth={depth + 1}
                            dragState={dragState}
                            onDragStart={onDragStart}
                            onDragOver={onDragOver}
                            onDragLeave={onDragLeave}
                            onDrop={onDrop}
                            onDragEnd={onDragEnd}
                            expandedIds={expandedIds}
                            onToggleExpanded={onToggleExpanded}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

const WikiPageTree: React.FC<WikiPageTreeProps> = ({ pages, selectedPageId, onSelect, onAddChild, onReorder, canEdit }) => {
    const canReorder = !!onReorder;
    const [dragState, setDragState] = useState<DragState>({ draggedId: null, targetId: null, position: null });

    // Tree starts fully collapsed. The selected page's ancestors are auto-added
    // so the user always sees their current location; explicit toggles persist
    // for the lifetime of the component.
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

    const rootPages = pages.filter((p) => !p.parentPageId).sort((a, b) => a.sortOrder - b.sortOrder);

    const allParentIds = useMemo(() => {
        const set = new Set<string>();
        for (const p of pages) {
            if (pages.some(c => c.parentPageId === p.id)) set.add(p.id);
        }
        return set;
    }, [pages]);

    // Walk up parentPageId from the selected page and union its ancestors into
    // the expanded set so the path stays visible even with collapse-by-default.
    // This MERGES into user-mutable state (manual toggles must persist), so it
    // is not pure derived state. Done during render via a previous-value tracker
    // keyed on the same (selectedPageId, pages) the old effect depended on,
    // instead of a synchronous setState in an effect. The functional updater
    // returns the SAME set reference when nothing is added, so React bails out
    // — no render loop — making this behavior-equivalent to the old effect.
    const [prevSelectedPageId, setPrevSelectedPageId] = useState(selectedPageId);
    const [prevPages, setPrevPages] = useState(pages);
    if (selectedPageId !== prevSelectedPageId || pages !== prevPages) {
        setPrevSelectedPageId(selectedPageId);
        setPrevPages(pages);
        if (selectedPageId) {
            const byId = new Map(pages.map(p => [p.id, p]));
            const ancestors: string[] = [];
            let cur = byId.get(selectedPageId);
            while (cur && cur.parentPageId) {
                ancestors.push(cur.parentPageId);
                cur = byId.get(cur.parentPageId);
            }
            if (ancestors.length > 0) {
                setExpandedIds(prev => {
                    const next = new Set(prev);
                    let changed = false;
                    for (const id of ancestors) if (!next.has(id)) { next.add(id); changed = true; }
                    return changed ? next : prev;
                });
            }
        }
    }

    const handleToggleExpanded = useCallback((id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const expandAll = useCallback(() => setExpandedIds(new Set(allParentIds)), [allParentIds]);
    const collapseAll = useCallback(() => setExpandedIds(new Set()), []);

    const getChildPages = useCallback(
        (parentId: string) => pages.filter((p) => p.parentPageId === parentId).sort((a, b) => a.sortOrder - b.sortOrder),
        [pages]
    );

    const handleDragStart = useCallback((id: string) => {
        setDragState({ draggedId: id, targetId: null, position: null });
    }, []);

    const handleDragOver = useCallback((id: string, position: DropPosition) => {
        setDragState((s) => (s.targetId === id && s.position === position ? s : { ...s, targetId: id, position }));
    }, []);

    const handleDragLeave = useCallback(() => {
        setDragState((s) => ({ ...s, targetId: null, position: null }));
    }, []);

    const handleDragEnd = useCallback(() => {
        setDragState({ draggedId: null, targetId: null, position: null });
    }, []);

    const handleDrop = useCallback(() => {
        const { draggedId, targetId, position } = dragState;
        setDragState({ draggedId: null, targetId: null, position: null });
        if (!draggedId || !targetId || !position || !onReorder || draggedId === targetId) return;

        const dragged = pages.find((p) => p.id === draggedId);
        const target = pages.find((p) => p.id === targetId);
        if (!dragged || !target) return;

        // Only sibling reordering: dragged and target must share a parent.
        // Reparenting is handled via the page settings panel.
        if ((dragged.parentPageId || null) !== (target.parentPageId || null)) return;

        const siblings = pages
            .filter((p) => (p.parentPageId || null) === (dragged.parentPageId || null) && p.id !== draggedId)
            .sort((a, b) => a.sortOrder - b.sortOrder);

        const targetIdx = siblings.findIndex((p) => p.id === targetId);
        if (targetIdx === -1) return;

        const insertAt = position === 'before' ? targetIdx : targetIdx + 1;
        const reordered = [...siblings.slice(0, insertAt), dragged, ...siblings.slice(insertAt)];

        const updates = reordered
            .map((p, idx) => ({ id: p.id, sortOrder: idx }))
            .filter((u) => {
                const original = pages.find((p) => p.id === u.id);
                return original && original.sortOrder !== u.sortOrder;
            });

        if (updates.length > 0) onReorder(updates);
    }, [dragState, pages, onReorder]);

    if (pages.length === 0) {
        return (
            <div className="text-center py-8 text-slate-500">
                <i className="fa-solid fa-book text-2xl mb-2 block"></i>
                <p className="text-xs">No pages yet</p>
            </div>
        );
    }

    const allCollapsed = expandedIds.size === 0;
    const allExpanded = allParentIds.size > 0 && expandedIds.size >= allParentIds.size && [...allParentIds].every(id => expandedIds.has(id));
    const hasParents = allParentIds.size > 0;

    return (
        <div className="space-y-0.5">
            {hasParents && (
                <div className="flex items-center justify-end gap-1 px-1 pb-1.5 mb-0.5 border-b border-slate-800/40">
                    <button
                        type="button"
                        onClick={expandAll}
                        disabled={allExpanded}
                        title="Expand all"
                        className="text-[10px] font-bold text-slate-500 hover:text-sky-300 px-1.5 py-0.5 rounded-sm hover:bg-slate-800/60 uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <i className="fa-solid fa-angles-down mr-1"></i>Expand
                    </button>
                    <button
                        type="button"
                        onClick={collapseAll}
                        disabled={allCollapsed}
                        title="Collapse all"
                        className="text-[10px] font-bold text-slate-500 hover:text-sky-300 px-1.5 py-0.5 rounded-sm hover:bg-slate-800/60 uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <i className="fa-solid fa-angles-up mr-1"></i>Collapse
                    </button>
                </div>
            )}
            {rootPages.map((page) => (
                <TreeNode
                    key={page.id}
                    page={page}
                    childPages={getChildPages(page.id)}
                    allPages={pages}
                    selectedPageId={selectedPageId}
                    onSelect={onSelect}
                    onAddChild={onAddChild}
                    canEdit={canEdit}
                    canReorder={canReorder}
                    depth={0}
                    dragState={dragState}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    expandedIds={expandedIds}
                    onToggleExpanded={handleToggleExpanded}
                />
            ))}
        </div>
    );
};

export default WikiPageTree;
