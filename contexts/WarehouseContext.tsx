// WarehouseContext owns the warehouse slices (catalog, stock, requests).
//
// Mounts OUTSIDE DataProvider so DataContext can call useWarehouse() inside its
// body and re-expose the warehouse fields on its own context value, keeping the
// useData() surface unchanged.
//
// There are no local warehouse CRUD methods; warehouse views call apiService
// directly and slices update via realtime broadcast + fetchDataSubset.
// refreshWarehouse is defined in DataContext and registered here via
// registerRefreshWarehouse so future CRUD can chain a post-RPC refresh without
// depending on useData() (which would create a context cycle).
//
// Warehouse is feature-gated per-org via orgMeta.features.warehouse.enabled;
// the realtime warehouse:* listeners are gated on that flag in DataCoreContext.
// The slice setters here fire regardless — they just won't be invoked if the
// feature is off and the 'warehouse' subset is never fetched.
//
// Hydration: registers three slice setters with DataCore, one per top-level
// field. Unlike HR (which nests under data.hr.*), the warehouse payload puts
// these at the top level, so each setter keys off its own data-payload field.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    WarehouseCatalogItem, WarehouseStock, WarehouseRequest,
} from '../types';

// Re-exports so domain consumers can import either from
// '../contexts/WarehouseContext' or '../types/warehouse' interchangeably.
export type {
    WarehouseCatalogItem,
    WarehouseStock,
    WarehouseRequest,
} from '../types';

export interface WarehouseContextValue {
    warehouseCatalog: WarehouseCatalogItem[];
    warehouseStock: WarehouseStock[];
    warehouseRequests: WarehouseRequest[];

    // Exposed so DataContext / future warehouse CRUD can write through to
    // canonical state without going through the slice-setter registry.
    setWarehouseCatalog: React.Dispatch<React.SetStateAction<WarehouseCatalogItem[]>>;
    setWarehouseStock: React.Dispatch<React.SetStateAction<WarehouseStock[]>>;
    setWarehouseRequests: React.Dispatch<React.SetStateAction<WarehouseRequest[]>>;

    refreshWarehouse: () => Promise<void> | void;

    /** DataContext registers its refreshWarehouse callback here once defined,
     *  so future warehouse-owned CRUD can chain a post-RPC refresh. */
    registerRefreshWarehouse: (fn: () => Promise<void> | void) => () => void;
}

const WarehouseContext = createContext<WarehouseContextValue | null>(null);

export const WarehouseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { registerSliceSetter } = useDataCore();

    const [warehouseCatalog, setWarehouseCatalog] = useState<WarehouseCatalogItem[]>([]);
    const [warehouseStock, setWarehouseStock] = useState<WarehouseStock[]>([]);
    const [warehouseRequests, setWarehouseRequests] = useState<WarehouseRequest[]>([]);

    // DataContext registers refreshWarehouse here on mount; held in a ref so
    // future CRUD can call it without re-creating callbacks on every render.
    const refreshWarehouseRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshWarehouse = useCallback((fn: () => Promise<void> | void) => {
        refreshWarehouseRef.current = fn;
        return () => {
            if (refreshWarehouseRef.current === fn) refreshWarehouseRef.current = null;
        };
    }, []);

    const refreshWarehouse = useCallback(async () => {
        const fn = refreshWarehouseRef.current;
        if (fn) await fn();
    }, []);

    // Register three slice setters keyed by their data-payload field name; the
    // warehouse payload puts these fields at the top level (not nested under hr.*).
    useEffect(() => {
        const unregCatalog = registerSliceSetter('warehouseCatalog', (data: any) => {
            if (data.warehouseCatalog) setWarehouseCatalog(data.warehouseCatalog);
        });
        const unregStock = registerSliceSetter('warehouseStock', (data: any) => {
            if (data.warehouseStock) setWarehouseStock(data.warehouseStock);
        });
        const unregRequests = registerSliceSetter('warehouseRequests', (data: any) => {
            if (data.warehouseRequests) setWarehouseRequests(data.warehouseRequests);
        });
        return () => {
            unregCatalog();
            unregStock();
            unregRequests();
        };
    }, [registerSliceSetter]);

    const value = useMemo<WarehouseContextValue>(() => ({
        warehouseCatalog, warehouseStock, warehouseRequests,
        setWarehouseCatalog, setWarehouseStock, setWarehouseRequests,
        refreshWarehouse,
        registerRefreshWarehouse,
    }), [
        warehouseCatalog, warehouseStock, warehouseRequests,
        refreshWarehouse,
        registerRefreshWarehouse,
    ]);

    return <WarehouseContext value={value}>{children}</WarehouseContext>;
};

export const useWarehouse = (): WarehouseContextValue => {
    const ctx = use(WarehouseContext);
    if (!ctx) throw new Error('useWarehouse must be used within a WarehouseProvider');
    return ctx;
};
