// OperationsContext owns the Operations slices (operations, operationTemplates,
// warrants) plus the operation/template/warrant CRUD methods.
//
// Mounts OUTSIDE DataProvider so DataContext can call useOperations() inside
// its body and re-expose the Operations fields on its own context value,
// keeping the useData() surface unchanged.
//
// radioChannels is NOT owned here — it lives in ConfigContext with the other
// admin-managed reference data, sourced from useConfig() at the DataContext layer.
//
// Hydration: registers a slice setter per slice with DataCore, populated when
// applyStateData(data) runs after a 'main'/'operations'/'warrants' subset fetch.
//
// refreshOperations/refreshWarrants are defined in DataContext and registered
// here via registerRefreshOperations/registerRefreshWarrants so CRUD methods can
// chain a post-RPC refresh without depending on useData() (would cycle).
// DataContext's optimisticUpdate 'operations'/'warrants' branches write through
// the setOperations/setWarrants setters exposed here.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    HydratedOperation, HydratedWarrant, OperationTemplate, OperationTemplatePayload,
} from '../types';

// Re-exports so domain consumers can import either from
// '../contexts/OperationsContext' or '../types/operations' interchangeably.
export type {
    HydratedOperation,
    HydratedOperationTeam,
    HydratedOperationPosition,
    HydratedWarrant,
    OperationTemplate,
    OperationTemplatePayload,
} from '../types';

export interface OperationsContextValue {
    operations: HydratedOperation[];
    operationTemplates: OperationTemplate[];
    warrants: HydratedWarrant[];

    // Exposed for DataContext's optimisticUpdate ('operations', 'warrants') branches.
    setOperations: React.Dispatch<React.SetStateAction<HydratedOperation[]>>;
    setOperationTemplates: React.Dispatch<React.SetStateAction<OperationTemplate[]>>;
    setWarrants: React.Dispatch<React.SetStateAction<HydratedWarrant[]>>;

    createOperationTemplate: (data: { name: string; description?: string; payload: OperationTemplatePayload; sourceOperationId?: string }) => Promise<OperationTemplate>;
    updateOperationTemplate: (id: number, updates: { name?: string; description?: string; payload?: OperationTemplatePayload }) => Promise<OperationTemplate>;
    deleteOperationTemplate: (id: number) => Promise<void>;
    extractTemplateFromOperation: (operationId: string) => Promise<OperationTemplatePayload>;
    importOperationTemplate: (data: { name: string; description?: string; payload: OperationTemplatePayload }) => Promise<OperationTemplate>;

    createOperation: (data: any) => Promise<any>;
    deleteOperation: (id: string) => Promise<void>;
    updateOperationStatus: (id: string, status: string) => Promise<void>;
    updateOperationDetails: (id: string, updates: any) => Promise<any>;
    joinOperation: (id: string, code?: string) => Promise<void>;
    joinOperationWithShip: (id: string, opts: { joinCode?: string; roleRequested?: string; shipUtilized?: string; shipId?: number; userShipId?: number }) => Promise<void>;
    acceptOperationInvite: (operationId: string) => Promise<void>;
    declineOperationInvite: (operationId: string) => Promise<void>;
    leaveOperation: (id: string) => Promise<void>;
    addOperationParticipant: (opId: string, userId: number) => Promise<void>;
    updateOperationParticipant: (opId: string, userId: number, data: any) => Promise<void>;
    removeOperationParticipant: (opId: string, userId: number) => Promise<void>;
    addOperationUec: (opId: string, amount: number, reason: string) => Promise<void>;
    addOperationCost: (opId: string, amount: number, category: string, description?: string) => Promise<void>;
    setOperationPayoutMode: (opId: string, mode: 'equal' | 'weighted' | 'custom') => Promise<void>;
    setOperationPayoutSplits: (opId: string, splits: Array<{ userId: number; percent: number }>) => Promise<void>;
    toggleParticipantPayoutPaid: (opId: string, targetUserId: number, paid: boolean) => Promise<void>;
    toggleParticipantReady: (opId: string) => Promise<void>;
    updateParticipantLiveStatus: (opId: string, liveStatus: string) => Promise<void>;
    resetOperationReadiness: (opId: string) => Promise<void>;
    addOperationTimelineEntry: (opId: string, entry: string) => Promise<void>;
    rsvpOperation: (opId: string, rsvpStatus: string, shipId?: number, userShipId?: number) => Promise<void>;

