// GovernmentContext owns the government slices (config, branches, positions,
// position holders, elections, legislation, motions, feature config).
//
// Mounts OUTSIDE DataProvider so DataContext can call useGovernment() inside
// its body and re-expose the government fields on its own context value,
// keeping the useData() surface unchanged.
//
// Server payload field names:
//   data.governmentsConfig → setGovernmentsFeatureConfig (feature flag config)
//   data.governmentConfig  → setGovernmentConfig          (per-org config, null is valid)
// The "governmentsConfig"/"governmentsFeatureConfig" name mismatch is preserved
// to match the server payload key.
//
// There are no local government CRUD methods; government views call apiService
// directly and slices update via realtime broadcast + fetchDataSubset.
// refreshGovernment is defined in DataContext and registered here via
// registerRefreshGovernment so future CRUD can chain a post-RPC refresh without
// depending on useData() (which would create a context cycle).
//
// governmentsFeatureConfig is read by DataContext to set governmentsEnabled via
// registerFeatureFlags; the realtime government_update handler is gated on that
// flag in DataCoreContext.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    GovernmentConfig, GovernmentBranch, GovernmentPosition, GovernmentPositionHolder,
    GovernmentElection, GovernmentLegislation, GovernmentMotion, GovernmentsFeatureConfig,
} from '../types';

// Re-exports so domain consumers can import either from
// '../contexts/GovernmentContext' or '../types/government' interchangeably.
export type {
    GovernmentConfig,
    GovernmentBranch,
    GovernmentPosition,
    GovernmentPositionHolder,
    GovernmentElection,
    GovernmentLegislation,
    GovernmentMotion,
    GovernmentsFeatureConfig,
} from '../types';

export interface GovernmentContextValue {
    governmentConfig: GovernmentConfig | null;
    governmentBranches: GovernmentBranch[];
    governmentPositions: GovernmentPosition[];
    governmentPositionHolders: GovernmentPositionHolder[];
    governmentElections: GovernmentElection[];
    governmentLegislation: GovernmentLegislation[];
    governmentMotions: GovernmentMotion[];
    governmentsFeatureConfig: GovernmentsFeatureConfig;

    // Exposed so DataContext / future government CRUD can write through to
    // canonical state without going through the slice-setter registry.
    setGovernmentConfig: React.Dispatch<React.SetStateAction<GovernmentConfig | null>>;
    setGovernmentBranches: React.Dispatch<React.SetStateAction<GovernmentBranch[]>>;
    setGovernmentPositions: React.Dispatch<React.SetStateAction<GovernmentPosition[]>>;
    setGovernmentPositionHolders: React.Dispatch<React.SetStateAction<GovernmentPositionHolder[]>>;
    setGovernmentElections: React.Dispatch<React.SetStateAction<GovernmentElection[]>>;
    setGovernmentLegislation: React.Dispatch<React.SetStateAction<GovernmentLegislation[]>>;
    setGovernmentMotions: React.Dispatch<React.SetStateAction<GovernmentMotion[]>>;
    setGovernmentsFeatureConfig: React.Dispatch<React.SetStateAction<GovernmentsFeatureConfig>>;

    refreshGovernment: () => Promise<void> | void;

    /** DataContext registers its refreshGovernment callback here once defined,
     *  so future government-owned CRUD can chain a post-RPC refresh. */
    registerRefreshGovernment: (fn: () => Promise<void> | void) => () => void;
}

const GovernmentContext = createContext<GovernmentContextValue | null>(null);

