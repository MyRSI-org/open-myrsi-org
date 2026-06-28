import React, { useEffect, useRef, useState } from 'react';
import { Editor } from '@tiptap/react';

interface WikiToolbarProps {
    editor: Editor;
}

const ToolbarButton: React.FC<{
    onClick: () => void;
    isActive?: boolean;
    icon: string;
    title: string;
}> = ({ onClick, isActive, icon, title }) => (
    <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        title={title}
        className={`shrink-0 w-8 h-8 flex items-center justify-center rounded text-xs transition-colors ${
            isActive
                ? 'bg-sky-600 text-white'
                : 'text-slate-300 hover:text-white hover:bg-slate-700'
        }`}
    >
        <i className={icon} />
    </button>
);

const Divider = () => <div className="shrink-0 w-px h-5 bg-slate-700 mx-0.5" />;

// Table-toolbar button — wider than ToolbarButton because it carries a
// visible label below the icon. Tools like "+ Col Left" / "Del Row" are
// unfamiliar enough that icon-only would be impenetrable.
const TableButton: React.FC<{
    onClick: () => void;
    isActive?: boolean;
    icon: string;
    label: string;
    title: string;
    danger?: boolean;
}> = ({ onClick, isActive, icon, label, title, danger }) => (
    <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        title={title}
        className={`shrink-0 flex flex-col items-center gap-0.5 px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider transition-colors ${
            isActive
                ? 'bg-amber-500/20 text-amber-200'
                : danger
                    ? 'text-slate-400 hover:text-red-300 hover:bg-red-500/10'
                    : 'text-slate-300 hover:text-amber-200 hover:bg-amber-500/10'
        }`}
    >
        <i className={`${icon} text-xs`} />
        <span className="whitespace-nowrap">{label}</span>
    </button>
);

