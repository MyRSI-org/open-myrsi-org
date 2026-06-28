import { useCallback, useEffect, useRef, useState } from 'react';

interface Params {
    itemCount: number;
    onActivate: (index: number) => void;
    /** The element on which to attach the keydown listener. */
    listenerRef: React.RefObject<HTMLElement | null>;
    /** The scroll container for `scrollToIndex`. */
    scrollContainerRef: React.RefObject<HTMLElement | null>;
    /** Fixed row height matching VirtualizedList contract. */
    rowHeight: number;
}

export interface KeyboardNavApi {
    selectedIndex: number;
    setSelectedIndex: (i: number) => void;
    clear: () => void;
}

export const useSearchKeyboardNav = ({
    itemCount,
    onActivate,
    listenerRef,
    scrollContainerRef,
    rowHeight,
}: Params): KeyboardNavApi => {
    const [rawSelectedIndex, setSelectedIndexState] = useState(-1);
    const itemCountRef = useRef(itemCount);

    // Keep the latest itemCount available to the keydown handler without
    // re-subscribing the listener. Updated in an effect (not during render).
    useEffect(() => {
        itemCountRef.current = itemCount;
    }, [itemCount]);

    // Treat an out-of-range selection (e.g. after results shrink) as "none"
    // by deriving the exposed index during render instead of in an effect.
    const selectedIndex = rawSelectedIndex >= itemCount ? -1 : rawSelectedIndex;

    const scrollIntoView = useCallback((idx: number) => {
        const sc = scrollContainerRef.current;
        if (!sc) return;
        const rowTop = idx * rowHeight;
        const rowBottom = rowTop + rowHeight;
        const viewTop = sc.scrollTop;
        const viewBottom = viewTop + sc.clientHeight;
        if (rowTop < viewTop) {
            sc.scrollTo({ top: rowTop, behavior: 'smooth' });
        } else if (rowBottom > viewBottom) {
            sc.scrollTo({ top: rowBottom - sc.clientHeight, behavior: 'smooth' });
        }
    }, [scrollContainerRef, rowHeight]);

    const setSelectedIndex = useCallback((i: number) => {
        setSelectedIndexState(i);
        if (i >= 0) scrollIntoView(i);
    }, [scrollIntoView]);

    const clear = useCallback(() => setSelectedIndexState(-1), []);

    useEffect(() => {
        const el = listenerRef.current;
        if (!el) return;
        const handler = (e: KeyboardEvent) => {
            const total = itemCountRef.current;
            if (total === 0) return;
            // Don't hijack typing in inputs even if they bubble.
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
                return;
            }
            // Out-of-range selections are exposed as "none" during render, so
            // normalize the stored value the same way here before navigating.
            const normalize = (prev: number) => (prev >= total ? -1 : prev);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndexState(raw => {
                    const prev = normalize(raw);
                    const next = prev < 0 ? 0 : Math.min(total - 1, prev + 1);
                    scrollIntoView(next);
                    return next;
                });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndexState(raw => {
                    const prev = normalize(raw);
                    const next = prev <= 0 ? 0 : prev - 1;
                    scrollIntoView(next);
                    return next;
                });
            } else if (e.key === 'Enter') {
                setSelectedIndexState(raw => {
                    const prev = normalize(raw);
                    if (prev >= 0 && prev < itemCountRef.current) {
                        e.preventDefault();
                        onActivate(prev);
                    }
                    return prev;
                });
            } else if (e.key === 'Escape') {
                setSelectedIndexState(raw => {
                    const prev = normalize(raw);
                    if (prev >= 0) {
                        e.preventDefault();
                        return -1;
                    }
                    return prev;
                });
            }
        };
        el.addEventListener('keydown', handler);
        return () => el.removeEventListener('keydown', handler);
    }, [listenerRef, onActivate, scrollIntoView]);

    return { selectedIndex, setSelectedIndex, clear };
};
