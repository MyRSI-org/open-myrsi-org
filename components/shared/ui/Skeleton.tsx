import React from 'react';

/**
 * Stable, module-scope pool of unique keys for fixed-length placeholder lists.
 * Skeleton items carry no data identity and are never reordered or filtered, so
 * each render slot is purely positional. We map slot N to a stable non-index key
 * (minted once, cached, grown on demand) so reconciliation matches the previous
 * positional behaviour without using the array index as the key.
 */
const skeletonKeyPool: string[] = [];
const skeletonKeyAt = (slot: number): string => {
    while (skeletonKeyPool.length <= slot) {
        skeletonKeyPool.push(`sk-slot-${skeletonKeyPool.length}`);
    }
    return skeletonKeyPool[slot];
};

/**
 * Pulsing placeholder block for loading states. Default colour matches the
 * dark slate palette used across QM/Warehouse views.
 */
export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
    return (
        <div
            className={`animate-pulse bg-slate-800/60 rounded-sm ${className}`}
            style={style}
            aria-hidden
        />
    );
}

/**
 * A grid of skeleton "card" placeholders mimicking the QmArmoryTab inventory
 * card layout while data loads.
 */
export function SkeletonCardGrid({ count = 6, accent = 'orange' }: { count?: number; accent?: 'orange' | 'cyan' | 'slate' }) {
    const border = accent === 'orange' ? 'border-orange-500/10' : accent === 'cyan' ? 'border-cyan-500/10' : 'border-white/5';
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true" aria-live="polite">
            {Array.from({ length: count }).map((_, i) => (
                <div key={skeletonKeyAt(i)} className={`rounded-lg border ${border} bg-slate-900/40 overflow-hidden flex animate-pulse`}>
                    <div className="w-1 shrink-0 bg-slate-700/40" />
                    <div className="flex-1 p-4 flex flex-col min-w-0 space-y-2">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                        <div className="flex-1" />
                        <Skeleton className="h-7 w-20 mt-2" />
                    </div>
                </div>
            ))}
        </div>
    );
}

/**
 * Skeleton row strip for table-style lists.
 */
export function SkeletonTableRows({ count = 5, columns = 6 }: { count?: number; columns?: number }) {
    return (
        <div className="space-y-1.5" aria-busy="true" aria-live="polite">
            {Array.from({ length: count }).map((_, i) => (
                <div key={skeletonKeyAt(i)} className="flex gap-3 py-2 px-3 border-b border-white/5">
                    {Array.from({ length: columns }).map((__, j) => (
                        <Skeleton
                            key={skeletonKeyAt(j)}
                            className="h-4"
                            style={{ flex: j === 0 ? 2 : 1 }}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}
