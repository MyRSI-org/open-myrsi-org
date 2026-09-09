import React, { useEffect } from 'react';
import { useNotification } from '../../contexts/NotificationContext';
import { onBuildUpdate } from '../../lib/buildUpdate';
import { hardReload } from '../../lib/hardReload';

/**
 * Offers a reload when the server starts serving a client bundle newer than the one this tab is
 * running.
 *
 * Before this, a redeploy reached the user as a red "System Critical" screen: their open tab
 * asked for a chunk whose hashed filename no longer existed, and the failure surfaced as a
 * crash rather than as "there is a new version". This turns that into a non-blocking prompt
 * BEFORE they navigate into a missing chunk.
 *
 * Deliberately NOT a forced reload. A forced reload discards whatever the user is typing —
 * a half-written operation briefing, an intel report — for a cosmetic version difference. They
 * choose when.
 *
 * Persistent, so it survives the toast stack's eviction of older entries; and it fires at most
 * once per tab, because noteBuildId latches.
 */
const BuildUpdateWatcher: React.FC = () => {
    const { addToast } = useNotification();

    useEffect(() => onBuildUpdate(() => {
        addToast(
            'A new version is available',
            <i className="fa-solid fa-arrows-rotate" />,
            'bg-sky-500/10 text-sky-400 border-sky-500/50',
            {
                description: 'Reload when you are ready — anything you are part-way through will be lost.',
                variant: 'info',
                persistent: true,
                silent: true,
                action: { label: 'Reload now', onClick: () => { void hardReload(); } },
            },
        );
    }), [addToast]);

    return null;
};

export default BuildUpdateWatcher;