export const GovernmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { registerSliceSetter } = useDataCore();

    const [governmentConfig, setGovernmentConfig] = useState<GovernmentConfig | null>(null);
    const [governmentBranches, setGovernmentBranches] = useState<GovernmentBranch[]>([]);
    const [governmentPositions, setGovernmentPositions] = useState<GovernmentPosition[]>([]);
    const [governmentPositionHolders, setGovernmentPositionHolders] = useState<GovernmentPositionHolder[]>([]);
    const [governmentElections, setGovernmentElections] = useState<GovernmentElection[]>([]);
    const [governmentLegislation, setGovernmentLegislation] = useState<GovernmentLegislation[]>([]);
    const [governmentMotions, setGovernmentMotions] = useState<GovernmentMotion[]>([]);
    const [governmentsFeatureConfig, setGovernmentsFeatureConfig] = useState<GovernmentsFeatureConfig>({ enabled: false });

    // DataContext registers refreshGovernment here on mount; held in a ref so
    // future CRUD can call it without re-creating callbacks on every render.
    const refreshGovernmentRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshGovernment = useCallback((fn: () => Promise<void> | void) => {
        refreshGovernmentRef.current = fn;
        return () => {
            if (refreshGovernmentRef.current === fn) refreshGovernmentRef.current = null;
        };
    }, []);

    const refreshGovernment = useCallback(async () => {
        const fn = refreshGovernmentRef.current;
        if (fn) await fn();
    }, []);

    // Register eight slice setters keyed by their data-payload field name; the
    // government payload puts these fields at the top level (not nested under
    // hr.*). The feature-config setter is keyed under the server's
    // "governmentsConfig" payload key. governmentConfig uses a `!== undefined`
    // check because null is a valid value (org with no government configured),
    // so the setter must run when the server explicitly sends null.
    useEffect(() => {
        const unregFeature = registerSliceSetter('governmentsConfig', (data: any) => {
            if (data.governmentsConfig) setGovernmentsFeatureConfig(data.governmentsConfig);
        });
        const unregConfig = registerSliceSetter('governmentConfig', (data: any) => {
            if (data.governmentConfig !== undefined) setGovernmentConfig(data.governmentConfig);
        });
        const unregBranches = registerSliceSetter('governmentBranches', (data: any) => {
            if (data.governmentBranches) setGovernmentBranches(data.governmentBranches);
        });
        const unregPositions = registerSliceSetter('governmentPositions', (data: any) => {
            if (data.governmentPositions) setGovernmentPositions(data.governmentPositions);
        });
        const unregPositionHolders = registerSliceSetter('governmentPositionHolders', (data: any) => {
            if (data.governmentPositionHolders) setGovernmentPositionHolders(data.governmentPositionHolders);
        });
        const unregElections = registerSliceSetter('governmentElections', (data: any) => {
            if (data.governmentElections) setGovernmentElections(data.governmentElections);
        });
        const unregLegislation = registerSliceSetter('governmentLegislation', (data: any) => {
            if (data.governmentLegislation) setGovernmentLegislation(data.governmentLegislation);
        });
        const unregMotions = registerSliceSetter('governmentMotions', (data: any) => {
            if (data.governmentMotions) setGovernmentMotions(data.governmentMotions);
        });
        return () => {
            unregFeature();
            unregConfig();
            unregBranches();
            unregPositions();
            unregPositionHolders();
            unregElections();
            unregLegislation();
            unregMotions();
        };
    }, [registerSliceSetter]);

    const value = useMemo<GovernmentContextValue>(() => ({
        governmentConfig, governmentBranches, governmentPositions, governmentPositionHolders,
        governmentElections, governmentLegislation, governmentMotions, governmentsFeatureConfig,
        setGovernmentConfig, setGovernmentBranches, setGovernmentPositions, setGovernmentPositionHolders,
        setGovernmentElections, setGovernmentLegislation, setGovernmentMotions, setGovernmentsFeatureConfig,
        refreshGovernment,
        registerRefreshGovernment,
    }), [
        governmentConfig, governmentBranches, governmentPositions, governmentPositionHolders,
        governmentElections, governmentLegislation, governmentMotions, governmentsFeatureConfig,
        refreshGovernment,
        registerRefreshGovernment,
    ]);

    return <GovernmentContext value={value}>{children}</GovernmentContext>;
};

export const useGovernment = (): GovernmentContextValue => {
    const ctx = use(GovernmentContext);
    if (!ctx) throw new Error('useGovernment must be used within a GovernmentProvider');
    return ctx;
};
