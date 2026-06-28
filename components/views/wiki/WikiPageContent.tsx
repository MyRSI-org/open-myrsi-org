import React, { useState } from 'react';
import { WikiPage } from '../../../types';
import { useMembers } from '../../../contexts/MembersContext';
import { useFormatDate } from '../../../contexts/AuthContext';
import WikiEditor from './WikiEditor';
import WikiPageSettings from './WikiPageSettings';
import WikiBreadcrumb from './WikiBreadcrumb';

interface WikiPageContentProps {
    page: WikiPage;
    allPages: WikiPage[];
    canEdit: boolean;
    canDelete: boolean;
    onSave: (id: string, data: any) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    onSelectPage?: (pageId: string | null) => void;
}

const WikiPageContent: React.FC<WikiPageContentProps> = ({
    page, allPages, canEdit, canDelete, onSave, onDelete, onSelectPage,
}) => {
    const { securityClearances } = useMembers();
    const fmt = useFormatDate();
    const [isEditing, setIsEditing] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [editTitle, setEditTitle] = useState(page.title);
    const [classificationLevel, setClassificationLevel] = useState(page.classificationLevel);
    const [selectedMarkerIds, setSelectedMarkerIds] = useState<number[]>(page.limitingMarkers?.map((m) => m.id) || []);
    const [parentPageId, setParentPageId] = useState<string | null>(page.parentPageId);
    const [menuStructureLocked, setMenuStructureLocked] = useState<boolean>(!!page.menuStructureLocked);
    const [isDeleting, setIsDeleting] = useState(false);

    // Re-seed the editable copies of the page fields when the selected page.id
    // changes (navigation). Done during render via a previous-value tracker
    // (React re-renders before paint, so it is behavior-equivalent to the old
    // [page.id] form-reset effect) instead of a synchronous setState in an
    // effect. Keyed ONLY on page.id — exactly like the effect's single-dep
    // array — so realtime updates to the OTHER page.* fields do not clobber the
    // user's in-progress edits; the fields/values/guards below match the old
    // effect (and handleCancel) verbatim.
    const [prevPageId, setPrevPageId] = useState(page.id);
    if (page.id !== prevPageId) {
        setPrevPageId(page.id);
        setIsEditing(false);
        setShowSettings(false);
        setEditTitle(page.title);
        setClassificationLevel(page.classificationLevel);
        setSelectedMarkerIds(page.limitingMarkers?.map((m) => m.id) || []);
        setParentPageId(page.parentPageId);
        setMenuStructureLocked(!!page.menuStructureLocked);
    }

    const handleSave = async (contentJson: any) => {
        await onSave(page.id, {
            title: editTitle.trim() || page.title,
            content: contentJson,
            classificationLevel,
            markerIds: selectedMarkerIds,
            parentPageId,
            menuStructureLocked,
        });
        setIsEditing(false);
        setShowSettings(false);
    };

    const getClassificationBandColor = (level: number) => {
        if (level >= 4) return 'border-red-500/50 text-red-400';
        if (level === 3) return 'border-red-500/40 text-red-400';
        if (level === 2) return 'border-orange-500/40 text-orange-400';
        if (level === 1) return 'border-yellow-500/40 text-yellow-400';
        return 'border-green-500/40 text-green-400';
    };

    const classificationName = securityClearances.find(c => c.level === page.classificationLevel)?.name
        || (page.classificationLevel === 0 ? 'Unclassified' : `Level ${page.classificationLevel}`);

    const markerCodes = page.limitingMarkers?.map(m => m.code || m.name).join(' / ') || '';

    const handleDelete = async () => {
        if (!window.confirm(`Delete "${page.title}"? Children will be moved to the root level.`)) return;
        setIsDeleting(true);
        try {
            await onDelete(page.id);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleCancel = () => {
        setIsEditing(false);
        setShowSettings(false);
        setEditTitle(page.title);
        setClassificationLevel(page.classificationLevel);
        setSelectedMarkerIds(page.limitingMarkers?.map((m) => m.id) || []);
        setParentPageId(page.parentPageId);
        setMenuStructureLocked(!!page.menuStructureLocked);
    };

    if (isEditing) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-700/50">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                        <button onClick={handleCancel} className="text-slate-400 hover:text-white transition-colors shrink-0">
                            <i className="fa-solid fa-arrow-left" />
                        </button>
                        <div className="flex-1 min-w-0">
                            <input
                                type="text"
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                placeholder="Page title..."
                                className="w-full bg-transparent text-xl md:text-2xl font-bold text-white placeholder-slate-600 outline-hidden border-b border-transparent focus:border-sky-500/50 transition-colors pb-0.5"
                            />
                            <p className="text-[10px] text-slate-500 mt-1">Title, content, and settings save together.</p>
                        </div>
                    </div>
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                            showSettings
                                ? 'text-white bg-slate-700 border-slate-600'
                                : 'text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border-slate-700'
                        }`}
                    >
                        <i className="fa-solid fa-gear md:mr-1.5" />
                        <span className="hidden md:inline">{showSettings ? 'Hide Settings' : 'Settings'}</span>
                    </button>
                </div>

                {showSettings && (
                    <WikiPageSettings
                        page={page}
                        classificationLevel={classificationLevel}
                        setClassificationLevel={setClassificationLevel}
                        selectedMarkerIds={selectedMarkerIds}
                        setSelectedMarkerIds={setSelectedMarkerIds}
                        parentPageId={parentPageId}
                        setParentPageId={setParentPageId}
                        menuStructureLocked={menuStructureLocked}
                        setMenuStructureLocked={setMenuStructureLocked}
                        allPages={allPages}
                    />
                )}

                <WikiEditor
                    content={page.content}
                    editable={true}
                    onSave={handleSave}
                    onCancel={handleCancel}
                />
            </div>
        );
    }

    return (
        <article className="space-y-4">
            {/* Desktop breadcrumb (mobile lives in WikiTopBar) */}
            {onSelectPage && (
                <div className="hidden md:block">
                    <WikiBreadcrumb page={page} allPages={allPages} onSelect={onSelectPage} />
                </div>
            )}

            <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 pb-4 border-b border-slate-700/50">
                <div className="flex-1 min-w-0">
                    <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight">{page.title}</h1>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-500 flex-wrap">
                        {page.updatedBy && (
                            <span className="flex items-center gap-1.5">
                                {page.updatedBy.avatarUrl && (
                                    <img src={page.updatedBy.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                                )}
                                <span className="text-slate-400">{page.updatedBy.name}</span>
                            </span>
                        )}
                        {page.updatedAt && (
                            <span className="font-mono">{fmt.date(page.updatedAt)}</span>
                        )}
                        {page.classificationLevel > 0 && (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                page.classificationLevel >= 3
                                    ? 'bg-red-900/30 text-red-400 border border-red-500/20'
                                    : page.classificationLevel >= 2
                                    ? 'bg-orange-900/30 text-orange-400 border border-orange-500/20'
                                    : 'bg-yellow-900/30 text-yellow-400 border border-yellow-500/20'
                            }`}>
                                Level {page.classificationLevel}
                            </span>
                        )}
                        {page.limitingMarkers?.map((m) => (
                            <span key={m.id} className="px-2 py-0.5 rounded-sm text-[10px] bg-amber-900/20 text-amber-400 border border-amber-500/20 font-bold uppercase tracking-wider">
                                {m.code || m.name}
                            </span>
                        ))}
                    </div>
                </div>

                {(canEdit || canDelete) && (
                    <div className="flex items-center gap-2 shrink-0">
                        {canEdit && (
                            <button
                                onClick={() => setIsEditing(true)}
                                className="px-3 py-1.5 text-xs font-bold text-sky-400 hover:text-white bg-sky-600/10 hover:bg-sky-600 border border-sky-500/30 rounded-lg transition-colors"
                            >
                                <i className="fa-solid fa-pen mr-1.5" />Edit
                            </button>
                        )}
                        {canDelete && (
                            <button
                                onClick={handleDelete}
                                disabled={isDeleting}
                                className="px-3 py-1.5 text-xs font-bold text-red-400 hover:text-white bg-red-600/10 hover:bg-red-600 border border-red-500/30 rounded-lg transition-colors disabled:opacity-50"
                            >
                                <i className={`fa-solid ${isDeleting ? 'fa-spinner fa-spin' : 'fa-trash'} mr-1.5`} />Delete
                            </button>
                        )}
                    </div>
                )}
            </header>

            {/* Classification band — top */}
            {page.classificationLevel > 0 && (
                <div className={`${getClassificationBandColor(page.classificationLevel)} border-t border-b border-slate-700/30 px-3 py-1 text-center text-[9px] font-bold uppercase tracking-[0.25em]`}>
                    {classificationName}{markerCodes ? ` // ${markerCodes}` : ''}
                </div>
            )}

            <div className="prose prose-invert prose-slate prose-base md:prose-lg max-w-none">
                <WikiEditor content={page.content} editable={false} />
            </div>

            {/* Classification band — bottom */}
            {page.classificationLevel > 0 && (
                <div className={`${getClassificationBandColor(page.classificationLevel)} border-t border-b border-slate-700/30 px-3 py-1 text-center text-[9px] font-bold uppercase tracking-[0.25em]`}>
                    {classificationName}{markerCodes ? ` // ${markerCodes}` : ''}
                </div>
            )}
        </article>
    );
};

export default WikiPageContent;