const WikiToolbar: React.FC<WikiToolbarProps> = ({ editor }) => {
    const [isOverflowOpen, setIsOverflowOpen] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);

    // Force a re-render whenever the editor's selection moves — without this,
    // useEditor only re-renders on content changes, so editor.isActive('table')
    // (and the bold/italic active states) stay stale until the user types.
    // That made the contextual table toolbar appear seconds late.
    // renderTick value is intentionally unused; this state exists only to force a re-render via its setter.
    const [renderTick, setRenderTick] = useState(0);
    useEffect(() => {
        if (!editor) return;
        const handler = () => setRenderTick((n) => n + 1);
        editor.on('selectionUpdate', handler);
        editor.on('transaction', handler);
        return () => {
            editor.off('selectionUpdate', handler);
            editor.off('transaction', handler);
        };
    }, [editor]);

    useEffect(() => {
        if (!isOverflowOpen) return;
        const handler = (e: MouseEvent) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
                setIsOverflowOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOverflowOpen]);

    const promptAndInsert = (label: string, callback: (url: string) => void) => {
        const url = window.prompt(`Enter ${label} URL:`);
        if (url) callback(url);
    };

    // Essential group — always visible on every breakpoint
    const essentialGroup = (
        <>
            <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} isActive={editor.isActive('bold')} icon="fa-solid fa-bold" title="Bold" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} isActive={editor.isActive('italic')} icon="fa-solid fa-italic" title="Italic" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} isActive={editor.isActive('heading', { level: 2 })} icon="fa-solid fa-heading" title="Heading" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} isActive={editor.isActive('bulletList')} icon="fa-solid fa-list-ul" title="Bullet List" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} isActive={editor.isActive('orderedList')} icon="fa-solid fa-list-ol" title="Ordered List" />
            <ToolbarButton
                onClick={() => promptAndInsert('link', (url) => editor.chain().focus().setLink({ href: url }).run())}
                isActive={editor.isActive('link')}
                icon="fa-solid fa-link"
                title="Insert Link"
            />
        </>
    );

    // Secondary groups — on desktop these render inline; on mobile they collapse into "..." popover
    const secondaryGroups = (
        <>
            <Divider />
            <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} isActive={editor.isActive('underline')} icon="fa-solid fa-underline" title="Underline" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} isActive={editor.isActive('strike')} icon="fa-solid fa-strikethrough" title="Strikethrough" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} isActive={editor.isActive('heading', { level: 1 })} icon="fa-solid fa-heading fa-lg" title="Heading 1" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} isActive={editor.isActive('heading', { level: 3 })} icon="fa-solid fa-h fa-sm" title="Heading 3" />

            <Divider />

            <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} isActive={editor.isActive('blockquote')} icon="fa-solid fa-quote-left" title="Blockquote" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleCodeBlock().run()} isActive={editor.isActive('codeBlock')} icon="fa-solid fa-code" title="Code Block" />

            <Divider />

            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('left').run()} isActive={editor.isActive({ textAlign: 'left' })} icon="fa-solid fa-align-left" title="Align Left" />
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('center').run()} isActive={editor.isActive({ textAlign: 'center' })} icon="fa-solid fa-align-center" title="Align Center" />
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('right').run()} isActive={editor.isActive({ textAlign: 'right' })} icon="fa-solid fa-align-right" title="Align Right" />

            <Divider />

            <ToolbarButton
                onClick={() => promptAndInsert('image', (url) => editor.chain().focus().setImage({ src: url }).run())}
                icon="fa-solid fa-image"
                title="Insert Image (URL)"
            />
            <ToolbarButton
                onClick={() => promptAndInsert('YouTube', (url) => editor.chain().focus().setYoutubeVideo({ src: url }).run())}
                icon="fa-brands fa-youtube"
                title="Embed YouTube"
            />
            <ToolbarButton
                onClick={() => promptAndInsert('iframe (YouTube, Vimeo, Google Docs, Spotify, CodePen, StackBlitz)', (url) => {
                    const result = (editor.commands as any).setIframe({ src: url });
                    if (!result) alert('Embed blocked: Only YouTube, Vimeo, Google Docs/Drive, Spotify, CodePen, and StackBlitz URLs are allowed.');
                })}
                icon="fa-solid fa-window-maximize"
                title="Embed Iframe"
            />
            <ToolbarButton
                onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
                icon="fa-solid fa-table"
                title="Insert Table"
            />

            <Divider />

            <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} icon="fa-solid fa-minus" title="Horizontal Rule" />
            <ToolbarButton onClick={() => editor.chain().focus().undo().run()} icon="fa-solid fa-rotate-left" title="Undo" />
            <ToolbarButton onClick={() => editor.chain().focus().redo().run()} icon="fa-solid fa-rotate-right" title="Redo" />
        </>
    );

    // Contextual table toolbar — only renders when the caret is in a table.
    // Each button shows an icon + visible label so unfamiliar add/remove
    // column/row tools are self-explanatory.
    const showTableToolbar = editor.isActive('table');
    const tableToolbar = showTableToolbar && (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-t border-amber-500/20 bg-amber-500/4 min-w-0">
            <span className="shrink-0 text-[9px] font-black text-amber-400/80 uppercase tracking-widest mr-2 hidden sm:inline">
                <i className="fa-solid fa-table mr-1"></i>Table
            </span>
            <TableButton
                onClick={() => editor.chain().focus().addColumnBefore().run()}
                icon="fa-solid fa-arrow-left"
                label="+ Col Left"
                title="Insert a new column to the left of the current cell"
            />
            <TableButton
                onClick={() => editor.chain().focus().addColumnAfter().run()}
                icon="fa-solid fa-arrow-right"
                label="+ Col Right"
                title="Insert a new column to the right of the current cell"
            />
            <TableButton
                onClick={() => editor.chain().focus().deleteColumn().run()}
                icon="fa-solid fa-xmark"
                label="Del Col"
                title="Delete the column containing the current cell"
                danger
            />
            <Divider />
            <TableButton
                onClick={() => editor.chain().focus().addRowBefore().run()}
                icon="fa-solid fa-arrow-up"
                label="+ Row Above"
                title="Insert a new row above the current cell"
            />
            <TableButton
                onClick={() => editor.chain().focus().addRowAfter().run()}
                icon="fa-solid fa-arrow-down"
                label="+ Row Below"
                title="Insert a new row below the current cell"
            />
            <TableButton
                onClick={() => editor.chain().focus().deleteRow().run()}
                icon="fa-solid fa-xmark"
                label="Del Row"
                title="Delete the row containing the current cell"
                danger
            />
            <Divider />
            <TableButton
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                isActive={editor.isActive('tableHeader')}
                icon="fa-solid fa-heading"
                label="Header"
                title="Toggle the first row as a header (bold, separator)"
            />
            <TableButton
                onClick={() => editor.chain().focus().mergeCells().run()}
                icon="fa-solid fa-object-group"
                label="Merge"
                title="Merge the selected cells (drag across cells first to select them)"
            />
            <TableButton
                onClick={() => editor.chain().focus().splitCell().run()}
                icon="fa-solid fa-object-ungroup"
                label="Split"
                title="Split a previously-merged cell back into individual cells"
            />
            <Divider />
            <TableButton
                onClick={() => editor.chain().focus().deleteTable().run()}
                icon="fa-solid fa-trash"
                label="Delete Table"
                title="Remove the entire table"
                danger
            />
        </div>
    );

    return (
        <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-xs border border-slate-700/60 rounded-lg mb-2 min-w-0">
            <div className="flex flex-wrap items-center gap-0.5 p-1.5 min-w-0">
                {essentialGroup}

                <div className="md:hidden ml-auto relative" ref={overflowRef}>
                    <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setIsOverflowOpen((v) => !v)}
                        className={`shrink-0 w-8 h-8 flex items-center justify-center rounded text-xs transition-colors ${
                            isOverflowOpen
                                ? 'bg-slate-700 text-white'
                                : 'text-slate-300 hover:text-white hover:bg-slate-700'
                        }`}
                        title="More tools"
                    >
                        <i className="fa-solid fa-ellipsis" />
                    </button>
                    {isOverflowOpen && (
                        <div className="absolute right-0 top-full mt-1 z-20 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl p-1.5 flex flex-wrap gap-0.5 max-w-[280px]">
                            {secondaryGroups}
                        </div>
                    )}
                </div>

                <div className="hidden md:flex md:flex-wrap items-center gap-0.5 min-w-0">
                    {secondaryGroups}
                </div>
            </div>
            {tableToolbar}
        </div>
    );
};

export default WikiToolbar;
