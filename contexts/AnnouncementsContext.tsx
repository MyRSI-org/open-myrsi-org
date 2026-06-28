// AnnouncementsContext owns the announcements slice plus the three
// announcement-CRUD methods (add/update/delete).
//
// Mounts OUTSIDE DataProvider so DataContext can call useAnnouncements() in
// its body and re-expose `announcements` on the useData() value, preserving
// the public API for read-consumers (NoticesManagementTab, login-screen filter).
//
// Hydration: registers a slice setter on 'announcements' with DataCore, so it
// populates on initial state, any 'main'/'announcements' subset response, and
// realtime resync. DataContext registers its refresh callback here at mount;
// CRUD methods call it after their RPC completes.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import { Announcement } from '../types';

export type { Announcement } from '../types';

export interface AnnouncementsContextValue {
    announcements: Announcement[];

    // Exposed for DataContext's optimisticUpdate('announcements') branch and
    // slice population; DataContext consumes it via useAnnouncements().
    setAnnouncements: React.Dispatch<React.SetStateAction<Announcement[]>>;

    addAnnouncement: (data: any) => Promise<void>;
    updateAnnouncement: (data: any) => Promise<void>;
    deleteAnnouncement: (id: string) => Promise<void>;

    /** DataContext registers its refreshAnnouncements callback here at mount. */
    registerRefreshAnnouncements: (fn: () => Promise<void> | void) => () => void;
}

const AnnouncementsContext = createContext<AnnouncementsContextValue | null>(null);

export const AnnouncementsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { rpcAction, registerSliceSetter } = useDataCore();

    const [announcements, setAnnouncements] = useState<Announcement[]>([]);

    const refreshAnnouncementsRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshAnnouncements = useCallback((fn: () => Promise<void> | void) => {
        refreshAnnouncementsRef.current = fn;
        return () => { if (refreshAnnouncementsRef.current === fn) refreshAnnouncementsRef.current = null; };
    }, []);

    const refreshAnnouncementsFn = useCallback(async () => {
        const fn = refreshAnnouncementsRef.current;
        if (fn) await fn();
    }, []);

    useEffect(() => {
        const unreg = registerSliceSetter('announcements', (data: any) => {
            if (data.announcements) setAnnouncements(data.announcements);
        });
        return unreg;
    }, [registerSliceSetter]);

    const addAnnouncement = useCallback((data: any) =>
        rpcAction('admin:add_announcement', { noticeData: data }).then(() => refreshAnnouncementsFn()),
    [rpcAction, refreshAnnouncementsFn]);

    const updateAnnouncement = useCallback((data: any) =>
        rpcAction('admin:update_announcement', { noticeData: data }).then(() => refreshAnnouncementsFn()),
    [rpcAction, refreshAnnouncementsFn]);

    const deleteAnnouncement = useCallback((id: string) => {
        setAnnouncements(prev => prev.filter(a => a.id !== id));
        return rpcAction('admin:delete_announcement', { noticeId: id }).then(() => refreshAnnouncementsFn());
    }, [rpcAction, refreshAnnouncementsFn]);

    const value = useMemo<AnnouncementsContextValue>(() => ({
        announcements, setAnnouncements,
        addAnnouncement, updateAnnouncement, deleteAnnouncement,
        registerRefreshAnnouncements,
    }), [
        announcements,
        addAnnouncement, updateAnnouncement, deleteAnnouncement,
        registerRefreshAnnouncements,
    ]);

    return <AnnouncementsContext value={value}>{children}</AnnouncementsContext>;
};

export const useAnnouncements = (): AnnouncementsContextValue => {
    const ctx = use(AnnouncementsContext);
    if (!ctx) throw new Error('useAnnouncements must be used within an AnnouncementsProvider');
    return ctx;
};
