import React, { useEffect, useRef } from 'react';
import { useData } from '../../contexts/DataContext';
import apiService from '../../services/apiService';
import BulkActionShell from '../shared/BulkActionShell';
import BulkProgressDisplay from '../shared/BulkProgressDisplay';
import { useBulkProgress } from '../../hooks/useBulkProgress';
import { User } from '../../types';
import { useNotification } from '../../contexts/NotificationContext';

interface Props {
    selectedUsers: User[];
    onClose: () => void;
}

/**
 * Promotes the pre-selected users to the org's Member role. Single-org:
 * there is no member cap, so every selected client is promoted.
 */
const BulkPromoteToMemberModal: React.FC<Props> = ({ selectedUsers, onClose }) => {
    const { refreshMainState } = useData();
    const { addToast } = useNotification();
    const bulk = useBulkProgress<number>();

    const targetIds = selectedUsers.map((u) => u.id);

    const onConfirm = () => {
        bulk.run(targetIds, async (chunk) => {
            const res = await apiService.rpc('admin:bulk_promote_users', { targetUserIds: chunk });
            return res?.data ?? res;
        });
    };

    // Latest values for the one-shot completion side-effect below. Updated every
    // render (in an effect, before the auto-close effect) so the auto-close can
    // read current props/state without listing them as triggers — it must fire
    // only on bulk.state transitions, not when aggregate/onClose/refresh change.
    const completionRef = useRef({ targetIds, aggregate: bulk.aggregate, addToast, refreshMainState, onClose });
    useEffect(() => {
        completionRef.current = { targetIds, aggregate: bulk.aggregate, addToast, refreshMainState, onClose };
    });

    useEffect(() => {
        if (bulk.state === 'done' || bulk.state === 'cancelled') {
            const { targetIds, aggregate, addToast, refreshMainState, onClose } = completionRef.current;
            const total = targetIds.length;
            const wasCancelled = bulk.state === 'cancelled';
            const parts: string[] = [`Promoted ${aggregate.updated}`];
            if (aggregate.skipped > 0) parts.push(`${aggregate.skipped} skipped`);
            const msg = wasCancelled
                ? `Cancelled — updated ${aggregate.updated} of ${total}`
                : parts.join(', ');
            addToast(
                msg,
                <i className="fa-solid fa-circle-check" />,
                'bg-green-500/10 text-green-400 border-green-500/50',
            );
            refreshMainState();
            const id = window.setTimeout(onClose, 1500);
            return () => window.clearTimeout(id);
        }
    }, [bulk.state]);

    const isRunning = bulk.state === 'running';
    const isFinished = bulk.state === 'done' || bulk.state === 'cancelled' || bulk.state === 'error';

    return (
        <BulkActionShell
            title="Promote to Member"
            subtitle="Selected Clients will gain Member-tier access"
            selectedUsers={selectedUsers}
            onClose={onClose}
            onConfirm={onConfirm}
            confirmLabel={`Promote ${targetIds.length}`}
            confirmDisabled={targetIds.length === 0}
            busy={isRunning}
            hideFooter={isRunning || isFinished}
        >
            {(isRunning || isFinished) && (
                <BulkProgressDisplay
                    state={bulk.state}
                    processed={bulk.processed}
                    total={bulk.total}
                    aggregate={bulk.aggregate}
                    onCancel={bulk.cancel}
                    error={bulk.error}
                />
            )}
        </BulkActionShell>
    );
};

export default BulkPromoteToMemberModal;
