import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useData } from '../../contexts/DataContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

// Generic minimum shape every result must satisfy. Concrete results may
// carry many more fields; the combobox only needs id/name/source.
export interface ComboboxItem {
    id: number;
    name: string;
    source?: string;
    [key: string]: any;
}

interface Props<T extends ComboboxItem> {
    /** RPC action name, e.g. 'qm:search_catalog' or 'warehouse:search_catalog'. */
    rpcName: string;
    /** Currently selected item, or null. */
    value: T | null;
    onChange: (item: T | null) => void;
    /** Default scope. 'both' searches custom + platform; 'custom' is org only. */
    initialScope?: 'custom' | 'platform' | 'both';
    /** When true, exposes an inline 'Include platform catalog' checkbox so
     *  the user can flip scope without leaving the combobox. */
    showScopeToggle?: boolean;
    placeholder?: string;
    /** Soft cap on results; server enforces a hard cap of 200. */
    limit?: number;
    /** Extra text shown right under the input (e.g. "Pick a commodity"). */
    helpText?: string;
    /** Optional custom row renderer. Defaults to name + source badge + category. */
    renderItem?: (item: T) => React.ReactNode;
    /** Disable the input entirely. */
    disabled?: boolean;
    /** Show a small clear (×) button when a value is selected. */
    allowClear?: boolean;
    /** Items to show in the dropdown when the query is empty. Useful for
     *  surfacing the org's existing custom catalog up-front so callers don't
     *  have to type to see what they already have. Suppressed when scope is
     *  'platform' (the toggled-to-platform-only mode is a deliberate search
     *  intent, not a browse intent). */
    defaultItems?: T[];
    /** Label shown above the default-items list in the dropdown. */
    defaultItemsLabel?: string;
}

const SOURCE_BADGE: Record<string, string> = {
    custom: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
    platform: 'bg-slate-700/40 text-slate-300 border-slate-500/30',
};

