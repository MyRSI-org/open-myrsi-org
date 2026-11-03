// Push-notification context — owns the browser-side push subscription
// lifecycle (permission prompt, VAPID key fetch, ServiceWorker register/
// subscribe). Exposed on the useAuth() shim as isPushActive, subscribeToPush,
// checkPushSubscription. Consumers: DashboardApp.tsx (PushNotificationBanner)
// and components/views/personnel/ProfileView.tsx (diagnostics card).

import React, { createContext, use, useCallback, useEffect, useRef, useState } from 'react';
import apiService from '../services/apiService';
import { urlBase64ToUint8Array } from '../utils/pushUtils';
import { getCurrentPushSubscription } from '../utils/sessionLogout';
import { useSession } from './SessionContext';

export interface PushNotificationContextValue {
    /** True iff the browser currently has an active push subscription. Polled
     *  once at mount via checkPushSubscription, then set true on a successful
     *  subscribeToPush. NOT updated if the user revokes the permission via
     *  browser settings — callers can re-run checkPushSubscription on demand. */
    isPushActive: boolean;
    /** Prompts for notification permission, registers the ServiceWorker if
     *  needed, fetches the org's VAPID public key, subscribes the browser,
     *  and persists the subscription server-side via user:subscribe_push.
     *  Re-throws on failure so the UI can surface "permission denied" /
     *  "VAPID missing" toasts. */
    subscribeToPush: () => Promise<void>;
    /** Reads the current ServiceWorker subscription (without prompting) and
     *  syncs isPushActive. Returns the active flag for one-shot callers
     *  (ProfileView's diagnostics). */
    checkPushSubscription: () => Promise<boolean>;
}

const PushNotificationContext = createContext<PushNotificationContextValue | null>(null);

export const PushNotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Mounted inside SessionProvider (contexts/AuthContext.tsx), so the session is readable here.
    const { currentUser } = useSession();
    const [isPushActive, setIsPushActive] = useState(false);

    const checkPushSubscription = useCallback(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        const active = !!sub;
        setIsPushActive(active);
        return active;
    }, []);

    const subscribeToPush = useCallback(async () => {
        if (!('serviceWorker' in navigator)) return;
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') throw new Error("Notification permission denied");

            // 5s timeout guard: Safari occasionally hangs on .ready when the
            // SW is in an "installing/redundant" state. A real failure is
            // better UX than an infinite spinner.
            const reg = await Promise.race([
                navigator.serviceWorker.ready,
                new Promise((_, reject) => setTimeout(() => reject(new Error("Service Worker timeout")), 5000))
            ]) as ServiceWorkerRegistration;

            const response = await apiService.rpc('system:get_push_config', {});
            const publicKey = response?.data?.publicKey;
            if (!publicKey) throw new Error("VAPID Public Key could not be retrieved");

            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
            await apiService.rpc('user:subscribe_push', sub);
            setIsPushActive(true);
        } catch (e: any) {
            console.error("Push subscription failed", e);
            throw e; // Re-throw so UI can handle it
        }
    }, []);

    // Initial check on mount. checkPushSubscription only calls setIsPushActive
    // after awaiting the ServiceWorker subscription read, so awaiting it here
    // keeps that state update off the synchronous effect path.
    useEffect(() => {
        void (async () => {
            await checkPushSubscription();
        })();
    }, [checkPushSubscription]);

    // RE-BIND an inherited subscription to whoever is signed in now. Logout drops the
    // subscription, but a session can also end without a logout — expiry, a force-logout,
    // a revocation — and the browser keeps its subscription through all of them. Its row
    // still names the previous member, so the next person on a shared browser received
    // that member's directives and notifications, and never saw the banner because the
    // browser already held a subscription. savePushSubscription deletes the old row for
    // the endpoint before inserting, so this moves it to the current user. Once per user
    // id per page load; a failure only means the row stays where it was.
    const reboundForRef = useRef<number | null>(null);
    useEffect(() => {
        const userId = currentUser?.id;
        if (!userId || reboundForRef.current === userId) return;
        reboundForRef.current = userId;
        void (async () => {
            const sub = await getCurrentPushSubscription();
            if (!sub) return;
            try {
                await apiService.rpc('user:subscribe_push', sub.toJSON());
            } catch (e) {
                console.warn('[Push] Re-binding the existing subscription failed', e);
            }
        })();
    }, [currentUser?.id]);

    const value: PushNotificationContextValue = {
        isPushActive,
        subscribeToPush,
        checkPushSubscription,
    };

    return <PushNotificationContext value={value}>{children}</PushNotificationContext>;
};

export const usePushNotification = (): PushNotificationContextValue => {
    const ctx = use(PushNotificationContext);
    if (!ctx) throw new Error('usePushNotification must be used within a PushNotificationProvider');
    return ctx;
};
