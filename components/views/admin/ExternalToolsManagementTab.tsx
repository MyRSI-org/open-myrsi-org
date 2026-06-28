
import React, { useMemo, useState } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';
import { ExternalTool } from '../../../types';
import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

const UNCATEGORISED_LABEL = 'General';

const ExternalToolsManagementTab: React.FC = () => {
    const { externalTools, deleteExternalTool, reorderExternalTool } = useConfig();
    const { confirm } = useNotification();
    const { openExternalToolModal } = useModalRegistry();
    const [searchTerm, setSearchTerm] = useState('');
    const [reorderingId, setReorderingId] = useState<number | null>(null);

    // externalTools arrives pre-sorted by (category → sortOrder → title) from
    // getExternalToolsState. We just bucket by category for display.
    const grouped = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        const visible = term
            ? externalTools.filter(t =>
                t.title.toLowerCase().includes(term) ||
                (t.description || '').toLowerCase().includes(term) ||
                (t.url || '').toLowerCase().includes(term) ||
                (t.category || '').toLowerCase().includes(term))
            : externalTools;

        const map = new Map<string, ExternalTool[]>();
        for (const t of visible) {
            const key = (t.category && t.category.trim()) || UNCATEGORISED_LABEL;
            const list = map.get(key) || [];
            list.push(t);
            map.set(key, list);
        }
        const keys = Array.from(map.keys());
        keys.sort((a, b) => {
            if (a === UNCATEGORISED_LABEL) return 1;
            if (b === UNCATEGORISED_LABEL) return -1;
            return a.localeCompare(b);
        });
        return keys.map(key => ({ key, tools: map.get(key)! }));
    }, [externalTools, searchTerm]);

    const handleDelete = async (tool: ExternalTool) => {
        if (await confirm({ title: 'Delete External Tool', message: `Are you sure you want to delete the external tool "${tool.title}"?`, confirmText: 'Delete', variant: 'danger' })) {
            deleteExternalTool(tool.id);
        }
    };

    // Swaps sort_order with the neighbour above/below within the same category.
    // Two RPC calls per nudge — acceptable since this is admin-only and
    // happens during config, not in hot paths.
    const move = async (tool: ExternalTool, direction: 'up' | 'down') => {
        if (reorderingId !== null) return;
        const siblings = externalTools.filter(t => (t.category || '') === (tool.category || ''));
        const idx = siblings.findIndex(t => t.id === tool.id);
        const swapWith = direction === 'up' ? siblings[idx - 1] : siblings[idx + 1];
        if (!swapWith) return;
        setReorderingId(tool.id);
        try {
            const a = tool.sortOrder ?? 0;
            const b = swapWith.sortOrder ?? 0;
            // If both have the same sort_order (legacy zero-default), nudge by 1
            // so the swap is visible after the first move.
            if (a === b) {
                await reorderExternalTool(tool.id, direction === 'up' ? a - 1 : a + 1);
            } else {
                await Promise.all([
                    reorderExternalTool(tool.id, b),
                    reorderExternalTool(swapWith.id, a),
                ]);
            }
        } finally {
            setReorderingId(null);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="External Tools"
                icon="fa-solid fa-toolbox"
                accent="cyan"
                subtitle="Manage third-party resources and links. Group tools with categories; reorder within a category using the arrows."
                actions={
                    <div className="flex gap-2 w-full md:w-auto">
                        <div className="relative flex-1 md:w-64">
                            <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                            <input
                                type="text"
                                placeholder="Search tools..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white placeholder:text-slate-500 focus:ring-1 focus:ring-slate-400/50 focus:border-slate-500 outline-hidden text-sm font-medium transition-all"
                            />
                        </div>
                        <button
                            onClick={() => openExternalToolModal()}
                            className="flex items-center justify-center bg-slate-700 text-white font-bold px-4 py-2.5 rounded-lg border border-slate-600 hover:bg-slate-600 transition-colors shadow-lg text-sm whitespace-nowrap"
                        >
                            <i className="fa-solid fa-plus mr-2" />
                            Create Tool
                        </button>
                    </div>
                }
            />

            {grouped.length === 0 ? (
                <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 p-12 text-center">
                    <p className="text-slate-500 font-medium italic">No tools match your criteria.</p>
                </div>
            ) : grouped.map(group => (
                <div key={group.key} className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                    <div className="flex items-center justify-between bg-slate-800/60 px-4 py-2.5 border-b border-slate-700/50">
                        <p className="text-[11px] font-black text-slate-300 uppercase tracking-[0.18em] flex items-center gap-2">
                            <i className="fa-solid fa-folder-open text-cyan-500/60 text-xs"></i>
                            {group.key}
                            <span className="text-slate-600 font-mono">({group.tools.length})</span>
                        </p>
                    </div>

                    <div className="divide-y divide-slate-700/50">
                        {group.tools.map((tool, idx) => {
                            const isFirst = idx === 0;
                            const isLast = idx === group.tools.length - 1;
                            return (
                                <div key={tool.id} className="flex items-center p-4 hover:bg-slate-800/50 transition-colors group">
                                    {/* Reorder controls */}
                                    <div className="flex flex-col items-center gap-0.5 mr-3 w-6 shrink-0">
                                        <button
                                            onClick={() => move(tool, 'up')}
                                            disabled={isFirst || reorderingId !== null}
                                            className="text-slate-500 hover:text-cyan-300 disabled:opacity-30 disabled:cursor-not-allowed text-[10px] p-0.5"
                                            title="Move up within category"
                                        >
                                            <i className="fa-solid fa-chevron-up"></i>
                                        </button>
                                        <button
                                            onClick={() => move(tool, 'down')}
                                            disabled={isLast || reorderingId !== null}
                                            className="text-slate-500 hover:text-cyan-300 disabled:opacity-30 disabled:cursor-not-allowed text-[10px] p-0.5"
                                            title="Move down within category"
                                        >
                                            <i className="fa-solid fa-chevron-down"></i>
                                        </button>
                                    </div>

                                    <div className="flex-1 min-w-0 pr-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-sm bg-slate-800 flex items-center justify-center border border-slate-700 text-slate-300 shrink-0">
                                                <i className={`${tool.icon || 'fa-solid fa-link'} text-lg`} />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="text-white font-bold text-sm truncate">{tool.title}</h3>
                                                <p className="text-slate-500 text-xs truncate">{tool.description}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="w-64 hidden md:block pr-4">
                                        <a href={tool.url} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-400 hover:text-slate-200 hover:underline truncate block font-mono">
                                            {tool.url}
                                        </a>
                                    </div>

                                    <div className="w-48 hidden lg:flex flex-wrap gap-1">
                                        {tool.audience.slice(0, 3).map((role) => (
                                            <span key={role} className="text-[9px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded-sm border border-slate-700 uppercase font-bold">
                                                {role}
                                            </span>
                                        ))}
                                        {tool.audience.length > 3 && (
                                            <span className="text-[9px] text-slate-500 px-1 py-0.5">+{tool.audience.length - 3}</span>
                                        )}
                                    </div>

                                    <div className="w-24 text-right flex justify-end gap-2">
                                        <button onClick={() => openExternalToolModal(tool)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-sm transition-colors" title="Edit">
                                            <i className="fa-solid fa-pencil"></i>
                                        </button>
                                        <button onClick={() => handleDelete(tool)} className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-sm transition-colors" title="Delete">
                                            <i className="fa-solid fa-trash-can"></i>
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};

export default ExternalToolsManagementTab;