    createWarrant: (data: any) => Promise<void>;
    updateWarrant: (id: string, data: any) => Promise<void>;
    deleteWarrant: (id: string) => Promise<void>;

    /** DataContext registers its refreshOperations callback here once defined;
     *  CRUD methods invoke it after their RPC completes. */
    registerRefreshOperations: (fn: () => Promise<void> | void) => () => void;
    /** Same, for the 'warrants' subset. */
    registerRefreshWarrants: (fn: () => Promise<void> | void) => () => void;
}

const OperationsContext = createContext<OperationsContextValue | null>(null);

export const OperationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { rpcAction, registerSliceSetter } = useDataCore();

    const [operations, setOperations] = useState<HydratedOperation[]>([]);
    const [operationTemplates, setOperationTemplates] = useState<OperationTemplate[]>([]);
    const [warrants, setWarrants] = useState<HydratedWarrant[]>([]);

    // DataContext registers refreshOperations/refreshWarrants here on mount;
    // held in refs so CRUD methods can call them without re-creating callbacks.
    const refreshOperationsRef = useRef<(() => Promise<void> | void) | null>(null);
    const refreshWarrantsRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshOperations = useCallback((fn: () => Promise<void> | void) => {
        refreshOperationsRef.current = fn;
        return () => {
            if (refreshOperationsRef.current === fn) refreshOperationsRef.current = null;
        };
    }, []);
    const registerRefreshWarrants = useCallback((fn: () => Promise<void> | void) => {
        refreshWarrantsRef.current = fn;
        return () => {
            if (refreshWarrantsRef.current === fn) refreshWarrantsRef.current = null;
        };
    }, []);

    const refreshOperationsFn = useCallback(async () => {
        const fn = refreshOperationsRef.current;
        if (fn) await fn();
    }, []);

    const refreshWarrantsFn = useCallback(async () => {
        const fn = refreshWarrantsRef.current;
        if (fn) await fn();
    }, []);

    // Each setter applies its slice when applyStateData(data) runs after a
    // 'main'/'operations'/'warrants' subset fetch.
    useEffect(() => {
        const cleanups = [
            registerSliceSetter('operations', (data: any) => { if (data.operations) setOperations(data.operations); }),
            registerSliceSetter('operationTemplates', (data: any) => { if (data.operationTemplates) setOperationTemplates(data.operationTemplates); }),
            registerSliceSetter('warrants', (data: any) => { if (data.warrants) setWarrants(data.warrants); }),
        ];
        return () => cleanups.forEach(unreg => unreg());
    }, [registerSliceSetter]);

    const createOperationTemplate = useCallback((data: { name: string; description?: string; payload: OperationTemplatePayload; sourceOperationId?: string }) =>
        rpcAction('operation:template:create', data).then((tpl) => { void refreshOperationsFn(); return tpl as OperationTemplate; }),
    [rpcAction, refreshOperationsFn]);

    const updateOperationTemplate = useCallback((id: number, updates: { name?: string; description?: string; payload?: OperationTemplatePayload }) =>
        rpcAction('operation:template:update', { id, ...updates }).then((tpl) => { void refreshOperationsFn(); return tpl as OperationTemplate; }),
    [rpcAction, refreshOperationsFn]);

    const deleteOperationTemplate = useCallback((id: number) =>
        rpcAction('operation:template:delete', { id }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    // Builds a payload from an existing op without persisting; the caller
    // typically follows up with createOperationTemplate to save it. No refresh
    // needed — this is a pure read of the operation's structure.
    const extractTemplateFromOperation = useCallback((operationId: string) =>
        rpcAction('operation:template:from_operation', { operationId }) as Promise<OperationTemplatePayload>,
    [rpcAction]);

    const importOperationTemplate = useCallback((data: { name: string; description?: string; payload: OperationTemplatePayload }) =>
        rpcAction('operation:template:import', data).then((tpl) => { void refreshOperationsFn(); return tpl as OperationTemplate; }),
    [rpcAction, refreshOperationsFn]);

    // deleteOperation and updateOperationStatus apply an optimistic write through
    // setOperations before the RPC, then refresh.
    const createOperation = useCallback((data: any) =>
        rpcAction('operation:create', data).then(async (res) => { await refreshOperationsFn(); return res; }),
    [rpcAction, refreshOperationsFn]);

    const deleteOperation = useCallback((id: string) => {
        setOperations(prev => prev.filter(op => op.id !== id));
        return rpcAction('operation:delete', { operationId: id }).then(() => { void refreshOperationsFn(); });
    }, [rpcAction, refreshOperationsFn]);

    const updateOperationStatus = useCallback((id: string, status: string) => {
        setOperations(prev => prev.map(op => op.id === id ? { ...op, status: status as HydratedOperation['status'] } : op));
        return rpcAction('operation:update_status', { operationId: id, status }).then(() => { void refreshOperationsFn(); });
    }, [rpcAction, refreshOperationsFn]);

    const updateOperationDetails = useCallback((id: string, updates: any) =>
        rpcAction('operation:update', { operationId: id, updates }).then(async (result) => { await refreshOperationsFn(); return result; }),
    [rpcAction, refreshOperationsFn]);

    const joinOperation = useCallback((id: string, code?: string) =>
        rpcAction('operation:join', { operationId: id, joinCode: code }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const joinOperationWithShip = useCallback((id: string, opts: { joinCode?: string; roleRequested?: string; shipUtilized?: string; shipId?: number; userShipId?: number }) =>
        rpcAction('operation:join_with_role', { operationId: id, ...opts }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const acceptOperationInvite = useCallback((operationId: string) =>
        rpcAction('operation:accept_invite', { operationId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const declineOperationInvite = useCallback((operationId: string) =>
        rpcAction('operation:decline_invite', { operationId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const leaveOperation = useCallback((id: string) =>
        rpcAction('operation:leave', { operationId: id }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const addOperationParticipant = useCallback((opId: string, userId: number) =>
        rpcAction('operation:add_participant', { operationId: opId, targetUserId: userId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const updateOperationParticipant = useCallback((opId: string, userId: number, data: any) =>
        rpcAction('operation:update_participant', { operationId: opId, targetUserId: userId, updates: data }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    // removeOperationParticipant reuses the 'operation:leave' RPC with a
    // targetUserId override.
    const removeOperationParticipant = useCallback((opId: string, userId: number) =>
        rpcAction('operation:leave', { operationId: opId, targetUserId: userId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const addOperationUec = useCallback((opId: string, amount: number, reason: string) =>
        rpcAction('operation:add_uec', { operationId: opId, amount, reason }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const addOperationCost = useCallback((opId: string, amount: number, category: string, description?: string) =>
        rpcAction('operation:add_cost', { operationId: opId, amount, category, description }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const setOperationPayoutMode = useCallback((opId: string, mode: 'equal' | 'weighted' | 'custom') =>
        rpcAction('operation:set_payout_mode', { operationId: opId, mode }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const setOperationPayoutSplits = useCallback((opId: string, splits: Array<{ userId: number; percent: number }>) =>
        rpcAction('operation:set_payout_splits', { operationId: opId, splits }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const toggleParticipantPayoutPaid = useCallback((opId: string, targetUserId: number, paid: boolean) =>
        rpcAction('operation:toggle_payout_paid', { operationId: opId, targetUserId, paid }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const toggleParticipantReady = useCallback((opId: string) =>
        rpcAction('operation:toggle_ready', { operationId: opId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const updateParticipantLiveStatus = useCallback((opId: string, liveStatus: string) =>
        rpcAction('operation:update_participant_live_status', { operationId: opId, liveStatus }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const resetOperationReadiness = useCallback((opId: string) =>
        rpcAction('operation:reset_readiness', { operationId: opId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const addOperationTimelineEntry = useCallback((opId: string, entry: string) =>
        rpcAction('operation:timeline_add', { operationId: opId, entry }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    const rsvpOperation = useCallback((opId: string, rsvpStatus: string, shipId?: number, userShipId?: number) =>
        rpcAction('operation:rsvp', { operationId: opId, rsvpStatus, shipId, userShipId }).then(() => { void refreshOperationsFn(); }),
    [rpcAction, refreshOperationsFn]);

    // updateWarrant and deleteWarrant apply an optimistic write through
    // setWarrants before the RPC, then refresh.
    const createWarrant = useCallback((data: any) =>
        rpcAction('warrant:create', data).then(() => { void refreshWarrantsFn(); }),
    [rpcAction, refreshWarrantsFn]);

    const updateWarrant = useCallback((id: string, data: any) => {
        setWarrants(prev => prev.map(w => w.id === id ? { ...w, ...data } : w));
        return rpcAction('warrant:update', { warrantId: id, updates: data }).then(() => { void refreshWarrantsFn(); });
    }, [rpcAction, refreshWarrantsFn]);

    const deleteWarrant = useCallback((id: string) => {
        setWarrants(prev => prev.filter(w => w.id !== id));
        return rpcAction('warrant:delete', { warrantId: id }).then(() => { void refreshWarrantsFn(); });
    }, [rpcAction, refreshWarrantsFn]);

    const value = useMemo<OperationsContextValue>(() => ({
        operations, operationTemplates, warrants,
        setOperations, setOperationTemplates, setWarrants,
        createOperationTemplate, updateOperationTemplate, deleteOperationTemplate,
        extractTemplateFromOperation, importOperationTemplate,
        createOperation, deleteOperation, updateOperationStatus, updateOperationDetails,
        joinOperation, joinOperationWithShip, acceptOperationInvite, declineOperationInvite,
        leaveOperation, addOperationParticipant, updateOperationParticipant,
        removeOperationParticipant, addOperationUec, addOperationCost,
        setOperationPayoutMode, setOperationPayoutSplits, toggleParticipantPayoutPaid,
        toggleParticipantReady, updateParticipantLiveStatus, resetOperationReadiness,
        addOperationTimelineEntry, rsvpOperation,
        createWarrant, updateWarrant, deleteWarrant,
        registerRefreshOperations, registerRefreshWarrants,
    }), [
        operations, operationTemplates, warrants,
        createOperationTemplate, updateOperationTemplate, deleteOperationTemplate,
        extractTemplateFromOperation, importOperationTemplate,
        createOperation, deleteOperation, updateOperationStatus, updateOperationDetails,
        joinOperation, joinOperationWithShip, acceptOperationInvite, declineOperationInvite,
        leaveOperation, addOperationParticipant, updateOperationParticipant,
        removeOperationParticipant, addOperationUec, addOperationCost,
        setOperationPayoutMode, setOperationPayoutSplits, toggleParticipantPayoutPaid,
        toggleParticipantReady, updateParticipantLiveStatus, resetOperationReadiness,
        addOperationTimelineEntry, rsvpOperation,
        createWarrant, updateWarrant, deleteWarrant,
        registerRefreshOperations, registerRefreshWarrants,
    ]);

    return <OperationsContext value={value}>{children}</OperationsContext>;
};

export const useOperations = (): OperationsContextValue => {
    const ctx = use(OperationsContext);
    if (!ctx) throw new Error('useOperations must be used within an OperationsProvider');
    return ctx;
};
