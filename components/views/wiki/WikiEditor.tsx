import React, { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Youtube from '@tiptap/extension-youtube';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { IframeExtension } from './extensions/IframeExtension';
import WikiToolbar from './WikiToolbar';
import apiService from '../../../services/apiService';

interface WikiEditorProps {
    content: any;
    editable: boolean;
    onSave?: (json: any) => Promise<void> | void;
    onCancel?: () => void;
    onChange?: (json: any) => void;
    // When set, the toolbar offers an image upload for this feature (alongside insert-by-URL).
    // Private features (wiki/government) get a short-lived signed URL to display; the stored
    // object key is normalised on save.
    uploadFeature?: string;
}

const WikiEditor: React.FC<WikiEditorProps> = ({ content, editable, onSave, onCancel, onChange, uploadFeature }) => {
    const [isSaving, setIsSaving] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const handleImageUpload = () => fileInputRef.current?.click();
    const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        if (!file || !editor || !uploadFeature) return;
        try {
            const res = await apiService.uploadOrgMedia(file, uploadFeature);
            // The upload OUTLIVES the editor if the author cancels or navigates while it is
            // in flight; inserting into a destroyed instance throws out of an async handler,
            // where nothing catches it. This is the only genuinely async editor touch in the
            // file, and the sibling MinimalRichEditor does not have it either.
            if (res.url && !editor.isDestroyed) editor.chain().focus().setImage({ src: res.url }).run();
        } catch (err) {
            alert(`Image upload failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
    };

    const handleSave = async () => {
        if (!editor || !onSave || isSaving) return;
        setIsSaving(true);
        try {
            await onSave(editor.getJSON());
        } finally {
            setIsSaving(false);
        }
    };

    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                heading: { levels: [1, 2, 3] },
                link: false,
                underline: false,
            }),
            Placeholder.configure({
                placeholder: 'Start writing...',
            }),
            Image.configure({ inline: false }),
            Link.configure({
                openOnClick: !editable,
                HTMLAttributes: { class: 'wiki-link' },
            }),
            Underline,
            TextAlign.configure({
                types: ['heading', 'paragraph'],
            }),
            Youtube.configure({
                inline: false,
                nocookie: true,
            }),
            Table.configure({ resizable: true }),
            TableRow,
            TableCell,
            TableHeader,
            IframeExtension,
        ],
        content: content && Object.keys(content).length > 0 ? content : undefined,
        editable,
        onUpdate: onChange ? ({ editor: e }) => { if (!e.isDestroyed) onChange(e.getJSON()); } : undefined,
        editorProps: {
            attributes: {
                class: 'wiki-editor-content prose prose-invert prose-slate prose-base md:prose-lg max-w-none focus:outline-hidden min-h-[60vh] md:min-h-[400px] p-4',
            },
        },
    });

    // Tiptap v3 can destroy and recreate the editor instance across React renders, so an
    // effect closure can hold a reference to an instance that is already gone. getJSON() /
    // setContent() on one dereferences a null schema and throws — and renderActiveView is
    // wrapped in an ErrorBoundary, so the whole dashboard content area is replaced by the
    // error fallback and the in-progress document is lost. The sibling MinimalRichEditor
    // already carries these guards; this mirrors it rather than inventing a variant.
    useEffect(() => {
        if (editor && !editor.isDestroyed) editor.setEditable(editable);
    }, [editor, editable]);

    useEffect(() => {
        if (!editor || editor.isDestroyed || !content || Object.keys(content).length === 0) return;
        // isDestroyed alone is NOT sufficient: the command/state managers can be momentarily
        // unset on a still-live instance while Tiptap recreates it under React, and reading
        // editor.commands then throws. The initial content is already applied via useEditor's
        // `content` option, so skipping a transient sync is harmless. Do not remove the catch.
        try {
            // Only update if content actually differs, to prevent a cursor reset.
            if (JSON.stringify(editor.getJSON()) !== JSON.stringify(content)) {
                editor.commands.setContent(content);
            }
        } catch { /* editor not ready yet — initial content stands */ }
    }, [content, editor]);

    if (!editor) return null;

    return (
        <div className="wiki-editor">
            {uploadFeature && (
                <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" className="hidden" onChange={onFilePicked} />
            )}
            {editable && <WikiToolbar editor={editor} onImageUpload={uploadFeature ? handleImageUpload : undefined} />}
            <div className={`rounded-lg border ${editable ? 'border-sky-500/30 bg-slate-900/50' : 'border-transparent bg-transparent'}`}>
                <EditorContent editor={editor} />
            </div>
            {editable && onSave && (
                <div className="sticky bottom-0 z-10 mt-4 -mx-4 md:mx-0 px-4 md:px-0 py-3 bg-slate-950/95 backdrop-blur-xs border-t border-slate-700/60 md:border-t-0 md:bg-transparent md:backdrop-blur-none flex justify-end gap-3">
                    {onCancel && (
                        <button
                            onClick={onCancel}
                            disabled={isSaving}
                            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                        >
                            Cancel
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="px-4 py-2 text-sm font-bold text-white bg-sky-600 hover:bg-sky-500 rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none"
                    >
                        <i className={`fa-solid ${isSaving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'} mr-2`}></i>{isSaving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            )}
        </div>
    );
};

export default WikiEditor;
