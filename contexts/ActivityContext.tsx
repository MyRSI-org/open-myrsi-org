// Activity context — owns the user's idle/heartbeat lifecycle.
//
// Two intervals run on a 60s tick:
//   - HEARTBEAT: posts user:heartbeat to the server if the user has interacted
//     within the last 5 minutes AND it's been ≥4.5 minutes since the last
//     heartbeat. The server returns force_logout_timestamp; if it's newer
//     than this session started, we log out (platform-admin kill switch).
//   - IDLE: increments idleTime by 1 every minute; reset to 0 on any of
//     mousemove/keydown/click/touchstart.
//
// Must mount INSIDE SessionProvider: the heartbeat needs Session's `logout`
// for the force-logout path.

import React, { createContext, use, useEffect, useRef, useState } from 'react';
import apiService from '../services/apiService';
import { useSession } from './SessionContext';

export interface ActivityContextValue {
    /** Minutes since the user's last keyboard/mouse/touch input. Consumed by
     *  presence indicators (e.g. Sidebar's "you've been idle" hint) and the
     *  HID PTT context's auto-release. */
    idleTime: number;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

export const ActivityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser, sessionStartTime, logout } = useSession();
    const [idleTime, setIdleTime] = useState(0);

    // Seeded with the mount timestamp inside the idle effect below — avoids
    // calling the impure Date.now() during render.
    const lastHeartbeatRef = useRef<number>(0);
    const lastInteractionRef = useRef<number>(0);

    // Heartbeat loop — checks every minute whether a heartbeat is due.
    useEffect(() => {
        if (!currentUser) return;

        const heartbeatInterval = setInterval(() => {
            const now = Date.now();
            const timeSinceLastHeartbeat = now - lastHeartbeatRef.current;
            const timeSinceLastInteraction = now - lastInteractionRef.current;

            // Send heartbeat if:
            // 1. It's been at least 4.5 minutes since the last one (buffer for 5m limit)
            // 2. The user has interacted recently (within last 5 minutes)
            if (timeSinceLastHeartbeat > 4.5 * 60 * 1000 && timeSinceLastInteraction < 5 * 60 * 1000) {
                lastHeartbeatRef.current = now;
                apiService.rpc('user:heartbeat', { userId: currentUser.id }).then((result: any) => {
                    // Force-logout enforcement, compared against the session's
                    // start baseline. Mirrors SessionContext.refreshUser's page-load path.
                    if (result?.force_logout_timestamp && result.force_logout_timestamp > sessionStartTime.current) {
                        console.warn('[Auth] Force logout triggered by platform admin');
                        logout();
                    }
                }).catch(err => {
                    console.warn("Heartbeat failed", err);
                });
            }
        }, 60 * 1000);

        return () => clearInterval(heartbeatInterval);
    }, [currentUser, sessionStartTime, logout]);

    // Idle counter + interaction listeners.
    useEffect(() => {
        // Seed the heartbeat/interaction baselines at mount (replaces the
        // Date.now() ref initializers, which would run impurely during render).
        const mountedAt = Date.now();
        lastHeartbeatRef.current = mountedAt;
        lastInteractionRef.current = mountedAt;

        const timer = setInterval(() => setIdleTime(prev => prev + 1), 60000);

        const resetIdle = () => {
            setIdleTime(0);
            lastInteractionRef.current = Date.now();
        };

        window.addEventListener('mousemove', resetIdle);
        window.addEventListener('keydown', resetIdle);
        window.addEventListener('click', resetIdle);
        window.addEventListener('touchstart', resetIdle);
        return () => {
            clearInterval(timer);
            window.removeEventListener('mousemove', resetIdle);
            window.removeEventListener('keydown', resetIdle);
            window.removeEventListener('click', resetIdle);
            window.removeEventListener('touchstart', resetIdle);
        };
    }, []);

    const value: ActivityContextValue = { idleTime };

    return <ActivityContext value={value}>{children}</ActivityContext>;
};

export const useActivity = (): ActivityContextValue => {
    const ctx = use(ActivityContext);
    if (!ctx) throw new Error('useActivity must be used within an ActivityProvider');
    return ctx;
};
