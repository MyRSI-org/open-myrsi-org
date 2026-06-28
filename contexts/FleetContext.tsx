// FleetContext owns the fleet slices (shipCatalog, userShips, fleetGroups).
//
// Mounts OUTSIDE DataProvider so DataContext can call useFleet() inside its
// body and re-expose the fleet fields on its own context value, keeping the
// useData() surface unchanged.
//
// There are no local fleet CRUD methods; fleet views call apiService directly
// and slices update via realtime broadcast + fetchDataSubset('fleet').
// refreshFleet is defined in DataContext and registered here via
// registerRefreshFleet so future fleet-owned CRUD can chain post-RPC refreshes
// without depending on useData() (which would create a context cycle).
//
// Hydration: registers three slice setters with DataCore, one per top-level
// field. Unlike HR (which nests under data.hr.*), the fleet payload puts these
// at the top level, so each setter keys off its own data-payload field.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    PlatformShip, UserShip, FleetGroup,
} from '../types';

// Re-exports so domain consumers can import either from
// '../contexts/FleetContext' or '../types/fleet' interchangeably.
export type {
    PlatformShip,
    UserShip,
    FleetGroup,
} from '../types';

export interface FleetContextValue {
    shipCatalog: PlatformShip[];
    userShips: UserShip[];
    fleetGroups: FleetGroup[];

    // Exposed so DataContext / future fleet CRUD can write through to canonical
    // state without going through the slice-setter registry.
    setShipCatalog: React.Dispatch<React.SetStateAction<PlatformShip[]>>;
    setUserShips: React.Dispatch<React.SetStateAction<UserShip[]>>;
    setFleetGroups: React.Dispatch<React.SetStateAction<FleetGroup[]>>;

    refreshFleet: () => Promise<void> | void;

    /** DataContext registers its refreshFleet callback here once defined, so
     *  future fleet-owned CRUD can chain a post-RPC refresh. */
    registerRefreshFleet: (fn: () => Promise<void> | void) => () => void;
}

const FleetContext = createContext<FleetContextValue | null>(null);

export const FleetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { registerSliceSetter } = useDataCore();

    const [shipCatalog, setShipCatalog] = useState<PlatformShip[]>([]);
    const [userShips, setUserShips] = useState<UserShip[]>([]);
    const [fleetGroups, setFleetGroups] = useState<FleetGroup[]>([]);

    // DataContext registers refreshFleet here on mount; held in a ref so future
    // CRUD methods can call it without re-creating callbacks on every render.
    const refreshFleetRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshFleet = useCallback((fn: () => Promise<void> | void) => {
        refreshFleetRef.current = fn;
        return () => {
            if (refreshFleetRef.current === fn) refreshFleetRef.current = null;
        };
    }, []);

    const refreshFleet = useCallback(async () => {
        const fn = refreshFleetRef.current;
        if (fn) await fn();
    }, []);

    // Register three slice setters keyed by their data-payload field name; the
    // fleet payload puts these fields at the top level (not nested under hr.*).
    useEffect(() => {
        const unregCatalog = registerSliceSetter('shipCatalog', (data: any) => {
            if (data.shipCatalog) setShipCatalog(data.shipCatalog);
        });
        const unregUserShips = registerSliceSetter('userShips', (data: any) => {
            if (data.userShips) setUserShips(data.userShips);
        });
        const unregGroups = registerSliceSetter('fleetGroups', (data: any) => {
            if (data.fleetGroups) setFleetGroups(data.fleetGroups);
        });
        return () => {
            unregCatalog();
            unregUserShips();
            unregGroups();
        };
    }, [registerSliceSetter]);

    const value = useMemo<FleetContextValue>(() => ({
        shipCatalog, userShips, fleetGroups,
        setShipCatalog, setUserShips, setFleetGroups,
        refreshFleet,
        registerRefreshFleet,
    }), [
        shipCatalog, userShips, fleetGroups,
        refreshFleet,
        registerRefreshFleet,
    ]);

    return <FleetContext value={value}>{children}</FleetContext>;
};

export const useFleet = (): FleetContextValue => {
    const ctx = use(FleetContext);
    if (!ctx) throw new Error('useFleet must be used within a FleetProvider');
    return ctx;
};
