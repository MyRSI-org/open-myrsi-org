import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useAuth } from '../../../contexts/AuthContext';
import { WikiPage } from '../../../types';
import WikiPageTree from './WikiPageTree';
import WikiPageContent from './WikiPageContent';
import WikiEditor from './WikiEditor';
import WikiPageSettings from './WikiPageSettings';
import WikiHomePage from './WikiHomePage';
import WikiTopBar from './WikiTopBar';
import WikiQuickJump from './WikiQuickJump';
import BottomSheet from '../../shared/ui/BottomSheet';

const EMPTY_CONTENT = {};

const isInputFocused = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
};

const WikiView: React.FC = () => {
    const { wikiPages, rpcAction, refreshWiki, reorderWikiPages } = useData();
    const { wikiHomeConfig, updateWikiHomeConfig } = useConfig();
    const { currentUser, hasPermission } = useAuth();

    const canCreate = hasPermission('wiki:add_page');
    const canEditPages = hasPermission('wiki:edit_page');
    const canDelete = hasPermission('wiki:delete_page');

    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [newPageTitle, setNewPageTitle] = useState('');
    const [newPageParentId, setNewPageParentId] = useState<string | null>(null);
    const [newPageClassification, setNewPageClassification] = useState(0);
    const [newPageMarkerIds, setNewPageMarkerIds] = useState<number[]>([]);
    const [isInitialLoading, setIsInitialLoading] = useState(true);

    const [isMobileTreeOpen, setIsMobileTreeOpen] = useState(false);
    const [isQuickJumpOpen, setIsQuickJumpOpen] = useState(false);

    useEffect(() => {
        refreshWiki().finally(() => setIsInitialLoading(false));
    }, [refreshWiki]);

    const visiblePages = useMemo(() => {
        if (!currentUser) return [];
        const userLevel = currentUser.clearanceLevel?.level || 0;
        const userMarkerIds = new Set(currentUser.limitingMarkers?.map((m) => m.id));
        return wikiPages.filter((page) => {
            if (page.classificationLevel > userLevel) return false;
            if (page.limitingMarkers && page.limitingMarkers.length > 0) {
                const hasAllMarkers = page.limitingMarkers.every((m) => userMarkerIds.has(m.id));
                if (!hasAllMarkers) return false;
            }
            return true;
        });
    }, [wikiPages, currentUser]);

    const selectedPage = useMemo(
        () => visiblePages.find((p) => p.id === selectedPageId) || null,
        [visiblePages, selectedPageId]
    );

    const handleSelectPage = useCallback((page: WikiPage) => {
        setSelectedPageId(page.id);
        setIsCreating(false);
        setIsMobileTreeOpen(false);
    }, []);

    const handleSelectPageId = useCallback((pageId: string | null) => {
        setSelectedPageId(pageId);
        setIsCreating(false);
        setIsMobileTreeOpen(false);
    }, []);

    const handleStartCreate = useCallback((parentId: string | null = null) => {
        setNewPageParentId(parentId);
        setNewPageTitle('');
        setNewPageClassification(0);
        setNewPageMarkerIds([]);
        setIsCreating(true);
        setSelectedPageId(null);
        setIsMobileTreeOpen(false);
    }, []);

    const handleCreatePage = useCallback(
        async (contentJson: any) => {
            if (!newPageTitle.trim()) return;
            try {
                const result = await rpcAction('wiki:create_page', {
                    data: {
                        title: newPageTitle.trim(),
                        content: contentJson,
                        parentPageId: newPageParentId,
                        classificationLevel: newPageClassification,
                        markerIds: newPageMarkerIds,
                    },
                });
                await refreshWiki();
                setIsCreating(false);
                if (result?.id) setSelectedPageId(result.id);
            } catch (e) {
                console.error('Failed to create wiki page:', e);
            }
        },
        [newPageTitle, newPageParentId, newPageClassification, newPageMarkerIds, rpcAction, refreshWiki]
    );

    const handleSavePage = useCallback(
        async (id: string, data: any) => {
            try {
                await rpcAction('wiki:update_page', { id, data });
                await refreshWiki();
            } catch (e) {
                console.error('Failed to save wiki page:', e);
            }
        },
        [rpcAction, refreshWiki]
    );

    const handleReorderPages = useCallback(
        async (updates: { id: string; sortOrder: number }[]) => {
            try {
                await reorderWikiPages(updates);
            } catch (e) {
                console.error('Failed to reorder wiki pages:', e);
            }
        },
        [reorderWikiPages]
    );

    const handleDeletePage = useCallback(
        async (id: string) => {
            try {
                await rpcAction('wiki:delete_page', { id });
                await refreshWiki();
                if (selectedPageId === id) setSelectedPageId(null);
            } catch (e) {
                console.error('Failed to delete wiki page:', e);
            }
        },
        [rpcAction, refreshWiki, selectedPageId]
    );

    // Cmd/Ctrl+K opens quick jump
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                if (isInputFocused() && !isQuickJumpOpen) {
                    // still allow override — common pattern
                }
                e.preventDefault();
                setIsQuickJumpOpen((open) => !open);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isQuickJumpOpen]);

    const treeNode = (
        <WikiPageTree
            pages={visiblePages}
            selectedPageId={selectedPageId}
            onSelect={handleSelectPage}
            onAddChild={canCreate ? handleStartCreate : undefined}
            onReorder={canEditPages ? handleReorderPages : undefined}
            canEdit={canCreate}
        />
    );

    return (
        <div className="flex flex-col h-full animate-fade-in bg-slate-950">
            <WikiTopBar
                currentPage={selectedPage}
                allPages={visiblePages}
                onSelectPage={handleSelectPageId}
                onOpenTree={() => setIsMobileTreeOpen(true)}
                onOpenQuickJump={() => setIsQuickJumpOpen(true)}
                onAddPage={canCreate ? () => handleStartCreate(null) : undefined}
                canCreate={canCreate}
                isCreating={isCreating}
            />

            <div className="flex flex-1 min-h-0">
                <aside className="hidden md:flex md:w-64 lg:w-72 shrink-0 flex-col bg-slate-900/60 border-r border-slate-800">
                    <div className="flex items-center gap-2 p-3 border-b border-slate-800">
                        <i className="fa-solid fa-book text-sky-500 text-sm" />
                        <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.25em]">Org Wiki</h2>
                    </div>
                    <button
                        onClick={() => { setSelectedPageId(null); setIsCreating(false); }}
                        className={`mx-2 mt-2 flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                            !selectedPageId && !isCreating
                                ? 'bg-sky-600/20 text-sky-400 border border-sky-500/30'
                                : 'text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent'
                        }`}
                    >
                        <i className="fa-solid fa-house text-[10px]" />
                        Wiki Home
                    </button>
                    <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                        {treeNode}
                    </div>
                </aside>

                <main className="flex-1 overflow-y-auto custom-scrollbar">
                    <div className="p-4 md:p-6 lg:p-8">
                        {isInitialLoading ? (
                            <div className="max-w-4xl space-y-6 animate-pulse">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 bg-slate-800 rounded-sm" />
                                    <div className="h-7 bg-slate-800 rounded-sm w-32" />
                                </div>
                                <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-6 space-y-4">
                                    <div className="h-5 bg-slate-800 rounded-sm w-3/4" />
                                    <div className="h-4 bg-slate-800/60 rounded-sm w-full" />
                                    <div className="h-4 bg-slate-800/60 rounded-sm w-5/6" />
                                    <div className="h-4 bg-slate-800/60 rounded-sm w-2/3" />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {['skeleton-a', 'skeleton-b', 'skeleton-c'].map((key) => (
                                        <div key={key} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 space-y-3">
                                            <div className="h-4 bg-slate-800 rounded-sm w-2/3" />
                                            <div className="h-3 bg-slate-800/60 rounded-sm w-full" />
                                            <div className="h-3 bg-slate-800/60 rounded-sm w-1/2" />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : isCreating ? (
                            <div className="space-y-4 max-w-4xl">
                                <div className="flex items-center gap-3 pb-4 border-b border-slate-700/50">
                                    <button
                                        onClick={() => setIsCreating(false)}
                                        className="text-slate-400 hover:text-white transition-colors"
                                    >
                                        <i className="fa-solid fa-arrow-left" />
                                    </button>
                                    <h1 className="text-xl md:text-2xl font-bold text-white">Create New Page</h1>
                                </div>

                                <div>
                                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">
                                        Page Title
                                    </label>
                                    <input
                                        type="text"
                                        value={newPageTitle}
                                        onChange={(e) => setNewPageTitle(e.target.value)}
                                        placeholder="Enter page title..."
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white text-base md:text-lg font-bold placeholder-slate-600 focus:ring-2 focus:ring-sky-500 outline-hidden"
                                        autoFocus
                                    />
                                </div>

                                <WikiPageSettings
                                    classificationLevel={newPageClassification}
                                    setClassificationLevel={setNewPageClassification}
                                    selectedMarkerIds={newPageMarkerIds}
                                    setSelectedMarkerIds={setNewPageMarkerIds}
                                    parentPageId={newPageParentId}
                                    setParentPageId={setNewPageParentId}
                                    allPages={visiblePages}
                                />

                                <WikiEditor
                                    content={EMPTY_CONTENT}
                                    editable={true}
                                    onSave={handleCreatePage}
                                    onCancel={() => setIsCreating(false)}
                                />
                            </div>
                        ) : selectedPage ? (
                            <div className="max-w-4xl">
                                <WikiPageContent
                                    page={selectedPage}
                                    allPages={visiblePages}
                                    canEdit={canEditPages}
                                    canDelete={canDelete}
                                    onSave={handleSavePage}
                                    onDelete={handleDeletePage}
                                    onSelectPage={handleSelectPageId}
                                />
                            </div>
                        ) : (
                            <WikiHomePage
                                config={wikiHomeConfig}
                                visiblePages={visiblePages}
                                canEdit={canEditPages}
                                onSelectPage={handleSelectPage}
                                onSaveConfig={updateWikiHomeConfig}
                            />
                        )}
                    </div>
                </main>
            </div>

            <BottomSheet
                isOpen={isMobileTreeOpen}
                onClose={() => setIsMobileTreeOpen(false)}
                title="Org Wiki"
            >
                <div className="px-2 pb-4 pt-2">
                    <button
                        onClick={() => { setSelectedPageId(null); setIsCreating(false); setIsMobileTreeOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 mb-2 text-xs font-medium rounded-lg transition-colors ${
                            !selectedPageId && !isCreating
                                ? 'bg-sky-600/20 text-sky-400 border border-sky-500/30'
                                : 'text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent'
                        }`}
                    >
                        <i className="fa-solid fa-house text-[10px]" />
                        Wiki Home
                    </button>
                    {canCreate && (
                        <button
                            onClick={() => handleStartCreate(null)}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 mb-2 text-xs font-bold text-sky-400 hover:text-white bg-sky-600/10 hover:bg-sky-600 border border-sky-500/30 rounded-lg transition-colors"
                        >
                            <i className="fa-solid fa-plus" />
                            New Page
                        </button>
                    )}
                    {treeNode}
                </div>
            </BottomSheet>

            <WikiQuickJump
                isOpen={isQuickJumpOpen}
                onClose={() => setIsQuickJumpOpen(false)}
                pages={visiblePages}
                onSelect={handleSelectPage}
            />
        </div>
    );
};

export default WikiView;