export default function CatalogSearchCombobox<T extends ComboboxItem>({
    rpcName,
    value,
    onChange,
    initialScope = 'both',
    showScopeToggle = false,
    placeholder = 'Search catalog…',
    limit = 50,
    helpText,
    renderItem,
    disabled = false,
    allowClear = true,
    defaultItems,
    defaultItemsLabel = 'Your org catalog',
}: Props<T>) {
    const { rpcAction } = useData();

    const [query, setQuery] = useState('');
    const [scope, setScope] = useState<'custom' | 'platform' | 'both'>(initialScope);
    const [open, setOpen] = useState(false);
    const [results, setResults] = useState<T[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [highlight, setHighlight] = useState(0);

    const debouncedQuery = useDebouncedValue(query.trim(), 300);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const requestSeqRef = useRef(0);

    // Click-outside to close.
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (!containerRef.current) return;
            if (!containerRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    // Drive the synchronous search-lifecycle state (results/error/loading) at
    // render time via the React "adjust state during render" pattern instead
    // of synchronously inside the search effect. The old effect, on every fire
    // (deps: open / debouncedQuery / scope), either cleared these when the
    // query was empty or set loading=true + error=null before kicking off the
    // async request. We reproduce that exactly by tracking the same trigger
    // values and reacting only when one of them changes — so the only work
    // left in the effect is the async fetch and its (already-unflagged) async
    // sets. Value guards keep each branch self-terminating (no render loop).
    const [prevOpen, setPrevOpen] = useState(open);
    const [prevDebouncedQuery, setPrevDebouncedQuery] = useState(debouncedQuery);
    const [prevScope, setPrevScope] = useState(scope);
    if (open !== prevOpen || debouncedQuery !== prevDebouncedQuery || scope !== prevScope) {
        setPrevOpen(open);
        setPrevDebouncedQuery(debouncedQuery);
        setPrevScope(scope);
        if (open) {
            if (!debouncedQuery) {
                // Query cleared: reset the lifecycle state (matches the old
                // effect's clear branch).
                if (results.length > 0) setResults([]);
                if (error !== null) setError(null);
                if (loading) setLoading(false);
            } else {
                // New/changed search: show loading and clear any prior error
                // (matches the old effect's synchronous setLoading(true) /
                // setError(null) before the async request).
                if (!loading) setLoading(true);
                if (error !== null) setError(null);
            }
        }
    }

    // Fire the search whenever the debounced query or scope changes. Only the
    // async request + its async result/error/loading sets live here now.
    useEffect(() => {
        if (!open || !debouncedQuery) return;
        const seq = ++requestSeqRef.current;
        rpcAction(rpcName, { query: debouncedQuery, source: scope, limit })
            .then((rows: any) => {
                if (seq !== requestSeqRef.current) return; // stale
                setResults(Array.isArray(rows) ? rows : []);
                setHighlight(0);
            })
            .catch((err: any) => {
                if (seq !== requestSeqRef.current) return;
                setError(err?.message || 'Search failed');
                setResults([]);
            })
            .finally(() => {
                if (seq === requestSeqRef.current) setLoading(false);
            });
    }, [debouncedQuery, scope, open, rpcAction, rpcName, limit]);

    const handleSelect = useCallback((item: T) => {
        onChange(item);
        setQuery(item.name);
        setOpen(false);
    }, [onChange]);

    // When the query is empty we surface the caller-provided defaultItems
    // (e.g. the org's custom catalog). Suppressed when the user has narrowed
    // scope to platform-only — that's a deliberate search intent, not browse.
    const showDefaults = !debouncedQuery && (defaultItems?.length ?? 0) > 0 && scope !== 'platform';
    const visibleItems: T[] = debouncedQuery ? results : (showDefaults ? (defaultItems as T[]) : []);

    const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!open) {
            if (e.key === 'ArrowDown') { setOpen(true); e.preventDefault(); }
            return;
        }
        if (e.key === 'ArrowDown') {
            setHighlight((h) => Math.min(visibleItems.length - 1, h + 1));
            e.preventDefault();
        } else if (e.key === 'ArrowUp') {
            setHighlight((h) => Math.max(0, h - 1));
            e.preventDefault();
        } else if (e.key === 'Enter') {
            const pick = visibleItems[highlight];
            if (pick) { handleSelect(pick); e.preventDefault(); }
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    const showClear = allowClear && (value || query);
    const displayValue = useMemo(() => {
        if (open) return query;
        return value?.name ?? query;
    }, [open, query, value]);

    const renderRow = (item: T, index: number) => {
        const active = index === highlight;
        const badgeClass = item.source ? SOURCE_BADGE[item.source] || 'bg-slate-800 text-slate-400 border-slate-700' : null;
        return (
            <button
                type="button"
                key={`${item.source || 'x'}-${item.id}`}
                onMouseDown={(e) => { e.preventDefault(); handleSelect(item); }}
                onMouseEnter={() => setHighlight(index)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 ${active ? 'bg-orange-500/10' : 'hover:bg-white/5'} transition-colors`}
            >
                <span className="text-sm text-white truncate flex-1">{item.name}</span>
                {item.category && (
                    <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest truncate max-w-[40%]">
                        {item.category}
                    </span>
                )}
                {badgeClass && (
                    <span className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-sm border ${badgeClass}`}>
                        {item.source}
                    </span>
                )}
            </button>
        );
    };

    return (
        <div ref={containerRef} className="relative">
            <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                    <input
                        ref={inputRef}
                        type="text"
                        value={displayValue}
                        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); if (value) onChange(null); }}
                        onFocus={() => setOpen(true)}
                        onKeyDown={handleKey}
                        placeholder={placeholder}
                        disabled={disabled}
                        className="w-full bg-slate-900 border border-white/10 rounded-lg pl-9 pr-9 py-2 text-sm text-white focus:outline-hidden focus:border-orange-500/40 disabled:opacity-40"
                    />
                    <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs" />
                    {showClear && (
                        <button
                            type="button"
                            onClick={() => { onChange(null); setQuery(''); setResults([]); inputRef.current?.focus(); }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs"
                            aria-label="Clear"
                        >
                            <i className="fa-solid fa-xmark" />
                        </button>
                    )}
                </div>
                {showScopeToggle && (
                    <label className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-slate-400 whitespace-nowrap cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={scope !== 'custom'}
                            onChange={(e) => setScope(e.target.checked ? 'both' : 'custom')}
                            className="accent-orange-500"
                        />
                        Platform
                    </label>
                )}
            </div>
            {helpText && <p className="text-[10px] text-slate-500 mt-1">{helpText}</p>}

            {open && (
                <div className="absolute z-50 mt-1 w-full bg-slate-900 border border-white/10 rounded-lg shadow-2xl max-h-80 overflow-y-auto">
                    {!debouncedQuery && showDefaults && (
                        <>
                            <div className="px-3 py-2 bg-black/30 text-[10px] font-mono uppercase tracking-widest text-slate-500 sticky top-0 border-b border-white/5">
                                {defaultItemsLabel} · {visibleItems.length}
                            </div>
                            <div className="divide-y divide-white/5">
                                {visibleItems.map((r, i) => (renderItem ? renderItem(r) : renderRow(r, i)))}
                            </div>
                        </>
                    )}
                    {!debouncedQuery && !showDefaults && (
                        <div className="px-3 py-3 text-xs text-slate-500 italic">Start typing to search…</div>
                    )}
                    {debouncedQuery && loading && (
                        <div className="px-3 py-3 text-xs text-slate-500 flex items-center gap-2">
                            <i className="fa-solid fa-spinner animate-spin" /> Searching…
                        </div>
                    )}
                    {debouncedQuery && !loading && error && (
                        <div className="px-3 py-3 text-xs text-rose-400">{error}</div>
                    )}
                    {debouncedQuery && !loading && !error && results.length === 0 && (
                        <div className="px-3 py-3 text-xs text-slate-500 italic">
                            No matches{showScopeToggle && scope === 'custom' ? ' — try expanding to the platform catalog.' : '.'}
                        </div>
                    )}
                    {debouncedQuery && results.length > 0 && (
                        <div className="divide-y divide-white/5">
                            {results.map((r, i) => (renderItem ? renderItem(r) : renderRow(r, i)))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
