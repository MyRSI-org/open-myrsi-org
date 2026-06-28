import React, { useMemo, useState, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useMembers } from '../../../contexts/MembersContext';
import { OrganizationalUnit } from '../../../types';
import { buildUnitTree, type UnitNode } from '../../../lib/unitTree';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import EmptyState from '../../shared/ui/EmptyState';
import { useNotification } from '../../../contexts/NotificationContext';
import { useNavigation } from '../../../contexts/NavigationContext';

// Org chart view. Renders the unit hierarchy as a connected tree:
// indentation + L-shaped connector lines (├ / └ style) + per-tier accent +
// collapsible subtrees. Indent stays at ~20px per depth level so even deeply
// nested orgs don't trigger horizontal scroll on narrow screens; long names
// truncate inside their card.

const OrganisationView: React.FC = () => {
    const { units, members } = useMembers();
    const { currentUser, hasPermission } = useAuth();
    const { addToast } = useNotification();
    const { viewUnitDetail } = useNavigation();
    const [search, setSearch] = useState('');
    const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

    const canViewAll = hasPermission('units:view_all');
    const myUnitId = currentUser?.unit?.id ?? null;

    const memberCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const m of members) {
            if (m.unit?.id != null) map.set(m.unit.id, (map.get(m.unit.id) || 0) + 1);
        }
        return map;
    }, [members]);

    const tree = useMemo(() => buildUnitTree(units), [units]);

    // Subtree member tally — recursive sum of self + descendants. Cached once
    // per tree build so each render of the chart doesn't re-walk the forest.
    const subtreeCounts = useMemo(() => {
        const map = new Map<number, number>();
        const visit = (node: UnitNode): number => {
            const own = memberCounts.get(node.id) || 0;
            const sub = node.children.reduce((acc, c) => acc + visit(c), 0);
            const total = own + sub;
            map.set(node.id, total);
            return total;
        };
        tree.forEach(visit);
        return map;
    }, [tree, memberCounts]);

    const stats = useMemo(() => {
        const restricted = units.filter(u => u.isRestricted).length;
        return {
            units: units.length,
            members: members.length,
            restricted,
        };
    }, [units, members]);

    // Search-aware filter: a node passes if it matches OR any descendant does.
    // Ancestors of a match stay visible so the path to the match is legible.
    const filterTree = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return tree;

        const filterNode = (node: UnitNode): UnitNode | null => {
            const filteredChildren = node.children.map(filterNode).filter(Boolean) as UnitNode[];
            const selfMatch = node.name.toLowerCase().includes(term)
                || (node.motto || '').toLowerCase().includes(term);
            if (selfMatch || filteredChildren.length > 0) {
                return { ...node, children: filteredChildren };
            }
            return null;
        };

        return tree.map(filterNode).filter(Boolean) as UnitNode[];
    }, [tree, search]);

    // Searching auto-expands so the matched path is visible without the user
    // having to manually open every ancestor.
    const effectiveCollapsed = search.trim() ? EMPTY_SET : collapsed;

    const toggleCollapsed = useCallback((id: number) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const expandAll = useCallback(() => setCollapsed(new Set()), []);
    const collapseAll = useCallback(() => {
        const all = new Set<number>();
        const visit = (node: UnitNode) => {
            if (node.children.length > 0) all.add(node.id);
            node.children.forEach(visit);
        };
        tree.forEach(visit);
        setCollapsed(all);
    }, [tree]);

    const handleNodeClick = (unit: OrganizationalUnit) => {
        const isMember = unit.id === myUnitId;
        const restricted = !!unit.isRestricted && !isMember && !canViewAll;
        if (restricted) {
            addToast(
                'Restricted Unit',
                <i className="fa-solid fa-lock"></i>,
                'bg-amber-500/10 text-amber-300 border-amber-500/30',
                { description: `${unit.name} is restricted to its members. Contact the unit leader or an admin for access.` }
            );
            return;
        }
        viewUnitDetail(unit.id);
    };

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · ORGANISATION"
                chipIcon="fa-sitemap"
                chipAccent="indigo"
                title="Organisation"
                subtitle="Browse the unit hierarchy. Open any unit to view its members, feed, and operations."
                statsCols={3}
                stats={<>
                    <HeroStat icon="fa-people-group" label="Units" value={stats.units} accent="indigo" emphasize={stats.units > 0} />
                    <HeroStat icon="fa-users" label="Personnel" value={stats.members} accent="cyan" emphasize={stats.members > 0} />
                    <HeroStat icon="fa-lock" label="Restricted" value={stats.restricted} accent="amber" emphasize={stats.restricted > 0} />
                </>}
            />

            <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 sm:p-6 space-y-4">
                <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                    <div className="relative flex-1 max-w-2xl">
                        <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                        <input
                            type="search"
                            placeholder="Search units by name or motto…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full bg-slate-900/60 text-white pl-12 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/40 transition-all"
                        />
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={expandAll}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900/60 text-slate-300 border border-slate-700 hover:text-white hover:border-indigo-500/30 text-[10px] font-black uppercase tracking-wider transition-colors"
                        >
                            <i className="fa-solid fa-angles-down"></i> Expand
                        </button>
                        <button
                            type="button"
                            onClick={collapseAll}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900/60 text-slate-300 border border-slate-700 hover:text-white hover:border-indigo-500/30 text-[10px] font-black uppercase tracking-wider transition-colors"
                        >
                            <i className="fa-solid fa-angles-up"></i> Collapse
                        </button>
                    </div>
                </div>

                {filterTree.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                        <EmptyState
                            icon="fa-sitemap"
                            accent="indigo"
                            heading={search ? 'No units match your search' : 'No units defined'}
                            description={search ? 'Try a different keyword or clear the search.' : 'An admin can create units in the Org Management settings.'}
                        />
                    </div>
                ) : (
                    <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 backdrop-blur-xs p-2 sm:p-3 overflow-x-hidden space-y-3">
                        {filterTree.map((node) => (
                            <UnitTreeBranch
                                key={node.id}
                                node={node}
                                depth={0}
                                isRoot
                                memberCounts={memberCounts}
                                subtreeCounts={subtreeCounts}
                                myUnitId={myUnitId}
                                canViewAll={canViewAll}
                                collapsed={effectiveCollapsed}
                                onToggle={toggleCollapsed}
                                onClick={handleNodeClick}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

const EMPTY_SET: ReadonlySet<number> = new Set();

interface UnitTreeBranchProps {
    node: UnitNode;
    depth: number;
    isRoot?: boolean;
    memberCounts: Map<number, number>;
    subtreeCounts: Map<number, number>;
    myUnitId: number | null;
    canViewAll: boolean;
    collapsed: ReadonlySet<number>;
    onToggle: (id: number) => void;
    onClick: (unit: OrganizationalUnit) => void;
}

// Per-tier accent colours. Index by depth (capped at last entry). The accent
// rides the left border of the card AND the chevron tint so the user can
// follow vertical bands at a glance even on a deep tree.
const TIER = [
    { border: 'border-l-indigo-500/70',  glow: 'shadow-indigo-500/10',  text: 'text-indigo-300',  bg: 'bg-indigo-500/10',  ring: 'ring-indigo-500/30' },
    { border: 'border-l-cyan-500/70',    glow: 'shadow-cyan-500/10',    text: 'text-cyan-300',    bg: 'bg-cyan-500/10',    ring: 'ring-cyan-500/30' },
    { border: 'border-l-emerald-500/70', glow: 'shadow-emerald-500/10', text: 'text-emerald-300', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/30' },
    { border: 'border-l-amber-500/70',   glow: 'shadow-amber-500/10',   text: 'text-amber-300',   bg: 'bg-amber-500/10',   ring: 'ring-amber-500/30' },
    { border: 'border-l-fuchsia-500/70', glow: 'shadow-fuchsia-500/10', text: 'text-fuchsia-300', bg: 'bg-fuchsia-500/10', ring: 'ring-fuchsia-500/30' },
] as const;

const UnitTreeBranch: React.FC<UnitTreeBranchProps> = ({
    node, depth, isRoot, memberCounts, subtreeCounts, myUnitId, canViewAll, collapsed, onToggle, onClick,
}) => {
    const isMember = node.id === myUnitId;
    const restricted = !!node.isRestricted && !isMember && !canViewAll;
    const ownCount = memberCounts.get(node.id) || 0;
    const subtreeTotal = subtreeCounts.get(node.id) || 0;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const tier = TIER[Math.min(depth, TIER.length - 1)];

    return (
        <div className="relative">
            {/* Row: chevron column + card. Row height drives the connector
                anchor for children below — keep py compact and consistent. */}
            <div className="flex items-stretch gap-1.5 sm:gap-2 group/row">
                {/* Chevron rail. Always 22px so connector geometry stays stable
                    whether or not this node has children. */}
                <button
                    type="button"
                    onClick={hasChildren ? () => onToggle(node.id) : undefined}
                    aria-label={hasChildren ? (isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`) : undefined}
                    aria-expanded={hasChildren ? !isCollapsed : undefined}
                    tabIndex={hasChildren ? 0 : -1}
                    className={`shrink-0 w-5 sm:w-6 self-stretch flex items-start justify-center pt-[18px] ${
                        hasChildren ? `cursor-pointer ${tier.text} hover:brightness-125` : 'cursor-default text-transparent pointer-events-none'
                    }`}
                >
                    <i className={`fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'} text-[10px] transition-transform`}></i>
                </button>

                <button
                    type="button"
                    onClick={() => onClick(node)}
                    className={`flex-1 min-w-0 flex items-center gap-2.5 sm:gap-3 pl-2.5 sm:pl-3 pr-3 py-4 sm:py-5 rounded-lg border-l-[3px] ${tier.border} border-y border-r transition-all text-left shadow-xs ${tier.glow} ${
                        restricted
                            ? 'bg-slate-900/40 border-y-amber-500/15 border-r-amber-500/15 hover:border-y-amber-500/30 hover:border-r-amber-500/30'
                            : 'bg-slate-900/70 border-y-slate-700/40 border-r-slate-700/40 hover:bg-slate-800/60 hover:border-y-indigo-500/40 hover:border-r-indigo-500/40 hover:shadow-md'
                    } ${isMember ? `ring-1 ${tier.ring}` : ''}`}
                >
                    <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center shrink-0 border ${
                        isMember ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-slate-700 bg-slate-950/60'
                    }`}>
                        {node.logoUrl ? (
                            <img src={node.logoUrl} className="w-full h-full object-cover rounded-lg" alt="" />
                        ) : (
                            <i className={`fa-solid fa-shield-halved ${isMember ? 'text-emerald-300' : 'text-slate-500'}`}></i>
                        )}
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                            <span className={`text-sm font-bold ${restricted ? 'text-slate-400' : 'text-white'} truncate`}>
                                {node.name}
                            </span>
                            {isRoot ? (
                                <span className={`text-[9px] font-black ${tier.text} ${tier.bg} border border-current/30 px-1.5 py-0.5 rounded-sm uppercase tracking-wider`}>
                                    Root
                                </span>
                            ) : (
                                <span className={`hidden sm:inline-block text-[9px] font-mono ${tier.text} opacity-60`}>
                                    T{depth}
                                </span>
                            )}
                            {isMember && (
                                <span className="text-[9px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded-sm uppercase tracking-wider">
                                    Your Unit
                                </span>
                            )}
                            {restricted && (
                                <span className="text-[9px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded-sm uppercase tracking-wider flex items-center gap-1">
                                    <i className="fa-solid fa-lock text-[8px]"></i> Restricted
                                </span>
                            )}
                        </div>
                        {node.motto && (
                            <p className="text-[11px] text-slate-500 italic truncate mt-0.5">"{node.motto}"</p>
                        )}
                    </div>

                    {/* Right metadata. Hides on the narrowest layouts so the
                        card title can claim the row. */}
                    <div className="hidden sm:flex items-center gap-2.5 shrink-0 text-[10px] font-mono">
                        {node.leader && (
                            <span className="hidden md:flex items-center gap-1.5 text-slate-500 max-w-[140px]">
                                {node.leader.avatarUrl && <img src={node.leader.avatarUrl} className="w-4 h-4 rounded-full object-cover shrink-0" alt="" />}
                                <span className="text-slate-400 truncate">{node.leader.name}</span>
                            </span>
                        )}
                        <span
                            className="text-slate-500 flex items-center gap-1"
                            title={hasChildren ? `${ownCount} direct, ${subtreeTotal} including sub-units` : `${ownCount} members`}
                        >
                            <i className="fa-solid fa-users text-[9px]"></i>
                            <span className="text-slate-300">{ownCount}</span>
                            {hasChildren && subtreeTotal !== ownCount && (
                                <span className="text-slate-600">/ {subtreeTotal}</span>
                            )}
                        </span>
                        {hasChildren && (
                            <span className={`flex items-center gap-1 ${tier.text} opacity-70`} title={`${node.children.length} sub-unit${node.children.length === 1 ? '' : 's'}`}>
                                <i className="fa-solid fa-code-fork text-[9px]"></i>
                                {node.children.length}
                            </span>
                        )}
                        {!restricted && (
                            <i className="fa-solid fa-chevron-right text-slate-600 group-hover/row:text-indigo-300 text-[10px] transition-colors"></i>
                        )}
                    </div>
                </button>
            </div>

            {/* Children. Each child wraps in a div that draws its own L-shape
                connector via inline-styled spans so the geometry tracks the row
                middle exactly (~44px down from the wrapper top — pt-3 (12px)
                gap above the card + ~32px to the row midpoint).
                Last child trims the vertical line to the row middle so the
                trunk doesn't dangle past the leaf. */}
            {hasChildren && !isCollapsed && (
                <div className="mt-2">
                    {node.children.map((child, i) => {
                        const isLast = i === node.children.length - 1;
                        return (
                            <div key={child.id} className="relative pt-3">
                                {/* Vertical trunk. For non-last children, runs the
                                    full wrapper height so the next sibling's
                                    horizontal stub continues from it. For the
                                    last child, stops at the row middle. */}
                                <span
                                    aria-hidden
                                    className="absolute left-[10px] sm:left-[12px] top-0 w-px bg-slate-700/50"
                                    style={{ height: isLast ? '44px' : '100%' }}
                                />
                                {/* Horizontal stub from trunk into the child's
                                    chevron column. */}
                                <span
                                    aria-hidden
                                    className="absolute left-[10px] sm:left-[12px] top-[44px] h-px w-[10px] sm:w-[12px] bg-slate-700/50"
                                />
                                <div className="pl-[20px] sm:pl-[24px]">
                                    <UnitTreeBranch
                                        node={child}
                                        depth={depth + 1}
                                        memberCounts={memberCounts}
                                        subtreeCounts={subtreeCounts}
                                        myUnitId={myUnitId}
                                        canViewAll={canViewAll}
                                        collapsed={collapsed}
                                        onToggle={onToggle}
                                        onClick={onClick}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default OrganisationView;
