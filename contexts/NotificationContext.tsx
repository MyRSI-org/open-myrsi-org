import React, { createContext, useState, useCallback, use, useEffect } from 'react';
import { ToastVariant } from '../types';
import { playCachedSound } from '../lib/audioCache';

interface ToastOptions {
    description?: string;
    requestId?: string;
    variant?: ToastVariant;
    persistent?: boolean;
    durationMs?: number;
    /** Suppress the variant chime — set when a paired branding sound is already played at the call site. */
    silent?: boolean;
}

const VARIANT_CHIME_URL: Partial<Record<ToastVariant, string>> = {
    success: '/media/success-chime.mp3',
    error: '/media/error-chime.mp3',
    warning: '/media/error-chime.mp3',
};

const DIALOG_ACTION_CHIME_URL = '/media/dialog-action-chime.mp3';

export interface Toast {
    id: string;
    message: string;
    icon: React.ReactNode | null;
    className: string;
    description?: string;
    requestId?: string;
    variant: ToastVariant;
    durationMs: number;
    persistent: boolean;
    createdAt: number;
}

/**
 * Default auto-dismiss duration per variant. Success disposes faster;
 * errors stay longer so users have time to read.
 */
const VARIANT_DURATION_MS: Record<ToastVariant, number> = {
    success: 5000,
    info: 7000,
    warning: 10000,
    error: 12000,
    neutral: 7000,
};

const TOAST_STACK_CAP = 5;

/**
 * Best-effort variant detection from the legacy `className` argument.
 * Existing call sites pass strings like `bg-emerald-500/10 text-emerald-400 border-emerald-500/50`
 * — we map the colour-family token to the matching variant so callers
 * don't have to migrate. Returns 'info' for anything we don't recognise.
 */
export function resolveVariantFromClassName(className: string): ToastVariant {
    const c = className.toLowerCase();
    if (c.includes('emerald') || c.includes('-green-')) return 'success';
    if (c.includes('-red-') || c.includes('rose')) return 'error';
    if (c.includes('amber') || c.includes('orange') || c.includes('yellow')) return 'warning';
    if (c.includes('-sky-') || c.includes('cyan') || c.includes('-blue-') || c.includes('indigo') || c.includes('purple')) return 'info';
    if (c.includes('slate') || c.includes('gray') || c.includes('grey')) return 'neutral';
    return 'info';
}

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'info' | 'warning';
}

export interface ConfirmState {
    isOpen: boolean;
    options: ConfirmOptions;
    resolve: ((value: boolean) => void) | null;
}

export interface NotificationContextType {
    toasts: Toast[];
    addToast: (message: string, icon: React.ReactNode | null, className: string, options?: ToastOptions) => void;
    removeToast: (id: string) => void;

    volume: number;
    setVolume: (volume: number) => void;

    playSound: (url: string | undefined) => void;

    // Confirm Dialog
    confirm: (options: ConfirmOptions) => Promise<boolean>;
    confirmState: ConfirmState;
    closeConfirm: () => void;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [volume, setVolume] = useState(() => {
        const storedVolume = localStorage.getItem('myrsi_volume');
        return storedVolume ? parseInt(storedVolume, 10) : 50;
    });
    const [toasts, setToasts] = useState<Toast[]>([]);

    useEffect(() => {
        localStorage.setItem('myrsi_volume', volume.toString());
    }, [volume]);

    // Delegates to lib/audioCache, which keeps a warmed HTMLAudioElement per
    // URL so first-play latency doesn't desync the chime from the on-screen
    // action. The bundled chimes are prefetched at module load; dynamic
    // (org-configured) URLs are prefetched in DataContext when the discord
    // config bundle arrives.
    const playSound = useCallback((url: string | undefined) => {
        playCachedSound(url, volume);
    }, [volume]);

    const removeToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const addToast = useCallback((message: string, icon: React.ReactNode | null, className: string, options?: ToastOptions) => {
        const id = Math.random().toString(36).substring(2, 9);
        const variant: ToastVariant = options?.variant ?? resolveVariantFromClassName(className);
        const persistent = options?.persistent === true;
        const durationMs = options?.durationMs ?? VARIANT_DURATION_MS[variant];

        if (!options?.silent) {
            const chime = VARIANT_CHIME_URL[variant];
            if (chime) playSound(chime);
        }

        setToasts(prev => {
            // Stack-eviction: if we'd exceed the cap, drop the oldest non-persistent toast first.
            let next = prev;
            if (next.length >= TOAST_STACK_CAP) {
                const oldestEvictableIdx = next.findIndex(t => !t.persistent);
                if (oldestEvictableIdx !== -1) {
                    next = [...next.slice(0, oldestEvictableIdx), ...next.slice(oldestEvictableIdx + 1)];
                }
                // If everything is persistent, we let the stack overflow rather than drop a critical message.
            }
            return [...next, {
                id,
                message,
                icon: icon ?? null,
                className,
                description: options?.description,
                requestId: options?.requestId,
                variant,
                durationMs,
                persistent,
                createdAt: Date.now(),
            }];
        });

        if (!persistent) {
            setTimeout(() => removeToast(id), durationMs);
        }
    }, [playSound, removeToast]);

    const [confirmState, setConfirmState] = useState<ConfirmState>({
        isOpen: false,
        options: { title: '', message: '' },
        resolve: null
    });

    const confirm = useCallback((options: ConfirmOptions) => {
        playSound(DIALOG_ACTION_CHIME_URL);
        return new Promise<boolean>((resolve) => {
            setConfirmState(prev => {
                if (prev.isOpen && prev.resolve) {
                    prev.resolve(false); // Cancel previous if overridden
                }
                return {
                    isOpen: true,
                    options,
                    resolve
                };
            });
        });
    }, [playSound]);

    const closeConfirm = useCallback(() => {
        setConfirmState(prev => ({ ...prev, isOpen: false }));
    }, []);

    const value: NotificationContextType = {
        toasts,
        addToast,
        removeToast,
        volume,
        setVolume,
        playSound,
        confirm,
        confirmState,
        closeConfirm,
    };

    return <NotificationContext value={value}>{children}</NotificationContext>;
};

export const useNotification = () => {
    const context = use(NotificationContext);
    if (!context) {
        throw new Error('useNotification must be used within a NotificationProvider');
    }
    return context;
};
