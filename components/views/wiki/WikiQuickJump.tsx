import React, { useEffect, useMemo, useRef, useState } from 'react';
import { WikiPage } from '../../../types';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    pages: WikiPage[];
    onSelect: (page: WikiPage) => void;
}

const MAX_RESULTS = 12;

interface ScoredPage {
    page: WikiPage;
    score: number;
}

function scorePage(query: string, page: WikiPage): number {
    if (!query) return 1;
    const q = query.toLowerCase();
    const title = page.title.toLowerCase();
    const slug = (page.slug || '').toLowerCase();

    if (title === q) return 1000;
    if (title.startsWith(q)) return 500;

    const tokens = title.split(/\s+/);
    if (tokens.some((t) => t.startsWith(q))) return 300;

    if (title.includes(q)) return 150;
    if (slug.startsWith(q)) return 120;
    if (slug.includes(q)) return 80;
    return 0;
}

function pagePath(page: WikiPage, allPages: WikiPage[]): string {
    const byId = new Map(allPages.map((p) => [p.id, p]));
    const chain: string[] = [];
    let current: WikiPage | undefined = page;
    const seen = new Set<string>();
    while (current?.parentPageId && !seen.has(current.id)) {
        seen.add(current.id);
        const parent = byId.get(current.parentPageId);
        if (!parent) break;
        chain.unshift(parent.title);
        current = parent;
    }
    return chain.length > 0 ? chain.join(' › ') : 'Root';
}

const WikiQuickJump: React.FC<Props> = ({ isOpen, onClose, pages, onSelect }) => {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const results = useMemo(() => {
        if (!query) {
            return pages
                .slice()
                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                .slice(0, MAX_RESULTS)
                .map((p) => ({ page: p, score: 1 }));
        }
        const scored: ScoredPage[] = [];
        for (const p of pages) {
            const s = scorePage(query, p);
            if (s > 0) scored.push({ page: p, score: s });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS);
    }, [query, pages]);

    // Treat an out-of-range active index (e.g. after the result set shrinks as
    // the query changes) as the first row, derived during render instead of via
    // a clamping effect.
    const safeActiveIndex = activeIndex >= results.length ? 0 : activeIndex;

    // Reset the query/selection on the palette's closed→open transition. Done
    // during render via a prevIsOpen tracker (React re-renders before paint, so
    // it is behavior-equivalent to the old open-reset effect) rather than a
    // synchronous setState in an effect. The input focus is a genuine DOM side
    // effect and stays in the effect below.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    if (isOpen && !prevIsOpen) {
        setPrevIsOpen(true);
        setQuery('');
        setActiveIndex(0);
    } else if (!isOpen && prevIsOpen) {
        setPrevIsOpen(false);
    }

    useEffect(() => {
        if (isOpen) {
            // Focus the input when the palette opens (DOM side effect; the
            // query/selection reset happens in the render-time tracker above).
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [isOpen]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(Math.min(safeActiveIndex + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(Math.max(safeActiveIndex - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const target = results[safeActiveIndex];
            if (target) {
                onSelect(target.page);
                onClose();
            }
        }
    };

    useEffect(() => {
        if (!listRef.current) return;
        const item = listRef.current.querySelector<HTMLElement>(`[data-result-index="${safeActiveIndex}"]`);
        if (item) item.scrollIntoView({ block: 'nearest' });
    }, [safeActiveIndex]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4" role="dialog" aria-modal="true">
            <div
                onClick={onClose}
                className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs"
            />
            <div
                onKeyDown={handleKeyDown}
                className="relative w-full max-w-xl bg-slate-950/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col"
                style={{ maxHeight: '70vh' }}
            >
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
                    <i className="fa-solid fa-magnifying-glass text-slate-500 text-sm" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Jump to page…"
                        className="flex-1 bg-transparent outline-hidden text-sm text-white placeholder-slate-500"
                    />
                    <button
                        onClick={onClose}
                        className="text-[10px] text-slate-500 font-mono uppercase tracking-widest hover:text-slate-300 px-2 py-1 rounded-sm border border-slate-700"
                        title="Close"
                    >
                        Esc
                    </button>
                </div>

                <div ref={listRef} className="flex-1 overflow-y-auto custom-scrollbar p-2">
                    {results.length === 0 ? (
                        <div className="text-center py-10 text-slate-500 text-xs">
                            No matches for &ldquo;{query}&rdquo;
                        </div>
                    ) : (
                        results.map((r, idx) => {
                            const isActive = idx === safeActiveIndex;
                            return (
                                <button
                                    key={r.page.id}
                                    data-result-index={idx}
                                    onMouseEnter={() => setActiveIndex(idx)}
                                    onClick={() => { onSelect(r.page); onClose(); }}
                                    className={`w-full text-left px-3 py-2 rounded-lg flex flex-col gap-0.5 transition-colors ${
                                        isActive
                                            ? 'bg-sky-600/20 border border-sky-500/30 text-sky-200'
                                            : 'border border-transparent text-slate-300 hover:bg-slate-800/60'
                                    }`}
                                >
                                    <span className="text-sm font-medium truncate">{r.page.title}</span>
                                    <span className="text-[10px] text-slate-500 truncate">
                                        {pagePath(r.page, pages)}
                                    </span>
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="flex items-center justify-between px-4 py-2 border-t border-white/10 text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                    <span>↑ ↓ navigate · ↵ open</span>
                    <span>{results.length} {results.length === 1 ? 'page' : 'pages'}</span>
                </div>
            </div>
        </div>
    );
};

export default WikiQuickJump;
