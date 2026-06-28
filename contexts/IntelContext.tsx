// IntelContext owns the Intel slices (intelTargetIndex, intelHubStats,
// intelDataVersion, activeBulletins) and the bulletin/report CRUD methods.
//
// Mounts OUTSIDE DataProvider so DataContext can call useIntel() inside its
// body and re-expose the Intel fields on its own context value, keeping the
// useData() surface unchanged.
//
// - intelTargetIndex is a Map keyed by lowercase targetId; its slice setter
//   builds the Map from the data.intelTargetIndex array of { targetId, threatLevel }.
// - intelDataVersion is a client-side cache buster (no server-driven setter);
//   it bumps every time the 'intel' subset is fetched.
//
// refreshIntel is defined in DataContext (which owns fetchDataSubset) and
// registered here via registerRefreshIntel; the bulletin CRUD methods call it
// after their RPC completes.

import React, { createContext, useCallback, use, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    IntelBulletin, IntelHubStats, IntelThreatLevel,
} from '../types';

// Re-exports so domain consumers can import either from
// '../contexts/IntelContext' or '../types/intel' interchangeably.
export type {
    IntelBulletin,
    IntelHubStats,
    HydratedIntelligenceReport,
} from '../types';
export { IntelThreatLevel } from '../types';

export interface IntelContextValue {
    intelTargetIndex: Map<string, IntelThreatLevel>;
    intelHubStats: IntelHubStats;
    intelDataVersion: number;
    activeBulletins: IntelBulletin[];

    // Exposed for DataContext's fetchDataSubset('intel') branch, which writes
    // through these setters so the fetched payload lands in canonical state.
    setIntelTargetIndex: React.Dispatch<React.SetStateAction<Map<string, IntelThreatLevel>>>;
    setIntelHubStats: React.Dispatch<React.SetStateAction<IntelHubStats>>;
    setIntelDataVersion: React.Dispatch<React.SetStateAction<number>>;
    setActiveBulletins: React.Dispatch<React.SetStateAction<IntelBulletin[]>>;

    createBulletin: (data: any) => Promise<void>;
    deleteBulletin: (id: string) => Promise<void>;
    deleteIntelReport: (id: string) => Promise<void>;
    refreshIntel: () => Promise<void> | void;

    /** DataContext registers its refreshIntel callback here once defined; the
     *  bulletin CRUD methods invoke it after their RPC completes. */
    registerRefreshIntel: (fn: () => Promise<void> | void) => () => void;
}

const IntelContext = createContext<IntelContextValue | null>(null);

export const IntelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { rpcAction, registerSliceSetter } = useDataCore();

    const [intelTargetIndex, setIntelTargetIndex] = useState<Map<string, IntelThreatLevel>>(() => new Map());
    const [intelHubStats, setIntelHubStats] = useState<IntelHubStats>({ totalReports: 0, criticalCount: 0, recentCount7d: 0 });
    const [intelDataVersion, setIntelDataVersion] = useState<number>(0);
    const [activeBulletins, setActiveBulletins] = useState<IntelBulletin[]>([]);

    // DataContext registers refreshIntel here on mount; held in a ref so the
    // bulletin CRUD methods can call it without re-creating callbacks per render.
    const refreshIntelRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshIntel = useCallback((fn: () => Promise<void> | void) => {
        refreshIntelRef.current = fn;
        return () => {
            if (refreshIntelRef.current === fn) refreshIntelRef.current = null;
        };
    }, []);

    const refreshIntel = useCallback(async () => {
        const fn = refreshIntelRef.current;
        if (fn) await fn();
    }, []);

    // Each setter applies its slice when applyStateData(data) runs. intelTargetIndex
    // is converted from an array of { targetId, threatLevel } to a Map keyed by
    // lowercase targetId. intelDataVersion is not registered (client-side cache buster).
    useEffect(() => {
        const cleanups = [
            registerSliceSetter('intelTargetIndex', (data: any) => {
                if (data.intelTargetIndex) {
                    const m = new Map<string, IntelThreatLevel>();
                    for (const e of data.intelTargetIndex as { targetId: string; threatLevel: IntelThreatLevel }[]) {
                        m.set(e.targetId.toLowerCase(), e.threatLevel);
                    }
                    setIntelTargetIndex(m);
                }
            }),
            registerSliceSetter('intelHubStats', (data: any) => { if (data.intelHubStats) setIntelHubStats(data.intelHubStats); }),
            registerSliceSetter('activeBulletins', (data: any) => { if (data.activeBulletins) setActiveBulletins(data.activeBulletins); }),
        ];
        return () => cleanups.forEach(unreg => unreg());
    }, [registerSliceSetter]);

    const createBulletin = useCallback((data: any) =>
        rpcAction('intel:create_bulletin', data).then(() => { void refreshIntel(); }),
    [rpcAction, refreshIntel]);

    const deleteBulletin = useCallback((id: string) =>
        rpcAction('intel:delete_bulletin', { bulletinId: id }).then(() => { void refreshIntel(); }),
    [rpcAction, refreshIntel]);

    const deleteIntelReport = useCallback((id: string) =>
        rpcAction('intel:delete_report', { reportId: id }).then(() => { void refreshIntel(); }),
    [rpcAction, refreshIntel]);

    const value = useMemo<IntelContextValue>(() => ({
        intelTargetIndex, intelHubStats, intelDataVersion, activeBulletins,
        setIntelTargetIndex, setIntelHubStats, setIntelDataVersion, setActiveBulletins,
        createBulletin, deleteBulletin, deleteIntelReport, refreshIntel,
        registerRefreshIntel,
    }), [
        intelTargetIndex, intelHubStats, intelDataVersion, activeBulletins,
        createBulletin, deleteBulletin, deleteIntelReport, refreshIntel,
        registerRefreshIntel,
    ]);

    return <IntelContext value={value}>{children}</IntelContext>;
};

export const useIntel = (): IntelContextValue => {
    const ctx = use(IntelContext);
    if (!ctx) throw new Error('useIntel must be used within an IntelProvider');
    return ctx;
};
