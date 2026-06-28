
import React, { createContext, use, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import apiService from '../services/apiService';
import { debugLog } from '../lib/debugLog';
import { mergeUsersSlice, mergeRowSlice, byCreatedAtDesc } from '../lib/sliceMerge';
import { makeSliceCoalescer, SliceCoalescer, makeGenGuard, GenGuard } from '../lib/sliceCoalescer';
import { useDataCore, FetchDataSubsetOptions } from './DataCoreContext';
import { useMembers } from './MembersContext';
import { useConfig } from './ConfigContext';
import { useOperations } from './OperationsContext';
import { useIntel } from './IntelContext';
import { useHR } from './HRContext';
import { useWarehouse } from './WarehouseContext';
import { useFleet } from './FleetContext';
import { useGovernment } from './GovernmentContext';
import { useRequests } from './RequestsContext';
import { useAnnouncements } from './AnnouncementsContext';
import {
    User,
    WikiPage,
    UserRole, DataContextType, OrgMeta, IntelThreatLevel
} from '../types';
import { prefetchSounds } from '../lib/audioCache';

export const defaultIconUrl = '/media/cross-swords.png';

// Per-slice subsets whose responses are applied via applyStateData: the
// registered domain slice setters all guard by payload key, so a partial
// payload (one warehouse array, one government key-group, one hr array)
// writes only its own slice. Grown by each realtime slice conversion.
const APPLY_STATE_SLICE_SUBSETS = new Set([
    'warehouse_catalog', 'warehouse_stock', 'warehouse_requests',
    'government_structure', 'government_elections', 'government_legislation', 'government_motions',
    'hr_applicants', 'hr_interviews', 'hr_jobs', 'hr_templates', 'hr_transfers', 'hr_positions',
    'fleet_catalog', 'fleet_user_ships', 'fleet_groups',
]);

// Row-level slice subsets bypass the 2-second per-subset dedupe — their
// union-coalescers replace it (and the row-sliced tables are excluded from
// postgres_changes, so there is no broadcast+postgres double-fire for them).
const ROW_SLICE_SUBSETS = new Set([
    'users_slice', 'operation_slice', 'warrant_slice', 'bulletin_slice', 'wiki_page_slice',
]);

// Pillar 1 (views hydrate only what they display, when on screen): these
// domains are NOT in the boot payload — their data exists client-side only
// after their view loads it. Realtime events for a domain this user never
// opened are SKIPPED (no off-screen hydration of full wiki bodies / fleet
// bundles / warehouse arrays / government lists); the view's mount fetch
// ({force:true}) marks the domain live and realtime keeps it fresh from
// then on.
const LAZY_DOMAINS: Record<string, string> = {
    wiki: 'wiki', wiki_page_slice: 'wiki',
    fleet: 'fleet', fleet_catalog: 'fleet', fleet_user_ships: 'fleet', fleet_groups: 'fleet',
    warehouse: 'warehouse', warehouse_catalog: 'warehouse', warehouse_stock: 'warehouse', warehouse_requests: 'warehouse',
    government: 'government', government_structure: 'government', government_elections: 'government', government_legislation: 'government', government_motions: 'government',
};
// Fallback logic for mappers needing it (minimal dummy constraint)
const unknownUser: User = { id: 0, discordId: '', name: 'Unknown', avatarUrl: '', rsiHandle: '', role: UserRole.Client, roleId: 1, reputation: 0, isDuty: false, permissions: [], createdAt: '' };

const DataContext = createContext<DataContextType | null>(null);

export const DataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // DataCore owns the rpcAction dispatcher and the supabase realtime channel
    // lifecycle (build/teardown/visibility-resync/idle-disconnect). DataContext
    // registers its fetchDataSubset + current feature flags with DataCore so
    // the channel's broadcast/postgres_changes handlers can dispatch back into
    // the slice setters that still live here. See contexts/DataCoreContext.tsx.
    const dataCore = useDataCore();
    const { rpcAction, notifyDbConnected, registerFetchDataSubset, registerFeatureFlags, applyStateData } = dataCore;

    // Members domain. MembersProvider mounts OUTSIDE this provider so we can read
    // its value here and re-expose the Members slices + CRUD methods + derived
    // `members` on the DataContext value verbatim, preserving the useData() shape.
    const members = useMembers();
    const {
        allUsers, ranks, units, roles,
        securityClearances, limitingMarkers, specializationTags, certifications, commendations,
        syncedDiscordRoles, rankMappings, roleMappings,
        members: derivedMembers,
        setAllUsers: setMembersAllUsers,
        setRanks: setMembersRanks,
        setUnits: setMembersUnits,
        addUnit, updateUnit, deleteUnit,
        addRank, updateRank, deleteRank,
        addRole, updateRole, deleteRole, getRoleDetails, updateRolePermissions,
        addSpecializationTag, updateSpecializationTag, deleteSpecializationTag,
        addCertification, updateCertification, deleteCertification,
        addCommendation, updateCommendation, deleteCommendation,
        syncDiscordRoles, updateRankMapping,
        registerRefreshMainState: registerMembersRefreshMain,
        registerRefreshDiscord: registerMembersRefreshDiscord,
    } = members;

    // Config domain — sourced from useConfig() and re-exposed on the DataContext
    // value verbatim.
    const config = useConfig();
    const {
        brandingConfig, discordConfig, heroCardConfig, openGraphConfig, radioConfig,
        aiConfig, wikiHomeConfig, hrConfig, publicPageConfig,
        serviceTypes, externalTools, locations, radioChannels,
        addLocation, updateLocation, deleteLocation, seedDefaultLocations,
        addServiceType, updateServiceType, deleteServiceType,
        addExternalTool, updateExternalTool, deleteExternalTool, reorderExternalTool,
        deleteRadioChannel,
        updateDiscordConfig, updateHeroCardConfig, updateBrandingConfig, updateOpenGraphConfig,
        updateRadioConfig, updateAIConfig, updateWikiHomeConfig, updateSystemConfig,
        updatePublicPageConfig, updateOrgFeatures,
        listTestimonialCandidates,
        registerRefreshMainState: registerConfigRefreshMain,
        registerRefreshDiscord: registerConfigRefreshDiscord,
        registerRefreshExternalTools: registerConfigRefreshExternalTools,
    } = config;

    // Operations domain — sourced from useOperations() and re-exposed verbatim.
    // setOperations / setWarrants are destructured so DataContext's
    // optimisticUpdate ('operations' | 'warrants') branches can write through.
    const operationsCtx = useOperations();
    const {
        operations, operationTemplates, warrants,
        setOperations: setOpsOperations,
        setOperationTemplates: setOpsOperationTemplates,
        setWarrants: setOpsWarrants,
        createOperationTemplate, updateOperationTemplate, deleteOperationTemplate,
        extractTemplateFromOperation, importOperationTemplate,
        registerRefreshOperations: registerOpsRefreshOperations,
        registerRefreshWarrants: registerOpsRefreshWarrants,
    } = operationsCtx;

    // Intel domain — sourced from useIntel() and re-exposed verbatim. The setters
    // are destructured so DataContext's fetchDataSubset('intel') branch can write
    // through (Map construction for intelTargetIndex and the version bump live in
    // the subset-fetch dispatch table below — Intel doesn't own a subset fetcher).
    const intelCtx = useIntel();
    const {
        intelTargetIndex, intelHubStats, intelDataVersion, activeBulletins,
        setIntelTargetIndex: setIntelCtxTargetIndex,
        setIntelHubStats: setIntelCtxHubStats,
        setIntelDataVersion: setIntelCtxDataVersion,
        setActiveBulletins: setIntelCtxActiveBulletins,
        createBulletin, deleteBulletin,
        registerRefreshIntel: registerIntelRefreshIntel,
    } = intelCtx;

    // HR domain — sourced from useHR() and re-exposed verbatim. setHrApplicants /
    // setHrInterviews are destructured so DataContext's optimisticUpdate
    // ('hr_applications' | 'hr_interviews') branches can write through; setHrJobs
    // is forwarded on the useData() value. The HR nested-block (data.hr.*) is
    // populated via HR's registered 'hr' slice setter.
    const hrCtx = useHR();
    const {
        hrApplicants, hrInterviews, hrJobs, hrTemplates, hrTransfers, hrPositions,
        setHrApplicants: setHrCtxApplicants,
        setHrInterviews: setHrCtxInterviews,
        setHrJobs,
        registerRefreshHR,
    } = hrCtx;

    // Warehouse domain — sourced from useWarehouse() and re-exposed verbatim.
    // No optimistic-update branches exist for warehouse tables; Warehouse's
    // slice setters run via applyStateData(data) (the 'warehouse' subset-fetch
    // branch routes the response through it).
    const warehouseCtx = useWarehouse();
    const {
        warehouseCatalog, warehouseStock, warehouseRequests,
        registerRefreshWarehouse,
    } = warehouseCtx;

    // Fleet domain — sourced from useFleet() and re-exposed verbatim. No
    // optimistic-update branches exist for fleet tables; Fleet's slice setters
    // run via applyStateData(data) (the 'fleet' subset-fetch branch routes the
    // response through it). ensureFleetLoaded stays a DataContext-local callback
    // (part of the DataContext value) and reads the destructured shipCatalog.
    const fleetCtx = useFleet();
    const {
        shipCatalog, userShips, fleetGroups,
        registerRefreshFleet,
    } = fleetCtx;

    // Government domain — sourced from useGovernment() and re-exposed verbatim.
    // No optimistic-update branches and no government CRUD here. Government's
    // slice setters run via applyStateData(data) (the 'government' subset-fetch
    // branch routes the response through it). governmentsFeatureConfig flows into
    // the registerFeatureFlags effect below so DataCore sees the current state.
    const governmentCtx = useGovernment();
    const {
        governmentConfig, governmentBranches, governmentPositions, governmentPositionHolders,
        governmentElections, governmentLegislation, governmentMotions, governmentsFeatureConfig,
        registerRefreshGovernment,
    } = governmentCtx;

    // Requests domain — sourced from useRequests() and re-exposed verbatim.
    // setHydratedServiceRequests is destructured so DataContext's
    // optimisticUpdate('service_requests') branch + fetchDataSubset('requests')
    // handler can write through.
    const requestsCtx = useRequests();
    const {
        hydratedServiceRequests,
        setHydratedServiceRequests: setReqsHydrated,
        registerRefreshRequests,
    } = requestsCtx;

    // Announcements domain — sourced from useAnnouncements() and re-exposed
    // verbatim. setAnnouncements is destructured so DataContext's
    // optimisticUpdate('announcements') branch + fetchDataSubset('announcements')
    // handler can write through.
    const announcementsCtx = useAnnouncements();
    const {
        announcements,
        setAnnouncements: setAnnsAnnouncements,
        registerRefreshAnnouncements,
    } = announcementsCtx;

    // Members, Config, Operations, Intel, HR, Warehouse, Fleet, Government,
    // Requests, and Announcements slices live in their own domain contexts and
    // are sourced via the use*() hooks above. Only wikiPages remains DataContext-local.
    const [wikiPages, setWikiPages] = useState<WikiPage[]>([]);

    // activeEam is not held here — the EAM body is stripped from every wire
    // payload (audience-gated via broadcast:get_active_eam); EAMBroadcastTab
    // fetches it locally.
    const [orgMeta, setOrgMeta] = useState<OrgMeta | null>(null);
    const [platformSettings, setPlatformSettings] = useState<any>(null);

    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});

    // Optimistic Update Helper
    const optimisticUpdate = useCallback((table: string, id: string | number, data: any, action: 'create' | 'update' | 'delete') => {
        debugLog(`[Optimistic] ${action} on ${table}:${id}`);

        if (table === 'service_requests') {
            // Slice lives in RequestsContext; write through its setter.
            setReqsHydrated(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'operations') {
            // Slice lives in OperationsContext; write through its setter.
            setOpsOperations(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'warrants') {
            // Slice lives in OperationsContext; write through its setter.
            setOpsWarrants(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'hr_applications') {
            // Slice lives in HRContext; write through its setter.
            setHrCtxApplicants(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'hr_interviews') {
            // Slice lives in HRContext; write through its setter.
            setHrCtxInterviews(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'announcements') {
            // Slice lives in AnnouncementsContext; write through its setter.
            setAnnsAnnouncements(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'organizational_units') {
            // Slice lives in MembersContext; write through its setter.
            setMembersUnits(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
        else if (table === 'ranks') {
            // Slice lives in MembersContext; write through its setter.
            setMembersRanks(prev => {
                if (action === 'delete') return prev.filter(item => item.id !== id);
                if (action === 'update') return prev.map(item => item.id === id ? { ...item, ...data } : item);
                if (action === 'create') return [data, ...prev];
                return prev;
            });
        }
    }, [setMembersRanks, setMembersUnits, setOpsOperations, setOpsWarrants, setHrCtxApplicants, setHrCtxInterviews, setReqsHydrated, setAnnsAnnouncements]);

    const setStateFromData = useCallback((data: any) => {
        if (!data) return;
        // Every domain's slices (Members, Config, Intel, Operations, HR,
        // Warehouse, Fleet, Government, Requests, Announcements) are populated
        // via DataCore's registered slice setters — call applyStateData first so
        // they fire on every bulk-state payload. Only wikiPages, orgMeta, and
        // platformSettings remain DataContext-local.
        applyStateData(data);

        if (data.wikiPages) setWikiPages(data.wikiPages);
        if (data.orgMeta) setOrgMeta(data.orgMeta);
        if (data.platformSettings) setPlatformSettings(data.platformSettings);
    }, [applyStateData]);

    // Debounce realtime-triggered fetches: if the same subset was fetched in the last 2 seconds, skip it.
    // This prevents the double-refresh caused by broadcast + postgres_changes both firing for the same mutation.
    const recentFetchesRef = useRef<Map<string, number>>(new Map());

    // --- Realtime slice-update machinery ---
    // Generation guards (lib/sliceCoalescer.ts makeGenGuard): full-subset
    // refetches and per-row slice patches write the SAME arrays via
    // unsynchronized paths, so a SLOW full fetch (reconnect / visibility
    // resync) could resolve after a fresher slice patch and wholesale-clobber
    // it with pre-mutation data. Every fetch touching a guarded array calls
    // begin() at start; a response only applies if no later-started fetch has
    // applied first (stale full responses drop just their guarded key — the
    // slice setters guard by key, so the rest of the payload still lands).
    // One guard per slice-patched array.
    // Created exactly once via useState's lazy initializer — the guards object
    // is a stable, never-reassigned reference for the provider's lifetime, so
    // it is safe to use in the useCallback dependency arrays below. (Lazy ref
    // init would do the same but reads/writes ref.current during render.)
    const [guards] = useState<{
        users: GenGuard;
        operations: GenGuard;
        warrants: GenGuard;
        intelSummary: GenGuard;
        bulletins: GenGuard;
        wikiPages: GenGuard;
    }>(() => ({
        users: makeGenGuard(),
        operations: makeGenGuard(),
        warrants: makeGenGuard(),
        intelSummary: makeGenGuard(),
        bulletins: makeGenGuard(),
        wikiPages: makeGenGuard(),
    }));
    // Union-coalescers (lib/sliceCoalescer.ts): a burst of broadcasts
    // accumulates ids into a pending set while one drain-loop is in flight,
    // so N near-simultaneous events cost at most one in-flight fetch plus one
    // trailing catch-up fetch. (Row-sliced tables are excluded from
    // postgres_changes, so the 2s subset dedupe below doesn't apply to
    // slices — the coalescer replaces it.) Instances are lazy-created per
    // slice family and persist in refs; their error fallbacks read the
    // LATEST fetchDataSubset through fetchDataSubsetRef.
    const fetchDataSubsetRef = useRef<(subset: string, options?: FetchDataSubsetOptions) => Promise<void> | void>(() => {});
    const userSliceCoalescerRef = useRef<SliceCoalescer<number> | null>(null);
    const opSliceCoalescerRef = useRef<SliceCoalescer<string> | null>(null);
    const warrantSliceCoalescerRef = useRef<SliceCoalescer<string> | null>(null);
    const bulletinSliceCoalescerRef = useRef<SliceCoalescer<string> | null>(null);
    const wikiSliceCoalescerRef = useRef<SliceCoalescer<string> | null>(null);

    // Guarded full-state hydrate — the ONLY sanctioned way to apply a
    // getInitialState() payload outside boot. Captures generations at fetch
    // start so a slow full response cannot clobber fresher slice patches
    // (users_slice / operation_slice / warrant_slice / bulletin_slice /
    // wiki_page_slice); losing keys are stripped before the fan-out (slice
    // setters guard by key). Returns the raw payload so session callers
    // (SessionContext.refreshUser) can read config/currentUser/needsSetup.
    const hydrateFullState = useCallback(async () => {
        const usersGen = guards.users.begin();
        const opsGen = guards.operations.begin();
        const warrantsGen = guards.warrants.begin();
        const bulletinsGen = guards.bulletins.begin();
        const wikiGen = guards.wikiPages.begin();
        const data = await apiService.getInitialState();
        if (!guards.users.tryApply(usersGen)) delete data.users;
        if (!guards.operations.tryApply(opsGen)) delete data.operations;
        if (!guards.warrants.tryApply(warrantsGen)) delete data.warrants;
        if (!guards.bulletins.tryApply(bulletinsGen)) delete data.activeBulletins;
        if (!guards.wikiPages.tryApply(wikiGen)) delete data.wikiPages;
        setStateFromData(data);
        return data;
    }, [setStateFromData, guards]);

    // Lazy-domain gate state — which non-boot domains a view has loaded.
    const loadedLazyDomainsRef = useRef<Set<string>>(new Set());

    const fetchDataSubset = useCallback(async (subset: string, options?: FetchDataSubsetOptions) => {
        // Off-screen skip: realtime-triggered (non-force) fetches for a lazy
        // domain the user never opened are dropped — the view's mount fetch
        // (force) flips the domain live.
        const lazyDomain = LAZY_DOMAINS[subset];
        if (lazyDomain) {
            if (options?.force) loadedLazyDomainsRef.current.add(lazyDomain);
            else if (!loadedLazyDomainsRef.current.has(lazyDomain)) return;
        }

        const isSliceSubset = ROW_SLICE_SUBSETS.has(subset);
        if (!isSliceSubset) {
            const now = Date.now();
            const lastFetch = recentFetchesRef.current.get(subset) || 0;
            // Skip the 2-second dedupe when the caller explicitly requests a
            // fresh fetch — typically a post-mutation refresh chained off an
            // RPC response. The dedupe is there to suppress the broadcast +
            // postgres_changes double-fire for the same DB write; it must not
            // suppress a user-initiated state refresh that may otherwise see
            // a stale UI (e.g. feature toggle "succeeded" but view didn't
            // update because something else fetched 'main' < 2s earlier).
            if (!options?.force && now - lastFetch < 2000) return;
            recentFetchesRef.current.set(subset, now);
        }

        setIsFetching(prev => ({ ...prev, [subset]: true }));
        try {
            if (subset === 'requests' || subset === 'service_requests') {
                // Write through RequestsContext's setter.
                const data = await apiService.getStateSubset('requests');
                setReqsHydrated(data.requests || []);
            } else if (subset === 'operations') {
                // Write through OperationsContext's setters.
                const gen = guards.operations.begin();
                const data = await apiService.getStateSubset('operations');
                if (guards.operations.tryApply(gen)) {
                    setOpsOperations(data.operations || []);
                }
                // else: a fresher operation_slice patch (or newer full fetch)
                // applied while this one was in flight — keep the patched
                // list; templates aren't sliced, so they always apply.
                if (data.operationTemplates) setOpsOperationTemplates(data.operationTemplates);
            } else if (subset === 'users_slice') {
                // Realtime slice path: refetch ONLY the roster rows named by a
                // user_update broadcast and splice them into allUsers, instead
                // of re-pulling the whole 'main' bundle. mergeUsersSlice only
                // ever runs on a successful response — the server endpoint
                // throws on query errors precisely so requested-but-absent can
                // be trusted to mean "deleted", never "DB blip". On error the
                // coalescer drops its pending set and falls back to a full
                // main refetch (non-force — the 2s dedupe still collapses
                // storms).
                const ids = options?.ids;
                if (!ids || ids.length === 0) return;
                if (!userSliceCoalescerRef.current) {
                    userSliceCoalescerRef.current = makeSliceCoalescer<number>(
                        async (batch) => {
                            const gen = guards.users.begin();
                            const data = await apiService.getUsersSlice(batch);
                            if (guards.users.tryApply(gen)) {
                                setMembersAllUsers(prev => mergeUsersSlice(prev, data.users || [], batch));
                            }
                        },
                        (error) => {
                            console.error('users_slice fetch failed; falling back to full main refetch:', error);
                            void fetchDataSubsetRef.current('main');
                        },
                    );
                }
                await userSliceCoalescerRef.current(ids);
            } else if (subset === 'operation_slice') {
                // Realtime slice path: refetch ONLY the list row named by an
                // operation_update broadcast. A null result means deleted or
                // no longer visible (clearance/markers) — the merge removes it.
                const opId = options?.id;
                if (!opId) return;
                if (!opSliceCoalescerRef.current) {
                    opSliceCoalescerRef.current = makeSliceCoalescer<string>(
                        async (batch) => {
                            for (const id of batch) {
                                const gen = guards.operations.begin();
                                const data = await apiService.getOperationSlice(id);
                                if (guards.operations.tryApply(gen)) {
                                    setOpsOperations(prev => mergeRowSlice(prev, data.operation ?? null, id, byCreatedAtDesc));
                                }
                            }
                        },
                        (error) => {
                            console.error('operation_slice fetch failed; falling back to full operations refetch:', error);
                            void fetchDataSubsetRef.current('operations');
                        },
                    );
                }
                await opSliceCoalescerRef.current([opId]);
            } else if (subset === 'operation_templates') {
                // Template-only slice — operation_templates_changed no longer
                // refetches the whole ops list.
                const data = await apiService.getOperationTemplates();
                if (data.operationTemplates) setOpsOperationTemplates(data.operationTemplates);
            } else if (subset === 'warrants') {
                const gen = guards.warrants.begin();
                const data = await apiService.getStateSubset('warrants');
                if (guards.warrants.tryApply(gen)) setOpsWarrants(data.warrants || []);
            } else if (subset === 'warrant_slice') {
                // Realtime slice path: refetch ONLY the warrant row(s) named
                // by a warrant_update broadcast. null = deleted → removed.
                const ids = options?.rowIds ?? (options?.id ? [options.id] : []);
                if (ids.length === 0) return;
                if (!warrantSliceCoalescerRef.current) {
                    warrantSliceCoalescerRef.current = makeSliceCoalescer<string>(
                        async (batch) => {
                            for (const id of batch) {
                                const gen = guards.warrants.begin();
                                const data = await apiService.getStateSubsetWithId('warrant_slice', id);
                                if (guards.warrants.tryApply(gen)) {
                                    // Warrant list rows are issuedAt-descending.
                                    setOpsWarrants(prev => mergeRowSlice(prev, data.warrant ?? null, id, (p, r) => {
                                        const t = new Date(r.issuedAt).getTime();
                                        const i = p.findIndex(o => new Date(o.issuedAt).getTime() < t);
                                        return i === -1 ? p.length : i;
                                    }));
                                }
                            }
                        },
                        (error) => {
                            console.error('warrant_slice fetch failed; falling back to full warrants refetch:', error);
                            void fetchDataSubsetRef.current('warrants');
                        },
                    );
                }
                await warrantSliceCoalescerRef.current(ids);
            } else if (subset === 'intel') {
                // Write through IntelContext's setters. intelDataVersion is a
                // client-side cache buster bumped on every successful 'intel' fetch.
                const sumGen = guards.intelSummary.begin();
                const bullGen = guards.bulletins.begin();
                const data = await apiService.getStateSubset('intel');
                if (guards.intelSummary.tryApply(sumGen)) {
                    if (data.intelTargetIndex) {
                        const m = new Map<string, IntelThreatLevel>();
                        for (const e of data.intelTargetIndex as { targetId: string; threatLevel: IntelThreatLevel }[]) {
                            m.set(e.targetId.toLowerCase(), e.threatLevel);
                        }
                        setIntelCtxTargetIndex(m);
                    }
                    if (data.intelHubStats) setIntelCtxHubStats(data.intelHubStats);
                }
                if (guards.bulletins.tryApply(bullGen)) {
                    if (data.activeBulletins) setIntelCtxActiveBulletins(data.activeBulletins);
                }
                setIntelCtxDataVersion(v => v + 1);
            } else if (subset === 'intel_summary') {
                // Realtime slice path for intel_update {kind:'report'}: the
                // aggregates (target index + hub stats) are full-recompute by
                // nature, but bulletins are untouched by report mutations —
                // this skips re-shipping them. The version bump still fires
                // (IntelligenceView's paginated report feed watches it).
                const gen = guards.intelSummary.begin();
                const data = await apiService.getStateSubset('intel_summary');
                if (guards.intelSummary.tryApply(gen)) {
                    if (data.intelTargetIndex) {
                        const m = new Map<string, IntelThreatLevel>();
                        for (const e of data.intelTargetIndex as { targetId: string; threatLevel: IntelThreatLevel }[]) {
                            m.set(e.targetId.toLowerCase(), e.threatLevel);
                        }
                        setIntelCtxTargetIndex(m);
                    }
                    if (data.intelHubStats) setIntelCtxHubStats(data.intelHubStats);
                    setIntelCtxDataVersion(v => v + 1);
                }
            } else if (subset === 'bulletin_slice') {
                // Realtime slice path: refetch ONLY the clearance-filtered
                // bulletin row named by a bulletin_update broadcast. null =
                // deleted/expired/above-clearance → removed (exactly what the
                // full refetch would have done). No version bump — the feed
                // shows reports, not bulletins.
                const bulletinId = options?.id;
                if (!bulletinId) return;
                if (!bulletinSliceCoalescerRef.current) {
                    bulletinSliceCoalescerRef.current = makeSliceCoalescer<string>(
                        async (batch) => {
                            for (const id of batch) {
                                const gen = guards.bulletins.begin();
                                const data = await apiService.getStateSubsetWithId('bulletin_slice', id);
                                if (guards.bulletins.tryApply(gen)) {
                                    setIntelCtxActiveBulletins(prev => mergeRowSlice(prev, data.bulletin ?? null, id, byCreatedAtDesc));
                                }
                            }
                        },
                        (error) => {
                            console.error('bulletin_slice fetch failed; falling back to full intel refetch:', error);
                            void fetchDataSubsetRef.current('intel');
                        },
                    );
                }
                await bulletinSliceCoalescerRef.current([bulletinId]);
            } else if (subset === 'announcements') {
                // Write through AnnouncementsContext's setter.
                const data = await apiService.getStateSubset('announcements');
                setAnnsAnnouncements(data.announcements || []);
            } else if (subset === 'hr') {
                const data = await apiService.getStateSubset('hr');
                setStateFromData(data);
            } else if (subset === 'wiki') {
                const gen = guards.wikiPages.begin();
                const data = await apiService.getStateSubset('wiki');
                if (guards.wikiPages.tryApply(gen)) {
                    if (data.wikiPages) setWikiPages(data.wikiPages);
                }
            } else if (subset === 'wiki_page_slice') {
                // Realtime slice path: refetch ONLY the clearance-checked page
                // named by a wiki_update broadcast. null = deleted or above
                // the viewer's clearance/markers → removed (exactly what the
                // full refetch would have done).
                const pageId = options?.id;
                if (!pageId) return;
                if (!wikiSliceCoalescerRef.current) {
                    wikiSliceCoalescerRef.current = makeSliceCoalescer<string>(
                        async (batch) => {
                            for (const id of batch) {
                                const gen = guards.wikiPages.begin();
                                const data = await apiService.getStateSubsetWithId('wiki_page_slice', id);
                                if (guards.wikiPages.tryApply(gen)) {
                                    // Wiki list rows are sort_order-ascending.
                                    setWikiPages(prev => mergeRowSlice(prev, data.wikiPage ?? null, id, (p, r) => {
                                        const i = p.findIndex(o => o.sortOrder > r.sortOrder);
                                        return i === -1 ? p.length : i;
                                    }));
                                }
                            }
                        },
                        (error) => {
                            console.error('wiki_page_slice fetch failed; falling back to full wiki refetch:', error);
                            void fetchDataSubsetRef.current('wiki');
                        },
                    );
                }
                await wikiSliceCoalescerRef.current([pageId]);
            } else if (subset === 'users_presence') {
                const data = await apiService.getStateSubset('users_presence');
                const rows: Array<{ userId: number; isDuty: boolean; lastActiveAt: string | null }> = data.usersPresence || [];
                if (rows.length > 0) {
                    const presenceMap = new Map(rows.map((p) => [p.userId, p]));
                    // allUsers slice lives in MembersContext now; write through its setter
                    // so presence updates merge into the canonical user list.
                    setMembersAllUsers((prev) => prev.map((u: any) => {
                        const p = presenceMap.get(u.id);
                        return p ? { ...u, isDuty: p.isDuty, lastActiveAt: p.lastActiveAt } : u;
                    }));
                }
            } else if (subset === 'warehouse') {
                // Route the response through applyStateData; it fans out to
                // Warehouse's three registered slice setters.
                const data = await apiService.getStateSubset('warehouse');
                applyStateData(data);
            } else if (APPLY_STATE_SLICE_SUBSETS.has(subset)) {
                // Per-slice subset refetch (warehouse arrays, government
                // key-groups, ...) — the registered domain slice setters
                // guard by payload key, so the partial payload writes only
                // its own slice.
                const data = await apiService.getStateSubset(subset);
                applyStateData(data);
            } else if (subset === 'discord') {
                const data = await apiService.getStateSubset('discord');
                setStateFromData(data);
            } else if (subset === 'external_tools') {
                const data = await apiService.getStateSubset('external_tools');
                setStateFromData(data);
            } else if (subset === 'fleet') {
                // Route the response through applyStateData; it fans out to
                // Fleet's three registered slice setters.
                const data = await apiService.getStateSubset('fleet');
                applyStateData(data);
            } else if (subset === 'government') {
                // Route the response through applyStateData; it fans out to
                // Government's eight registered slice setters. The `!== undefined`
                // check on governmentConfig (null is valid) lives in the setter.
                const data = await apiService.getStateSubset('government');
                applyStateData(data);
            } else if (subset === 'main') {
                const gen = guards.users.begin();
                const data = await apiService.getStateSubset('main');
                if (!guards.users.tryApply(gen)) {
                    // A fresher users_slice patch (or newer full fetch)
                    // applied while this one was in flight — drop the stale
                    // roster but keep the rest of the payload (slice setters
                    // guard by key, so deleting `users` skips only that write).
                    delete data.users;
                }
                setStateFromData(data);
            } else {
                // Unknown subset → legacy full-state refresh through the
                // guarded hydrator (the payload can carry EVERY guarded array).
                await hydrateFullState();
            }
        } catch (error) {
            console.error(`Failed to fetch subset ${subset}:`, error);
        } finally {
            setIsFetching(prev => ({ ...prev, [subset]: false }));
        }
    }, [setStateFromData, applyStateData, setMembersAllUsers, setOpsOperations, setOpsOperationTemplates, setOpsWarrants, setIntelCtxTargetIndex, setIntelCtxHubStats, setIntelCtxActiveBulletins, setIntelCtxDataVersion, setReqsHydrated, setAnnsAnnouncements, guards, hydrateFullState]);

    // Register fetchDataSubset with DataCore so the realtime channel's
    // broadcast/postgres_changes handlers can dispatch back into our slice
    // setters. Re-registered whenever fetchDataSubset's identity changes
    // (rare — only on setStateFromData updates).
    useEffect(() => {
        registerFetchDataSubset(fetchDataSubset);
        // Slice coalescers persist across re-renders; their error fallbacks
        // read the latest fetchDataSubset through this ref.
        fetchDataSubsetRef.current = fetchDataSubset;
        return () => registerFetchDataSubset(null);
    }, [fetchDataSubset, registerFetchDataSubset]);

    // Mirror current feature-flag values into DataCore so the next channel
    // rebuild attaches/detaches the warehouse and government broadcast
    // listeners according to current org settings. settings_update and
    // features_update broadcasts (handled inside DataCore) trigger a rebuild
    // shortly after these flags update, so toggling a feature on/off picks
    // up the new gating without a page reload.
    useEffect(() => {
        registerFeatureFlags({
            warehouseEnabled: orgMeta?.features?.warehouse?.enabled === true,
            governmentsEnabled: governmentsFeatureConfig?.enabled === true,
            marketplaceEnabled: orgMeta?.features?.marketplace?.enabled === true,
        });
    }, [orgMeta, governmentsFeatureConfig, registerFeatureFlags]);

    // Warm the audio cache for all org-configured sound URLs as soon as
    // brandingConfig lands. Without this, the first time a chime fires
    // (toast, request alert, radio mic cue) the browser stalls fetching
    // and decoding the file, desyncing the sound from the on-screen action.
    useEffect(() => {
        prefetchSounds([
            brandingConfig.bootSoundUrl,
            brandingConfig.newRequestSoundUrl,
            brandingConfig.assignmentSoundUrl,
            brandingConfig.eamSoundUrl,
            brandingConfig.radioMicCueUrl,
            brandingConfig.radioSquelchUrl,
        ]);
    }, [
        brandingConfig.bootSoundUrl,
        brandingConfig.newRequestSoundUrl,
        brandingConfig.assignmentSoundUrl,
        brandingConfig.eamSoundUrl,
        brandingConfig.radioMicCueUrl,
        brandingConfig.radioSquelchUrl,
    ]);

    // Post-action refresh helpers. Every mutation that chains one of these
    // also emits a broadcast (or postgres_changes event) that triggers the
    // same subset refresh — these wrappers are the fallback when the websocket
    // is mid-reconnect or the broadcast is otherwise missed.
    //
    // All wrappers pass `{ force: true }` to bypass fetchDataSubset's 2-second
    // dedupe. The dedupe exists to suppress the broadcast + postgres_changes
    // double-fire from a *single* mutation; it must NOT suppress a deliberate
    // post-mutation refresh that happens to land within 2s of an unrelated
    // realtime event (tab-focus resync, another user's mutation, etc.).
    // Realtime handlers in DataCoreContext call fetchDataSubset directly via
    // callFetcher() without force, so the dedupe still protects that path.
    const refreshRequests = useCallback(() => fetchDataSubset('requests', { force: true }), [fetchDataSubset]);
    const refreshHR = useCallback(() => fetchDataSubset('hr', { force: true }), [fetchDataSubset]);
    const refreshWarrants = useCallback(() => fetchDataSubset('warrants', { force: true }), [fetchDataSubset]);
    const refreshOperations = useCallback(() => fetchDataSubset('operations', { force: true }), [fetchDataSubset]);
    const refreshIntel = useCallback(() => fetchDataSubset('intel', { force: true }), [fetchDataSubset]);
    const refreshAnnouncements = useCallback(() => fetchDataSubset('announcements', { force: true }), [fetchDataSubset]);
    const refreshWiki = useCallback(() => fetchDataSubset('wiki', { force: true }), [fetchDataSubset]);
    const refreshWarehouse = useCallback(() => fetchDataSubset('warehouse', { force: true }), [fetchDataSubset]);
    const refreshFleet = useCallback(() => fetchDataSubset('fleet', { force: true }), [fetchDataSubset]);
    const ensureFleetLoaded = useCallback(() => {
        if (shipCatalog.length === 0) return fetchDataSubset('fleet', { force: true });
        return Promise.resolve();
    }, [shipCatalog.length, fetchDataSubset]);
    const refreshGovernment = useCallback(() => fetchDataSubset('government', { force: true }), [fetchDataSubset]);
    const refreshMainState = useCallback(() => fetchDataSubset('main', { force: true }), [fetchDataSubset]);
    const refreshDiscord = useCallback(() => fetchDataSubset('discord', { force: true }), [fetchDataSubset]);
    const refreshExternalTools = useCallback(() => fetchDataSubset('external_tools', { force: true }), [fetchDataSubset]);

    // Register our refresh callbacks with each domain context so their CRUD
    // methods can trigger post-RPC refreshes without depending on useData()
    // (which would create a context cycle — these contexts mount OUTSIDE Data).
    useEffect(() => {
        const unreg = registerMembersRefreshMain(refreshMainState);
        return unreg;
    }, [registerMembersRefreshMain, refreshMainState]);
    useEffect(() => {
        const unreg = registerMembersRefreshDiscord(refreshDiscord);
        return unreg;
    }, [registerMembersRefreshDiscord, refreshDiscord]);

    useEffect(() => {
        const unreg = registerConfigRefreshMain(refreshMainState);
        return unreg;
    }, [registerConfigRefreshMain, refreshMainState]);
    useEffect(() => {
        const unreg = registerConfigRefreshDiscord(refreshDiscord);
        return unreg;
    }, [registerConfigRefreshDiscord, refreshDiscord]);
    useEffect(() => {
        const unreg = registerConfigRefreshExternalTools(refreshExternalTools);
        return unreg;
    }, [registerConfigRefreshExternalTools, refreshExternalTools]);

    useEffect(() => {
        const unreg = registerOpsRefreshOperations(refreshOperations);
        return unreg;
    }, [registerOpsRefreshOperations, refreshOperations]);
    useEffect(() => {
        const unreg = registerOpsRefreshWarrants(refreshWarrants);
        return unreg;
    }, [registerOpsRefreshWarrants, refreshWarrants]);

    useEffect(() => {
        const unreg = registerIntelRefreshIntel(refreshIntel);
        return unreg;
    }, [registerIntelRefreshIntel, refreshIntel]);

    useEffect(() => {
        const unreg = registerRefreshHR(refreshHR);
        return unreg;
    }, [registerRefreshHR, refreshHR]);

    useEffect(() => {
        const unreg = registerRefreshWarehouse(refreshWarehouse);
        return unreg;
    }, [registerRefreshWarehouse, refreshWarehouse]);

    useEffect(() => {
        const unreg = registerRefreshFleet(refreshFleet);
        return unreg;
    }, [registerRefreshFleet, refreshFleet]);

    useEffect(() => {
        const unreg = registerRefreshGovernment(refreshGovernment);
        return unreg;
    }, [registerRefreshGovernment, refreshGovernment]);

    useEffect(() => {
        const unreg = registerRefreshRequests(refreshRequests);
        return unreg;
    }, [registerRefreshRequests, refreshRequests]);

    useEffect(() => {
        const unreg = registerRefreshAnnouncements(refreshAnnouncements);
        return unreg;
    }, [registerRefreshAnnouncements, refreshAnnouncements]);

    // Members and Config domain CRUD live in their own contexts; they're
    // destructured from use*() at the top of this provider and re-exposed below.

    const reorderWikiPages = useCallback((pages: { id: string; sortOrder: number }[]) => rpcAction('wiki:reorder_pages', { pages }).then(() => fetchDataSubset('wiki')), [rpcAction, fetchDataSubset]);

    // Bulletin CRUD lives in IntelContext; destructured above and re-exposed below.

    const broadcastEAM = useCallback((message: string) => rpcAction('broadcast:eam', { message }), [rpcAction]);

    const fetchUserDetail = useCallback(async (userId: number): Promise<User | null> => {
        try {
            const userData = await apiService.getUserDetail(userId);
            if (userData) return userData as User; // Already mapped by server-side toUser()
            return null;
        } catch (e) {
            console.error(`[DataContext] Failed to fetch user detail for ${userId}:`, e);
            return null;
        }
    }, []);

    const getReputationHistory = useCallback((userId: number) => rpcAction('admin:get_rep_history', { targetUserId: userId }), [rpcAction]);
    const getRatingHistory = useCallback((userId: number) => rpcAction('admin:get_rating_history', { userId }), [rpcAction]);
    const getClearanceHistory = useCallback((userId: number) => rpcAction('user:get_clearance_history', { userId }), [rpcAction]);
    const getPositionHistory = useCallback((targetUserId: number) =>
        rpcAction('user:get_position_history', { targetUserId }) as Promise<import('../types').PositionHistoryEntry[]>,
    [rpcAction]);



    const value = useMemo(() => ({
        allUsers, users: allUsers, members: derivedMembers, ranks, units, roles, announcements, hydratedServiceRequests, intelTargetIndex, intelHubStats, intelDataVersion, activeBulletins, operations, operationTemplates, warrants, externalTools, radioChannels, locations,
        shipCatalog, userShips, fleetGroups,
        governmentConfig, governmentBranches, governmentPositions, governmentPositionHolders, governmentElections, governmentLegislation, governmentMotions, governmentsFeatureConfig, refreshGovernment,
        securityClearances, limitingMarkers, specializationTags, certifications, commendations,
        brandingConfig, discordConfig, heroCardConfig, openGraphConfig, radioConfig, aiConfig, wikiHomeConfig, hrConfig, publicPageConfig, serviceTypes,
        hrApplicants, hrInterviews, hrJobs, hrTemplates, hrTransfers, hrPositions, setHrJobs,
        wikiPages,
        warehouseCatalog, warehouseStock, warehouseRequests,
        syncedDiscordRoles, rankMappings, roleMappings, orgMeta, platformSettings,
        rpcAction, notifyDbConnected, setStateFromData, hydrateFullState, refreshRequests, refreshHR, refreshMainState, refreshWarrants, refreshOperations, refreshIntel, refreshAnnouncements, refreshWiki, refreshWarehouse, refreshFleet, ensureFleetLoaded,
        createOperationTemplate, updateOperationTemplate, deleteOperationTemplate, extractTemplateFromOperation, importOperationTemplate,
        fetchUserDetail,
        createBulletin, deleteBulletin,
        addUnit, updateUnit, deleteUnit,
        addRank, updateRank, deleteRank,
        addRole, updateRole, deleteRole, getRoleDetails, updateRolePermissions,
        addLocation, updateLocation, deleteLocation, seedDefaultLocations,
        addServiceType, updateServiceType, deleteServiceType,
        addExternalTool, updateExternalTool, deleteExternalTool, reorderExternalTool,
        addSpecializationTag, updateSpecializationTag, deleteSpecializationTag,
        addCertification, updateCertification, deleteCertification,
        addCommendation, updateCommendation, deleteCommendation,
        deleteRadioChannel,
        updateDiscordConfig, updateHeroCardConfig, updateBrandingConfig, updateOpenGraphConfig, updateRadioConfig, updateAIConfig, updateWikiHomeConfig, reorderWikiPages, updateSystemConfig, updatePublicPageConfig, listTestimonialCandidates,
        updateOrgFeatures,
        syncDiscordRoles, updateRankMapping,
        broadcastEAM,
        getReputationHistory, getRatingHistory, getClearanceHistory, getPositionHistory,
        isFetching, optimisticUpdate
    }), [
        allUsers, derivedMembers, ranks, units, roles, announcements, hydratedServiceRequests, intelTargetIndex, intelHubStats, intelDataVersion, activeBulletins, operations, operationTemplates, warrants, externalTools, radioChannels, locations,
        shipCatalog, userShips, fleetGroups,
        governmentConfig, governmentBranches, governmentPositions, governmentPositionHolders, governmentElections, governmentLegislation, governmentMotions, governmentsFeatureConfig, refreshGovernment,
        securityClearances, limitingMarkers, specializationTags, certifications, commendations,
        brandingConfig, discordConfig, heroCardConfig, openGraphConfig, radioConfig, aiConfig, wikiHomeConfig, hrConfig, publicPageConfig, serviceTypes,
        hrApplicants, hrInterviews, hrJobs, hrTemplates, hrTransfers, hrPositions, setHrJobs,
        wikiPages,
        warehouseCatalog, warehouseStock, warehouseRequests,
        syncedDiscordRoles, rankMappings, roleMappings, orgMeta, platformSettings,
        rpcAction, notifyDbConnected, setStateFromData, hydrateFullState, refreshRequests, refreshHR, refreshMainState, refreshWarrants, refreshOperations, refreshIntel, refreshAnnouncements, refreshWiki, refreshWarehouse, refreshFleet, ensureFleetLoaded,
        createOperationTemplate, updateOperationTemplate, deleteOperationTemplate, extractTemplateFromOperation, importOperationTemplate,
        fetchUserDetail,
        createBulletin, deleteBulletin,
        addUnit, updateUnit, deleteUnit,
        addRank, updateRank, deleteRank,
        addRole, updateRole, deleteRole, getRoleDetails, updateRolePermissions,
        addLocation, updateLocation, deleteLocation, seedDefaultLocations,
        addServiceType, updateServiceType, deleteServiceType,
        addExternalTool, updateExternalTool, deleteExternalTool, reorderExternalTool,
        addSpecializationTag, updateSpecializationTag, deleteSpecializationTag,
        addCertification, updateCertification, deleteCertification,
        addCommendation, updateCommendation, deleteCommendation,
        deleteRadioChannel,
        updateDiscordConfig, updateHeroCardConfig, updateBrandingConfig, updateOpenGraphConfig, updateRadioConfig, updateAIConfig, updateWikiHomeConfig, reorderWikiPages, updateSystemConfig, updatePublicPageConfig, listTestimonialCandidates,
        updateOrgFeatures,
        syncDiscordRoles, updateRankMapping,
        broadcastEAM,
        getReputationHistory, getRatingHistory, getClearanceHistory, getPositionHistory,
        isFetching, optimisticUpdate
    ]);

    return <DataContext value={value}>{children}</DataContext>;
};

export const useData = () => {
    const context = use(DataContext);
    if (!context) {
        throw new Error('useData must be used within a DataProvider');
    }
    return context;
};
