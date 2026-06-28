import { useEffect, useRef } from 'react';
import { useData } from '../contexts/DataContext';
import type { BulkResult, BulkState } from './useBulkProgress';
import { useNotification } from '../contexts/NotificationContext';

interface Options {
    state: BulkState;
    aggregate: BulkResult;
    total: number;
    /** Called once when state becomes 'done' or 'cancelled'. */
    onClose: () => void;
    /** Default: "Updated N (M skipped)". Override for action-specific copy ("Promoted N", "Granted N", etc). */
    successVerb?: string;
}

/**
 * Shared completion handler for bulk-action modals. On `state === 'done'`
 * or `'cancelled'`, fires a summary toast, refreshes the main data subset,
 * and auto-closes the modal after 1.5 seconds. Errors are left to the
 * modal to display inline (we don't auto-close on error).
 *
 * Each bulk modal mounts useBulkProgress + this hook + BulkProgressDisplay.
 * Net: ~4 lines per modal of completion plumbing instead of ~20 duplicated.
 */
export function useBulkActionFlow({ state, aggregate, total, onClose, successVerb = 'Updated' }: Options): void {
    const { refreshMainState } = useData();
    const { addToast } = useNotification();

    const latestRef = useRef({ aggregate, total, successVerb, onClose, addToast, refreshMainState });
    useEffect(() => {
        latestRef.current = { aggregate, total, successVerb, onClose, addToast, refreshMainState };
    });

    useEffect(() => {
        if (state !== 'done' && state !== 'cancelled') return;
        const { aggregate, total, successVerb, onClose, addToast, refreshMainState } = latestRef.current;
        const wasCancelled = state === 'cancelled';
        const parts: string[] = [`${successVerb} ${aggregate.updated}`];
        if (aggregate.skipped > 0) parts.push(`${aggregate.skipped} skipped`);
        const msg = wasCancelled
            ? `Cancelled — ${successVerb.toLowerCase()} ${aggregate.updated} of ${total}`
            : parts.join(', ');
        addToast(
            msg,
            <i className={`fa-solid ${wasCancelled ? 'fa-circle-stop' : 'fa-circle-check'}`} />,
            wasCancelled
                ? 'bg-amber-500/10 text-amber-300 border-amber-500/50'
                : 'bg-green-500/10 text-green-400 border-green-500/50',
        );
        refreshMainState();
        const id = window.setTimeout(onClose, 1500);
        return () => window.clearTimeout(id);
    }, [state]);
}
