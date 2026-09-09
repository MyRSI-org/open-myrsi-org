// DataCoreContext owns the RPC dispatcher + realtime subscription
// infrastructure. Domain contexts plug in via the registration API below so
// DataCore's broadcast handlers can dispatch to the right slice without knowing
// the slice shapes.
//
// DataCore owns:
//   - rpcAction / simpleAction
//   - the supabase realtime channel lifecycle (build, teardown, rebuild on
//     settings/features updates, tab-visibility resync, idle disconnect)
//   - realtimeConnected state
//
// DataContext owns the fetchDataSubset implementation, the isFetching map,
// optimisticUpdate, and every domain's state slice; it registers its
// fetchDataSubset (and current feature-flag values) with DataCore at mount.

import React, { createContext, use, useCallback, useEffect, useRef, useState } from 'react';
import apiService from '../services/apiService';
import { getSupabase } from '../lib/supabaseClient';
// Realtime broadcast handlers below log their (own-org) payloads for debugging.
// Routed through the DEV-only logger so payloads never reach a prod DevTools console.
import { debugLog } from '../lib/debugLog';
import { permissionSatisfied } from '../lib/permissionImplications';
import { mayReceiveRoster } from '../lib/rosterGate';
import { makeSerialRunner } from '../lib/serialRunner';

/** Options passed through callFetcher to the registered fetcher.
 *  `ids`/`id` carry the affected row id(s) parsed from a broadcast payload so
 *  the fetcher can do a slice fetch (users_slice / operation_slice) instead
 *  of a whole-subset refetch. DataCore itself never interprets them. */
export interface FetchDataSubsetOptions {
    force?: boolean;
    ids?: number[];
    id?: string;
    /** Multiple string row ids (e.g. bulk warrant deletions). */
    rowIds?: string[];
}
type FetchDataSubset = (subset: string, options?: FetchDataSubsetOptions) => Promise<void> | void;
/** Called by DataCore when bulk state data arrives (e.g. from a 'main' subset
 *  fetch). Each domain registers a setter that applies its slice of the data
 *  payload, replacing the giant `setStateFromData` switch in DataContext. */
type SliceSetter = (data: any) => void;

interface DataCoreFeatureFlags {
    warehouseEnabled: boolean;
    governmentsEnabled: boolean;
    marketplaceEnabled: boolean;
}

export interface DataCoreContextValue {
    /** RPC dispatcher used by every CRUD method across the app. */
    rpcAction: (action: string, payload?: any) => Promise<any>;
    /** Thin wrapper around `apiService.rpc` with optional post-call refresh.
     *  Returns the response `.data` payload. Errors are logged then re-thrown
     *  so callers can chain `.then(refresh)` for the happy path while modal
     *  forms catch and surface failure. */
    simpleAction: (action: string, payload?: any, refresh?: (() => void | Promise<void>) | boolean) => Promise<any>;
    /** True once the supabase realtime channel has subscribed; flips false on CLOSED/TIMED_OUT/CHANNEL_ERROR. */
    realtimeConnected: boolean;
    /** Build (or rebuild) the realtime channel. */
    notifyDbConnected: () => Promise<void>;
    /** DataContext registers its fetchDataSubset here; realtime handlers read
     *  fetcherRef.current at event-time, so the registration can land after
     *  the channel is built without losing events. Re-registration is safe.
     *  Treated as a fallback once per-subset fetchers are registered. */
    registerFetchDataSubset: (fn: FetchDataSubset | null) => void;
    /** DataContext registers current feature-flag values here so the channel
     *  builder can decide whether to attach warehouse:* / government_update
     *  broadcast listeners. Re-call this whenever orgMeta / governmentsConfig
     *  change; the next channel rebuild picks up the new values. */
    registerFeatureFlags: (flags: DataCoreFeatureFlags) => void;
    /** SessionContext registers the per-user realtime token (private-channel
     *  auth) + permission set; changes trigger a channel rebuild so handler
     *  gating tracks the current identity. (null, [], '') on logout. */
    registerRealtimeAuth: (token: string | null, permissions: string[], role: string) => void;
    /** Per-subset fetcher registry. Domain contexts call this at mount to claim
     *  ownership of their subset; DataCore's dispatcher prefers a specific
     *  fetcher over the single fallback registered via registerFetchDataSubset.
     *  Returns an unregister function. */
    registerSubsetFetcher: (subset: string, fetcher: FetchDataSubset) => () => void;
    /** Slice-setter registry. Domain contexts register a setter that applies
     *  their slice of a bulk state payload (e.g. the response from a 'main'
     *  fetch). `applyStateData(data)` iterates all registered setters.
     *  Returns an unregister function. */
    registerSliceSetter: (key: string, setter: SliceSetter) => () => void;
    /** Dispatch a bulk state payload through every registered slice setter.
     *  Called by DataContext's fetchDataSubset('main') and the initial-state
     *  hydrate path. Order of dispatch follows registration insertion. */
    applyStateData: (data: any) => void;
    /** Per-table postgres_changes mapping registry. Domain contexts call this
     *  at mount to add table → subset dispatch rules beyond the hardcoded list
     *  inside notifyDbConnected. The rebuild on settings_update /
     *  features_update picks up new registrations.
     *  CONTRACT: do NOT re-register tables already in the hardcoded list —
     *  it would cause double-fires. Returns an unregister function. */
    registerTableHandler: (table: string, subset: string) => () => void;
}

const DataCoreContext = createContext<DataCoreContextValue | null>(null);

/**
 * Parse a `{ slices: [...] }` discriminator payload from a domain broadcast
 * (government_update / hr_update / fleet_update) into the per-slice subset
 * names to refetch. Returns null when the payload is absent, malformed, or
 * names an unrecognized slice — callers then fall back to the full-bundle
 * refetch (fail-open to freshness, never to staleness).
 */
function parseSlicePayload(payload: unknown, sliceToSubset: Record<string, string>): string[] | null {
    const slices = (payload as { slices?: unknown } | null | undefined)?.slices;
    if (!Array.isArray(slices) || slices.length === 0) return null;
    const subsets: string[] = [];
    for (const s of slices) {
        const subset = typeof s === 'string' ? sliceToSubset[s] : undefined;
        if (!subset) return null;
        subsets.push(subset);
    }
    return subsets;
}

const GOVERNMENT_SLICE_SUBSETS: Record<string, string> = {
    structure: 'government_structure',
    elections: 'government_elections',
    legislation: 'government_legislation',
    motions: 'government_motions',
};

const HR_SLICE_SUBSETS: Record<string, string> = {
    applicants: 'hr_applicants',
    interviews: 'hr_interviews',
    jobs: 'hr_jobs',
    templates: 'hr_templates',
    transfers: 'hr_transfers',
    positions: 'hr_positions',
};

const FLEET_SLICE_SUBSETS: Record<string, string> = {
    catalog: 'fleet_catalog',
    user_ships: 'fleet_user_ships',
    groups: 'fleet_groups',
};

/**
 * THE ONE RESYNC SET. Both recovery paths — the SUBSCRIBED "wasDisconnected" branch and the
 * >30s tab-visibility handler — go through resyncHotSubsets(), so they cannot drift. They used
 * to be two hand-written lists that happened to agree; agreeing by coincidence is how they
 * stop agreeing.
 *
 * The permission gates here are a ROUND-TRIP SAVER, not a boundary: every subset below has a
 * SUBSET_REQUIRED_PERMISSION entry in api/query.ts and 403s server-side regardless. A
 * client-side filter is cosmetic (rule 2).
 *
 * Fetched NON-FORCE, deliberately, and it is load-bearing: DataContext's LAZY_DOMAINS gate
 * ADDS a domain to loadedLazyDomains on a {force:true} fetch, so forcing a lazy subset here
 * would permanently switch on off-screen hydration for a domain the user never opened —
 * straight through rule 3. Non-force is dropped for an unopened lazy domain and runs for an
 * opened one, which is exactly what is wanted with no extra logic.
 *
 * Module scope, not component scope: react-hooks/exhaustive-deps is an ERROR here and would
 * demand a component-scope array in the dep list, where a fresh literal each render defeats
 * the memo. Same placement as HR_SLICE_SUBSETS / FLEET_SLICE_SUBSETS above.
 */
const RESYNC_SUBSETS: ReadonlyArray<{ subset: string; perm: string | null; flag: 'warehouse' | 'governments' | null }> = [
    { subset: 'main', perm: null, flag: null },
    { subset: 'requests', perm: null, flag: null },
    { subset: 'announcements', perm: null, flag: null },
    // NOT in the realtime publication, so the broadcast nudge is its only live carrier — a
    // nudge missed while disconnected is missed until the next reload. The clearest of the
    // four gaps.
    { subset: 'external_tools', perm: null, flag: null },
    { subset: 'operations', perm: 'operations:view', flag: null },
    // The other three always-hydrated domains the two recovery paths both missed.
    { subset: 'warrants', perm: 'warrant:view', flag: null },
    { subset: 'intel', perm: 'intel:view', flag: null },
    { subset: 'hr', perm: 'hr:view', flag: null },
    // Lazy domains: LAZY_DOMAINS drops these for a user who never opened the view, so listing
    // them recovers exactly the ones on screen and costs nothing for the rest.
    { subset: 'wiki', perm: 'wiki:view', flag: null },
    { subset: 'fleet', perm: 'fleet:view', flag: null },
    { subset: 'academy', perm: 'academy:view', flag: null },
    { subset: 'warehouse', perm: 'warehouse:view', flag: 'warehouse' },
    { subset: 'government', perm: 'gov:view', flag: 'governments' },
];

export const DataCoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [realtimeConnected, setRealtimeConnected] = useState(false);
    const realtimeConnectedRef = useRef(false);
    const wasEverConnectedRef = useRef(false);

    // Cleanup is async because the rebuild path MUST await supabase-js's
    // removeChannel before re-creating a channel of the same name — otherwise
    // supabase.channel(name) returns the still-leaving prior channel reference
    // and the new .on()/.subscribe() are attached to a corpse.
    const currentChannelCleanupRef = useRef<(() => Promise<void>) | null>(null);

    // Monotonic build id. A subscribe callback belonging to a superseded build must not write
    // the shared connection refs — today that is safe only by accident of phoenix's hook
    // ordering, which is exactly the kind of accidental correctness this removes.
    const buildGenRef = useRef(0);
    // Set while WE are tearing the channel down to rebuild it, so the next SUBSCRIBED is not
    // mistaken for a reconnect and does not trigger a full resync.
    const deliberateTeardownRef = useRef(false);
    // Serializes every channel rebuild. useState lazy initializer rather than a ref written
    // during render — same reasoning DataContext records for its `guards`.
    const [rebuildQueue] = useState(() => makeSerialRunner((e) => console.error('[DataCore] channel rebuild failed', e)));

    // Registration refs. Channel handlers read these at event-time, not at
    // channel-build-time, so registration order doesn't matter and re-renders
    // in DataContext don't invalidate the channel.
    const fetcherRef = useRef<FetchDataSubset | null>(null);
    const warehouseEnabledRef = useRef<boolean>(false);
    const governmentsEnabledRef = useRef<boolean>(false);
    const marketplaceEnabledRef = useRef<boolean>(false);

    // Realtime auth: every broadcast channel is PRIVATE (Supabase Realtime
    // Authorization) — subscribing requires the per-user JWT the server mints
    // into the boot payload (realtimeToken). Without it there is NO channel
    // (fail-closed: no realtime, no metadata exposure). The permission set gates
    // which event handlers are even ATTACHED, so a member without hr:view never
    // fires (and 403s on) an hr refetch for every HR mutation in the org.
    // SessionContext registers these after boot/login and on any permission
    // change; registration triggers a channel rebuild.
    const realtimeTokenRef = useRef<string | null>(null);
    const permissionsRef = useRef<Set<string>>(new Set());
    const isAdminRef = useRef(false);
    const realtimeAuthKeyRef = useRef('');

    // Domain contexts register here at mount so DataCore can dispatch to
    // specific fetchers/setters/tables without knowing the slice shapes. Stored
    // in refs so registrations are visible to realtime handlers immediately
    // without forcing a channel rebuild.
    const subsetFetchersRef = useRef<Map<string, FetchDataSubset>>(new Map());
    const sliceSettersRef = useRef<Map<string, SliceSetter>>(new Map());
    const tableHandlersRef = useRef<Array<[string, string]>>([]);

    // Refs shared between notifyDbConnected and the idle-disconnect effect.
    const idleDisconnectTimerRef = useRef<number | null>(null);
    const idleDisconnectedRef = useRef<boolean>(false);

    // Holds the latest notifyDbConnected so its own rebuild paths (the
    // not-ready retry and the settings/features rebuild handlers) can re-invoke
    // it without an in-body self-reference. The callback is memoized on the
    // stable callFetcher, so the ref target is effectively constant; routing the
    // recursion through it keeps the behavior identical while avoiding the
    // compiler's access-before-declaration mis-read of the self-reference.
    const notifyDbConnectedRef = useRef<() => Promise<void>>(() => Promise.resolve());

    const rpcAction = useCallback(async (action: string, payload: any = {}) => {
        try {
            const res = await apiService.rpc(action, payload);
            return res.data;
        } catch (e) {
            console.error(`RPC ${action} failed:`, e);
            throw e;
        }
    }, []);

    // The third parameter accepts a refresh callback (or the legacy `true`
    // shorthand for "refresh the current user after success"); Session passes
    // its refreshUser for the `true` case so DataCore needn't know Session state.
    const simpleAction = useCallback(async (
        action: string,
        payload: any = {},
        refresh: (() => void | Promise<void>) | boolean = false,
    ) => {
        try {
            const res = await apiService.rpc(action, payload);
            if (typeof refresh === 'function') await refresh();
            return res.data;
        } catch (e) {
            console.error(`${action} failed`, e);
            throw e;
        }
    }, []);

    const callFetcher = useCallback((subset: string, options?: FetchDataSubsetOptions) => {
        // Prefer a per-subset registered fetcher (domain context) over the
        // single fallback fetcher.
        const specific = subsetFetchersRef.current.get(subset);
        if (specific) {
            void specific(subset, options);
            return;
        }
        const fn = fetcherRef.current;
        if (!fn) {
            // Pre-registration window — should not happen in practice because
            // DataContext registers synchronously on mount before any external
            // caller invokes notifyDbConnected, but guard anyway so a missed
            // registration logs instead of crashing the channel handler.
            console.warn(`[DataCore] fetchDataSubset not registered yet; dropping ${subset} dispatch.`);
            return;
        }
        void fn(subset, options);
    }, []);

    // Declared ABOVE buildChannel: both are read from its body, and exhaustive-deps is an
    // error here, so they must exist before the dep array that names them.
    //
    // A FUNCTION, not a captured const: the refs are read at CALL time, so handlers registered
    // during a build consult the current values afterwards. permissionSatisfied applies the
    // shared implication table so this cannot drift from the server's read gate.
    const hasPermNow = useCallback(
        (p: string) => isAdminRef.current || permissionSatisfied([...permissionsRef.current], p),
        [],
    );

    /** Re-fetch the hot subsets after losing and regaining live updates. The single
     *  implementation behind both recovery paths — see RESYNC_SUBSETS. */
    const resyncHotSubsets = useCallback(() => {
        const flags = { warehouse: warehouseEnabledRef.current, governments: governmentsEnabledRef.current };
        for (const { subset, perm, flag } of RESYNC_SUBSETS) {
            if (flag && !flags[flag]) continue;
            if (perm && !hasPermNow(perm)) continue;
            callFetcher(subset);
        }
    }, [callFetcher, hasPermNow]);

    const buildChannel = useCallback(async () => {
        // Tear down any existing channel before building a fresh one. The
        // await is load-bearing: supabase-js's removeChannel is async, and
        // calling supabase.channel(name) before the prior leave completes
        // returns the still-leaving reference (which then refuses .on()
        // after its own .subscribe() lock). This rebuild path runs on
        // settings_update, features_update, and idle-refocus.
        if (currentChannelCleanupRef.current) {
            // Mark the teardown as OURS before it runs. Without this, every rebuild looks like
            // a reconnect to the SUBSCRIBED branch below (cleanup sets realtimeConnectedRef
            // false), so the resync fired on every settings save, permission change and duty
            // toggle — and with the widened subset list that is a real fetch storm, not a
            // rounding error. A genuine drop still resyncs, and an idle-refocus rebuild is
            // covered by the visibility handler (its 5-minute threshold always exceeds the
            // 30-second one).
            deliberateTeardownRef.current = true;
            try { await currentChannelCleanupRef.current(); } catch (e) { console.warn('[DataCore] cleanup failed', e); }
            currentChannelCleanupRef.current = null;
        }
        // The serializer (makeSerialRunner) is what prevents two builds overlapping now; this
        // only short-circuits a redundant rebuild of an already-live channel. It never
        // serialized anything: realtimeConnectedRef only turns true inside the subscribe
        // CALLBACK, which needs a server round trip, so a second caller always read false.
        if (realtimeConnectedRef.current) return;
        const supabase = getSupabase();

        if (!supabase) {
            console.warn('[DataCore] Supabase client not ready yet. Realtime subscription delayed.');
            setTimeout(() => {
                const retrySupabase = getSupabase();
                if (retrySupabase && !realtimeConnectedRef.current) void notifyDbConnectedRef.current();
            }, 1000);
            return;
        }

        // Private channels require the per-user realtime token. No token
        // (logged out, or SUPABASE_JWT_SECRET unset server-side) → no channel
        // at all — fail-closed.
        const realtimeToken = realtimeTokenRef.current;
        if (!realtimeToken) {
            debugLog('[DataCore] No realtime token — private channels unavailable; realtime disabled (fail-closed).');
            return;
        }
        try {
            await supabase.realtime.setAuth(realtimeToken);
        } catch (e) {
            console.warn('[DataCore] realtime setAuth failed — realtime disabled.', e);
            return;
        }

        // Channel name MUST match the server's broadcastToOrg() format in
        // lib/db/common.ts exactly — Supabase Realtime routes broadcast
        // events by channel-name string, so any drift here silently drops
        // every cross-tab/cross-user broadcast (request_update,
        // operation_update, intel_update, ...).
        const channelName = 'db-changes';
        debugLog(`[DataCore] Initializing Realtime Subscription on channel: ${channelName}`);

        // Read current feature flags via refs — these are kept in sync by
        // DataContext via registerFeatureFlags. Optional features (warehouse,
        // government) only get their broadcast listeners registered when the
        // org has the feature enabled, eliminating wasted refetches across
        // orgs that don't use them. Channel is rebuilt on settings_update so
        // toggling a feature on/off picks up the new gating without a page
        // reload.
        const warehouseEnabled = warehouseEnabledRef.current;
        const governmentsEnabled = governmentsEnabledRef.current;
        const marketplaceEnabled = marketplaceEnabledRef.current;

        // Permission gate for handler ATTACHMENT (same idea as the feature
        // flags): events whose refetch path is permission-gated server-side
        // only get a listener when this user holds the permission — otherwise
        // every org mutation in that domain costs this browser a denied
        // round-trip. Admins hold everything.
        // permissionSatisfied applies the shared implication table
        // (lib/permissionImplications.ts) so attachment matches the server's read
        // gate: intel:view:clearance satisfies intel:view (this line used to be a
        // fourth hand-inlined copy of that rule), and academy:instruct /
        // academy:manage satisfy the academy:view handler below. The ref is read at
        // call time — handlers registered here consult it after the channel is built.
        const hasPerm = hasPermNow;
        // Same predicate as the server's getMainState / users_slice / user_detail gate.
        // Non-staff viewers hold no roster and no taxonomy, so subscribing them to
        // roster and reference-table changes is a wasted round-trip at best and, for
        // postgres_changes (which ships the FULL changed row), a delivery of content to
        // a receiver who may not read it.
        //
        // A FUNCTION, not a captured const: the refs are read at CALL time so handlers
        // registered here consult them after the channel is built (see hasPerm above).
        // A frozen const would be correct only by coincidence — because
        // registerRealtimeAuth happens to rebuild the channel — in a file whose own
        // comment warns against exactly that.
        //
        // THIS IS NOT THE SECURITY BOUNDARY. Per CLAUDE.md rule 2 a client-side filter
        // is cosmetic; the delivery authorization lives in schema.sql's
        // authenticated_select policy, which Phase 3 item 7 narrows. What this closes is
        // "the app stops STREAMING taxonomy rows to a customer", not "the taxonomy is
        // closed". Do not write the stronger claim anywhere.
        // The SAME three-part predicate the server runs (lib/rosterGate.ts), so the
        // handler-attachment set and the server's projection cannot disagree: a
        // roster-authority role (hr:recruiter, admin:view:roster, …) that receives the
        // roster from getMainState must also stay subscribed to its changes.
        const isStaffViewer = () => isAdminRef.current
            || mayReceiveRoster({ permissions: [...permissionsRef.current] });
        const canSeeIntel = hasPerm('intel:view');

        let channel = supabase.channel(channelName, { config: { private: true } })
            .on('broadcast', { event: 'duty_update' }, () => {
                debugLog('[Realtime] Duty Update Broadcast Received');
                callFetcher('users_presence');
            })
            .on('broadcast', { event: 'new_request' }, (payload) => {
                debugLog('[Realtime] New Request Broadcast Received', payload);
                callFetcher('service_requests');
                // Re-emit to NotificationListener (toast/sound side-effects).
                // NotificationListener cannot subscribe to this channel directly:
                // supabase-js singleton-shares channel objects by name, and
                // adding `.on()` to a channel that's already `.subscribe()`d
                // throws ("cannot add callbacks ... after subscribe()").
                window.dispatchEvent(new CustomEvent('app:realtime:new-request', { detail: payload.payload }));
            })
            .on('broadcast', { event: 'request_update' }, (payload) => {
                debugLog('[Realtime] Request Update Broadcast Received', payload);
                callFetcher('service_requests');
                window.dispatchEvent(new CustomEvent('app:realtime:request-update', { detail: payload.payload }));
            })
            .on('broadcast', { event: 'request_delete' }, (payload) => {
                debugLog('[Realtime] Request Delete Broadcast Received', payload);
                callFetcher('service_requests');
            })
            .on('broadcast', { event: 'responder_change' }, (payload) => {
                // Replaces the postgres_changes INSERT listener on
                // request_responders that went silent when add-user-presence.sql
                // dropped the junction table from supabase_realtime. Both
                // AuthContext (self-assignment toast) and NotificationListener
                // (client + peer-staff toasts) consume this window event.
                debugLog('[Realtime] Responder Change Broadcast Received', payload);
                window.dispatchEvent(new CustomEvent('app:realtime:responder-change', { detail: payload.payload }));
            });

        // --- PERMISSION-GATED HANDLERS ---
        // Attached only when this user can actually consume the refetch:
        // the corresponding query subsets are permission-gated server-side,
        // so an unprivileged listener would burn a denied round-trip on
        // every org mutation in the domain. Rebuilt on permission change via
        // registerRealtimeAuth.
        if (hasPerm('operations:view')) {
            channel = channel
                .on('broadcast', { event: 'operation_update' }, (payload) => {
                    debugLog('[Realtime] Operation Update Broadcast Received', payload);
                    // Slice path: every server emit carries the operationId, so
                    // refetch ONLY that list row (operation_slice) instead of the
                    // whole ops list. The id-less fallback keeps the legacy full
                    // refetch for any emit that ever drops the id.
                    const opId = (payload.payload as { operationId?: string } | undefined)?.operationId;
                    if (typeof opId === 'string' && opId) callFetcher('operation_slice', { id: opId });
                    else callFetcher('operations');
                    // OperationDetailView holds its own per-op `fullDetails` state
                    // (boardElements, phases, tasks, command nodes, logistics, AAR)
                    // populated by `operation:get_details` — none of which live on
                    // the operations subset above. Without this signal, those
                    // sub-resources stay stale on remote edits until the local user
                    // makes their own edit.
                    window.dispatchEvent(new CustomEvent('app:realtime:operation-detail-refresh', { detail: payload.payload }));
                })
                .on('broadcast', { event: 'operation_templates_changed' }, () => {
                    debugLog('[Realtime] Operation Templates Broadcast Received');
                    // Templates are a tiny standalone slice — don't refetch the
                    // whole ops list just to pick up a template change.
                    callFetcher('operation_templates');
                });
        }
        if (hasPerm('warrant:view')) {
            channel = channel
                .on('broadcast', { event: 'warrant_update' }, (payload) => {
                    debugLog('[Realtime] Warrant Update Broadcast Received');
                    // Slice path: emits carry warrantId (single) or warrantIds
                    // (bulk delete); refetch ONLY those rows. Id-less payloads
                    // keep the full refetch.
                    const p = (payload.payload ?? {}) as { warrantId?: string; warrantIds?: string[] };
                    const rowIds = Array.isArray(p.warrantIds)
                        ? p.warrantIds.filter((s): s is string => typeof s === 'string')
                        : (typeof p.warrantId === 'string' && p.warrantId ? [p.warrantId] : []);
                    if (rowIds.length > 0) callFetcher('warrant_slice', { rowIds });
                    else callFetcher('warrants');
                    // WarrantDetailModal listens for this to re-pull the
                    // notes thread without a full subset re-fetch on its own.
                    window.dispatchEvent(new CustomEvent('app:warrant-notes-refresh'));
                });
        }
        if (hasPerm('alliance:manage') || hasPerm('alliance:view')) {
            channel = channel
                .on('broadcast', { event: 'alliance_update' }, (payload) => {
                    debugLog('[Realtime] Alliance Update Broadcast Received', payload);
                    // No query subset owns alliance peers (the admin tab and the
                    // member directory load via RPCs), so relay a window event;
                    // mounted alliance views re-pull through their gated RPCs.
                    // Live-sync health/alert transitions ride this (ids only).
                    window.dispatchEvent(new CustomEvent('app:realtime:alliance-update', { detail: payload.payload }));
                });
        }
        if (canSeeIntel) {
            channel = channel
                .on('broadcast', { event: 'intel_update' }, (payload) => {
                    debugLog('[Realtime] Intel Update Broadcast Received');
                    // Kind discriminator:
                    //  - 'dossier': cached dossier summary changed — RPC-fetched
                    //    on demand, rides neither the intel subset nor the feed →
                    //    nothing to refetch;
                    //  - 'report': refetch only the aggregates (intel_summary —
                    //    its branch also bumps intelDataVersion, which is what
                    //    IntelligenceView watches to refresh its paginated feed
                    //    or surface the "X new reports" pill);
                    //  - absent/unknown: legacy full refetch (also bumps).
                    const kind = (payload.payload as { kind?: string } | undefined)?.kind;
                    if (kind === 'dossier') return;
                    if (kind === 'report') callFetcher('intel_summary');
                    else callFetcher('intel');
                })
                .on('broadcast', { event: 'bulletin_update' }, (payload) => {
                    debugLog('[Realtime] Bulletin Update Broadcast Received');
                    // Slice path: create/delete emits carry bulletinId; refetch
                    // ONLY that clearance-filtered row (null → remove). Bulletins
                    // don't feed the intel aggregates, so no intel_summary fetch.
                    const bid = (payload.payload as { bulletinId?: string } | undefined)?.bulletinId;
                    if (typeof bid === 'string' && bid) callFetcher('bulletin_slice', { id: bid });
                    else callFetcher('intel');
                    window.dispatchEvent(new CustomEvent('app:realtime:bulletin-update', { detail: payload.payload }));
                });
        }
        if (hasPerm('hr:view')) {
            channel = channel
                .on('broadcast', { event: 'hr_update' }, (payload) => {
                    debugLog('[Realtime] HR Update Broadcast Received');
                    // Slice path: emits carry {slices:[...]} naming the touched
                    // array(s) so one HR mutation refetches one array instead of
                    // all six. Slice-less payloads keep the full refetch.
                    const subsets = parseSlicePayload(payload.payload, HR_SLICE_SUBSETS);
                    if (subsets) for (const s of subsets) callFetcher(s);
                    else callFetcher('hr');
                });
        }
        if (hasPerm('wiki:view')) {
            channel = channel
                .on('broadcast', { event: 'wiki_update' }, (payload) => {
                    debugLog('[Realtime] Wiki Update Broadcast Received');
                    // Slice path: page CRUD carries the pageId; refetch ONLY that
                    // clearance-checked page instead of the whole body-bearing
                    // list. Id-less payloads (reorder/import) keep the full
                    // refetch.
                    const pageId = (payload.payload as { pageId?: string } | undefined)?.pageId;
                    if (typeof pageId === 'string' && pageId) callFetcher('wiki_page_slice', { id: pageId });
                    else callFetcher('wiki');
                });
        }

        channel = channel
            .on('broadcast', { event: 'user_update' }, (payload) => {
                debugLog('[Realtime] User Update Broadcast Received');
                // Slice path: single-row emits carry userId; bulk emits carry
                // userIds (the successfully-updated ids). When present,
                // refetch ONLY those roster rows (users_slice) instead of the
                // whole 'main' bundle. Id-less payloads (reference-data
                // updates via broadcastReferenceDataUpdate, hire of an
                // unlinked prospect) keep the legacy full refetch.
                const p = (payload.payload ?? {}) as { userId?: number; userIds?: number[] };
                const ids = Array.isArray(p.userIds)
                    ? p.userIds.filter((n): n is number => typeof n === 'number')
                    : (typeof p.userId === 'number' ? [p.userId] : []);
                if (isStaffViewer()) {
                    if (ids.length > 0) callFetcher('users_slice', { ids });
                    // Id-less payloads are reference-data updates
                    // (broadcastReferenceDataUpdate: rank / unit / position / award
                    // churn, all staff-only data) and the hire of an unlinked prospect.
                    // A non-staff viewer losing this leg is safe: service_types and
                    // settings each keep their OWN unconditional handler below, so a
                    // Client's service picker and branding still refresh live.
                    else callFetcher('main');
                } else {
                    // A non-staff viewer holds no roster to patch (users_slice 403s and
                    // `main` withholds it) — but a role change or a soft-delete DOES
                    // change the availability scalar, and those emit `user_update`, never
                    // `duty_update` (lib/db/users.ts bulkDemoteUsersToClient,
                    // bulkPromoteUsersToMember). users_presence is the one subset that
                    // carries anyStaffOnDuty live, and for this tier its whole payload is
                    // one boolean and an empty array. Without this leg, demoting the last
                    // on-duty member leaves every customer reading "available" and
                    // raising requests into an empty room.
                    //
                    // It lives HERE and not in SessionContext.onUserUpdate because that
                    // handler early-returns on !targetsMe — i.e. on exactly the
                    // somebody-else's-role-changed case this leg exists to cover.
                    callFetcher('users_presence');
                }
                // The lite roster query in `main` doesn't carry the heavy
                // nested arrays (certifications, commendations, limitingMarkers,
                // conductRecord). When the broadcast targets a specific user,
                // dispatch a window event so AuthContext can re-hydrate
                // currentUser's heavy fields if it's about them.
                window.dispatchEvent(new CustomEvent('app:realtime:user-update', { detail: payload.payload }));
            })
            .on('broadcast', { event: 'notification_update' }, (payload) => {
                debugLog('[Realtime] Notification Update Broadcast Received');
                // Base channel (every member has a personal inbox). Payload is
                // id-only ({ notificationId, targetUserId }); relay it to
                // PersistentNotificationsContext, which refetches the self-scoped
                // inbox ONLY when targetUserId === the signed-in user. No content
                // ever rides the wire.
                window.dispatchEvent(new CustomEvent('app:realtime:notification-update', { detail: payload.payload }));
            });

        if (hasPerm('fleet:view')) {
            channel = channel
                .on('broadcast', { event: 'fleet_update' }, (payload) => {
                    debugLog('[Realtime] Fleet Update Broadcast Received');
                    // Slice path: emits carry {slices:[...]} naming the touched
                    // array(s) (hangar edits touch user_ships AND groups — the
                    // groups' assignedShips re-embed user_ship rows). Slice-less
                    // payloads keep the full refetch.
                    const subsets = parseSlicePayload(payload.payload, FLEET_SLICE_SUBSETS);
                    if (subsets) for (const s of subsets) callFetcher(s);
                    else callFetcher('fleet');
                });
        }

        // academy:instruct / academy:manage satisfy academy:view through the ladder,
        // so this now agrees with AcademyHubView's canViewStaff and with the server's
        // 'academy' subset gate instead of demanding a separately-ticked academy:view.
        if (hasPerm('academy:view')) {
            channel = channel
                .on('broadcast', { event: 'academy_update' }, () => {
                    debugLog('[Realtime] Academy Update Broadcast Received');
                    // Id-only staff signal (course/session mutations). Refetch the
                    // whole staff 'academy' subset — content rides the gated read.
                    // Students' My Academy changes ride their own mutation refresh +
                    // the notification_update signal, not this staff channel.
                    callFetcher('academy');
                });
        }

        channel = channel
            .on('broadcast', { event: 'settings_update' }, async () => {
                debugLog('[Realtime] Settings Update Broadcast Received');
                // Refresh the org config + settings first so feature flags
                // (warehouse, governments) reflect the change before we
                // rebuild the realtime channel below. ('main' covers the
                // settings rows — there is no separate 'settings' subset.)
                const fn = fetcherRef.current;
                if (fn) await fn('main');
                // The flag state propagates to refs via DataContext's
                // registerFeatureFlags effect on the next render tick.
                // Rebuild after that so the new .on(...) gating sees current
                // values.
                // The role-sync maps live under the same settings umbrella and have no
                // postgres_changes carrier (see the note on the discord_config_update handler
                // below), so refresh them here for admins who can read them.
                if (hasPerm('admin:config:discord')) callFetcher('discord');
                setTimeout(() => {
                    void notifyDbConnectedRef.current();
                }, 0);
            })
            // Role-sync map changes (updateRankMapping). Ids-free nudge; the receiver refetches
            // the admin-gated `discord` subset itself. This exists because `rank_mappings` and
            // `synced_discord_roles` are deliberately NOT in the realtime publication
            // (private.rt_client_tables), so the postgres_changes bindings this replaces were
            // subscribed to nothing and the tab never refreshed.
            .on('broadcast', { event: 'discord_config_update' }, () => {
                if (!hasPerm('admin:config:discord')) return;
                debugLog('[Realtime] Discord Config Update Broadcast Received');
                callFetcher('discord');
            })
            // NOTE: a 'features_update' handler used to sit here, with a comment claiming the
            // server emitted it from updateOrgFeatures(). It does not — that function ends with
            // broadcastSettingsUpdate(), and a repo-wide sweep of broadcastToOrg() literals
            // finds no emitter for 'features_update' anywhere. It was a dead binding whose
            // comment asserted the opposite. The settings_update handler above does the
            // identical work (refetch 'main', then rebuild so the feature-gated .on(...)
            // handlers are re-attached), so deleting it changes no behaviour.
            .on('broadcast', { event: 'external_tools_update' }, () => {
                // external_tools is audience-scoped, so it is excluded from the
                // authenticated_select allowlist and its postgres_changes path is
                // RLS-dead — this id-less nudge re-fetches the filtered subset live.
                debugLog('[Realtime] External Tools Update Broadcast Received');
                callFetcher('external_tools');
            })
            .on('broadcast', { event: 'announcement_update' }, () => {
                // announcements carry an audience boundary, so they are excluded
                // from the realtime publication too — this id-less nudge re-fetches
                // the server-side audience-filtered subset live.
                debugLog('[Realtime] Announcement Update Broadcast Received');
                callFetcher('announcements');
            });

        if (hasPerm('finance:view')) {
            // Finances/QM views are RPC-driven with view-local state — they
            // consume these via window CustomEvents (below) rather than their
            // own channel objects: supabase-js dedupes channels BY TOPIC, so a
            // view-owned channel('db-changes') would be THIS channel, and the
            // view's unmount removeChannel() would tear down all org realtime.
            const relay = (name: string) => (payload: { payload?: unknown }) => {
                debugLog(`[Realtime] ${name} Broadcast Received`);
                window.dispatchEvent(new CustomEvent(`app:realtime:${name}`, { detail: payload.payload }));
            };
            channel = channel
                .on('broadcast', { event: 'finances:ledger_update' }, relay('finances:ledger_update'))
                .on('broadcast', { event: 'finances:account_update' }, relay('finances:account_update'))
                .on('broadcast', { event: 'finance:reset' }, relay('finance:reset'));
        }
        if (hasPerm('qm:view')) {
            const relay = (name: string) => (payload: { payload?: unknown }) => {
                debugLog(`[Realtime] ${name} Broadcast Received`);
                window.dispatchEvent(new CustomEvent(`app:realtime:${name}`, { detail: payload.payload }));
            };
            channel = channel
                .on('broadcast', { event: 'qm:catalog_update' }, relay('qm:catalog_update'))
                .on('broadcast', { event: 'qm:location_update' }, relay('qm:location_update'))
                .on('broadcast', { event: 'qm:inventory_update' }, relay('qm:inventory_update'))
                .on('broadcast', { event: 'qm:issuance_update' }, relay('qm:issuance_update'))
                .on('broadcast', { event: 'qm:reset' }, relay('qm:reset'));
        }
        if (warehouseEnabled && hasPerm('warehouse:view')) {
            // Each event refetches ONLY its slice — the warehouse_catalog /
            // warehouse_stock / warehouse_requests subsets were split out
            // server-side for exactly this (api/query.ts), but these handlers
            // historically still re-pulled the whole 3-array bundle.
            channel = channel
                .on('broadcast', { event: 'warehouse:catalog_update' }, () => {
                    debugLog('[Realtime] Warehouse Catalog Update Broadcast Received');
                    callFetcher('warehouse_catalog');
                })
                .on('broadcast', { event: 'warehouse:stock_update' }, () => {
                    debugLog('[Realtime] Warehouse Stock Update Broadcast Received');
                    callFetcher('warehouse_stock');
                })
                .on('broadcast', { event: 'warehouse:request_update' }, () => {
                    debugLog('[Realtime] Warehouse Request Update Broadcast Received');
                    callFetcher('warehouse_requests');
                });
        }
        if (marketplaceEnabled && hasPerm('marketplace:view')) {
            // No query subset owns the marketplace board in DataContext; the
            // self-contained MarketplaceView fetches its own subsets. Relay the
            // id-only nudge as a window event so a mounted view refetches the
            // affected slice. Gated on the feature flag + permission so
            // unprivileged members never attach the listener.
            channel = channel
                .on('broadcast', { event: 'marketplace:update' }, (payload) => {
                    debugLog('[Realtime] Marketplace Update Broadcast Received');
                    window.dispatchEvent(new CustomEvent('app:realtime:marketplace-update', { detail: payload.payload }));
                });
        }
        if (governmentsEnabled && hasPerm('gov:view')) {
            channel = channel
                .on('broadcast', { event: 'government_update' }, (payload) => {
                    debugLog('[Realtime] Government Update Broadcast Received');
                    // Slice path: emits carry a {slices:[...]} key-group
                    // discriminator (structure/elections/legislation/motions)
                    // so a legislation vote doesn't re-pull the whole 8-key
                    // bundle. Slice-less payloads (template apply, legacy)
                    // keep the full refetch.
                    const subsets = parseSlicePayload(payload.payload, GOVERNMENT_SLICE_SUBSETS);
                    if (subsets) for (const s of subsets) callFetcher(s);
                    else callFetcher('government');
                });
        }

        // postgres_changes listeners, one per table. Single-org: there is no
        // organization_id column to bind a filter to.
        //
        // Tables that have a dedicated broadcast handler above are intentionally
        // excluded: the broadcast triggers the same fetchDataSubset() and the
        // 2-second dedupe suppresses a second fetch, but a postgres_changes
        // subscription would still push the full row payload over the websocket
        // for no gain. Excluded (covered by broadcast): users, service_requests,
        // operations, warrants, intel_bulletins, user_ships, fleet_groups,
        // wiki_pages.
        //
        // CONTRACT: any future server-side mutation to these tables must emit
        // the corresponding broadcast via broadcastToOrg() — otherwise remote
        // clients won't see the change.
        // Unconditional for every tier. A Client needs live service-type edits (their
        // request form's picker), and external_tools is audience-scoped server-side.
        const tableSubsets: Array<[string, string]> = [
            // announcements + external_tools are audience-scoped (excluded from the
            // realtime publication) — driven by the announcement_update /
            // external_tools_update broadcast nudges above, not postgres_changes.
            ['external_tools', 'external_tools'],
            ['service_types', 'main'],
        ];
        if (isStaffViewer()) {
            // The ten personnel / reference / taxonomy tables. postgres_changes ships
            // the FULL CHANGED ROW, so for security_clearances and
            // security_limiting_markers this was the org's clearance ladder and its
            // compartment codeword catalogue streaming in cleartext to a customer's
            // browser. Mirrors the `if (hasPerm('hr:view'))` block directly below —
            // this extends the in-file attachment pattern, it does not add a channel or
            // a topic. registerRealtimeAuth rebuilds the channel on any permission
            // change, so a promotion re-attaches these without a reload.
            //
            // Again: this stops the STREAM, it does not close the table. The SQL policy
            // is Phase 3 item 7's.
            tableSubsets.push(
                ['ranks', 'main'],
                ['units', 'main'],
                ['roles', 'main'],
                ['locations', 'main'],
                ['radio_channels', 'main'],
                // Reference / award tables that are mutated by admin:* handlers but
                // had no broadcast — without these entries, awarded certs /
                // commendations / clearance changes did not propagate to other
                // clients until a manual reload.
                ['security_clearances', 'main'],
                ['security_limiting_markers', 'main'],
                ['specialization_tags', 'main'],
                ['certifications', 'main'],
                ['commendations', 'main'],
            );
        }
        if (hasPerm('hr:view')) {
            // Per-array HR slice subsets — MUST match the subset names the
            // hr_update broadcast routes to, so the 2-second dedupe still
            // collapses the broadcast + postgres_changes double-fire for the
            // same write. Permission-gated like the broadcast handler: the
            // subsets 403 for callers without hr:view.
            tableSubsets.push(
                ['hr_applications', 'hr_applicants'],
                ['hr_interviews', 'hr_interviews'],
                ['hr_job_postings', 'hr_jobs'],
                ['hr_transfer_requests', 'hr_transfers'],
                ['personnel_positions', 'hr_positions'],
            );
        }
        // NOTE: `synced_discord_roles` and `rank_mappings` used to be pushed here for
        // admin:config:discord holders. Neither is in private.rt_client_tables(), which IS the
        // realtime publication — so both bindings were subscribed to nothing and the role-sync
        // tab never live-updated. They are replaced by the 'discord_config_update' broadcast
        // above, which the server now emits from updateRankMapping.
        //
        // General rule worth keeping: do not add a postgres_changes binding for a table that is
        // not in rt_client_tables(). Beyond being inert, supabase-js reconciles the server's
        // echoed binding list POSITIONALLY and errors the WHOLE channel on the first mismatch —
        // so a pile of bindings for unpublished tables is a latent all-realtime-down hazard,
        // not just dead weight.
        for (const [table, subset] of tableSubsets) {
            channel.on(
                'postgres_changes' as any,
                { event: '*', schema: 'public', table } as any,
                (payload: any) => {
                    debugLog(`[Realtime] ${payload.eventType} on ${table}`);
                    callFetcher(subset);
                }
            );
        }

        // Domain-registered table handlers (in addition to the hardcoded list
        // above). CONTRACT: do NOT re-register tables already in tableSubsets —
        // supabase would deliver each change twice.
        for (const [table, subset] of tableHandlersRef.current) {
            channel.on(
                'postgres_changes' as any,
                { event: '*', schema: 'public', table } as any,
                (payload: any) => {
                    debugLog(`[Realtime] ${payload.eventType} on ${table}`);
                    callFetcher(subset);
                }
            );
        }

        // NOTE: a postgres_changes binding on `settings` used to sit here, refreshing 'main'
        // and (for admins) 'discord'. `settings` is not in private.rt_client_tables() either,
        // so it too was inert — every settings change actually reaches the client through the
        // 'settings_update' BROADCAST, which the server emits explicitly and which now carries
        // the 'discord' refetch as well.

        // Structured log lines so log scraping can answer:
        //   - peak connections per org (count distinct tabId in event=connect)
        //   - idle-disconnect rate (count event=idle_disconnect / event=connect)
        //   - reconnect/error rate (count event=reconnect, event=error)
        // Grep prefix: [Realtime]
        const tabId = Math.random().toString(36).slice(2, 8);
        const connectedAt = Date.now();
        let lastEventAt = connectedAt;

        const myGen = ++buildGenRef.current;

        channel.subscribe((status) => {
            // FIRST LINE, before the status test. A superseded build's channel is already
            // gone, and the stale-channel hazard is reached through the CLOSED branch below —
            // supabase-js registers its own _onClose handler that calls this callback — so a
            // guard placed inside the SUBSCRIBED branch would protect nothing.
            if (myGen !== buildGenRef.current) return;
            if (status === 'SUBSCRIBED') {
                const wasDisconnected = realtimeConnectedRef.current === false
                    && wasEverConnectedRef.current === true
                    && deliberateTeardownRef.current === false;
                deliberateTeardownRef.current = false;
                realtimeConnectedRef.current = true;
                setRealtimeConnected(true);
                const event = wasDisconnected ? 'reconnect' : 'connect';
                debugLog(`[Realtime] event=${event} tab=${tabId} channel=${channelName}`);
                lastEventAt = Date.now();
                if (wasDisconnected) resyncHotSubsets();
                wasEverConnectedRef.current = true;
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                const wasUp = realtimeConnectedRef.current;
                realtimeConnectedRef.current = false;
                setRealtimeConnected(false);
                if (wasUp) {
                    const upMs = Date.now() - lastEventAt;
                    debugLog(`[Realtime] event=error status=${status} tab=${tabId} up_ms=${upMs}`);
                }
            }
        });

        const cleanup = async () => {
            const upMs = Date.now() - connectedAt;
            // Reason is set by callers via the closure-shared idleDisconnectedRef
            // (idle path) or just left as 'teardown' for normal unmount/rebuild.
            const reason = idleDisconnectedRef.current ? 'idle_disconnect' : 'teardown';
            debugLog(`[Realtime] event=${reason} tab=${tabId} up_ms=${upMs}`);
            // Awaited so the rebuild path can safely re-create a channel of
            // the same name without colliding with an in-flight leave.
            await supabase.removeChannel(channel);
            realtimeConnectedRef.current = false;
            setRealtimeConnected(false);
        };
        currentChannelCleanupRef.current = cleanup;
        // `cleanup` is deliberately NOT generation-guarded. A guard at the top of its body
        // would skip `await supabase.removeChannel(channel)` for a superseded build — leaking
        // the channel and making the rebuild path's own `await cleanup()` a no-op, which
        // reintroduces the joining-corpse hazard that await exists to prevent. The serializer
        // already guarantees cleanup runs to completion before the next build starts.
    }, [callFetcher, hasPermNow, resyncHotSubsets]);

    /**
     * The exported rebuild entry point. Everything that rebuilds the channel goes through the
     * serializer, so two builds can never overlap.
     *
     * Two effects in the same React commit used to race here: refreshUser() sets config,
     * realtimeToken and currentUser in one batch, which fires DashboardApp's
     * `[config, notifyDbConnected]` effect and SessionContext's registerRealtimeAuth effect
     * together. Both dependencies change on every refreshUser (config is a fresh object per
     * response; the realtime token embeds an issued-at second), and refreshUser runs on every
     * duty toggle — so the overlap was guaranteed, not occasional. supabase-js dedupes
     * channels by topic and lets broadcast handlers re-attach silently after subscribe, so the
     * result was a channel with two copies of every broadcast binding: a duplicate toast and a
     * duplicate sound for every request, status change and bulletin, until the tab was closed.
     */
    const notifyDbConnected = useCallback(() => rebuildQueue(buildChannel), [rebuildQueue, buildChannel]);

    // Keep the latest notifyDbConnected reachable from its own async rebuild
    // paths (see notifyDbConnectedRef above). Read only inside setTimeout
    // callbacks, never during render, so it always resolves to the current
    // memoized callback. Synced via an effect (not a render-time ref write).
    useEffect(() => {
        notifyDbConnectedRef.current = notifyDbConnected;
    }, [notifyDbConnected]);

    // Tab-visibility resync. Supabase Realtime terminates at Supabase, not at
    // our app, so a backend redeploy doesn't trigger a WS reconnect — meaning
    // the "wasDisconnected" branch above never fires after a Coolify rolling
    // update. To recover stale state in that case (and for tab-suspend /
    // laptop-sleep), when the tab regains visibility after >30s away,
    // re-fetch the hot subsets.
    const lastVisibleAtRef = useRef<number>(0);
    useEffect(() => {
        // Seed the baseline at mount (in the effect, not during render, so the
        // impure Date.now() call stays out of the render path). No
        // visibilitychange listener exists before this runs, so the handler
        // below can never read the ref before it is seeded — identical timing
        // to the previous render-time initialization.
        lastVisibleAtRef.current = Date.now();
        const RESYNC_THRESHOLD_MS = 30_000;
        const onVisibility = () => {
            if (document.visibilityState !== 'visible') {
                lastVisibleAtRef.current = Date.now();
                return;
            }
            const awayMs = Date.now() - lastVisibleAtRef.current;
            lastVisibleAtRef.current = Date.now();
            if (awayMs < RESYNC_THRESHOLD_MS) return;
            debugLog(`[DataCore] Tab visible after ${Math.round(awayMs / 1000)}s — resyncing hot subsets.`);
            // The SAME function the realtime reconnect path calls, not a second hand-written
            // list that happens to agree with it.
            resyncHotSubsets();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [resyncHotSubsets]);

    // Idle-tab realtime disconnect. Supabase Realtime caps concurrent
    // connections per project (200 free / 500 Pro). A backgrounded tab still
    // holds its WebSocket — at scale, idle tabs eat the cap. After 5 minutes
    // hidden we tear the channel down; on refocus we rebuild it and the
    // visibility-resync handler above re-fetches hot state. The 5-min
    // threshold is well above typical tab-switch durations so active multi-
    // tab users don't notice a reconnect.
    useEffect(() => {
        const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                if (idleDisconnectTimerRef.current) window.clearTimeout(idleDisconnectTimerRef.current);
                idleDisconnectTimerRef.current = window.setTimeout(() => {
                    // Through the SAME serializer as a rebuild, and awaited inside it. The old
                    // form fired the teardown un-awaited and nulled the ref immediately,
                    // leaving a window where the cleanup ref was null while the connection ref
                    // was still true — the one combination that makes the redundant-rebuild
                    // short-circuit return without building anything.
                    void rebuildQueue(async () => {
                        const teardown = currentChannelCleanupRef.current;
                        if (!teardown) return;
                        debugLog('[DataCore] Idle >5min, releasing realtime connection.');
                        currentChannelCleanupRef.current = null;
                        idleDisconnectedRef.current = true;
                        deliberateTeardownRef.current = true;
                        await teardown();
                    });
                }, IDLE_THRESHOLD_MS);
            } else {
                if (idleDisconnectTimerRef.current) {
                    window.clearTimeout(idleDisconnectTimerRef.current);
                    idleDisconnectTimerRef.current = null;
                }
                if (idleDisconnectedRef.current) {
                    debugLog('[DataCore] Tab refocused, rebuilding realtime channel.');
                    idleDisconnectedRef.current = false;
                    void notifyDbConnected();
                    // Channel-rebuild "wasDisconnected" branch will resync; the
                    // sibling visibility-resync effect also kicks in if >30s.
                }
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (idleDisconnectTimerRef.current) window.clearTimeout(idleDisconnectTimerRef.current);
        };
    }, [notifyDbConnected, rebuildQueue]);

    const registerFetchDataSubset = useCallback((fn: FetchDataSubset | null) => {
        fetcherRef.current = fn;
    }, []);

    // SessionContext registers the per-user realtime token + permission set
    // after boot/login and whenever they change; the channel is rebuilt so
    // setAuth and the permission-gated handler attachment reflect the new
    // identity. Logout registers (null, [], '') which tears realtime down
    // (fail-closed).
    const registerRealtimeAuth = useCallback((token: string | null, permissions: string[], role: string) => {
        const key = `${token || ''}|${role}|${[...permissions].sort().join(',')}`;
        if (key === realtimeAuthKeyRef.current) return;
        realtimeAuthKeyRef.current = key;
        realtimeTokenRef.current = token;
        permissionsRef.current = new Set(permissions);
        isAdminRef.current = role === 'Admin';
        void notifyDbConnected();
    }, [notifyDbConnected]);

    const registerFeatureFlags = useCallback((flags: DataCoreFeatureFlags) => {
        warehouseEnabledRef.current = flags.warehouseEnabled;
        governmentsEnabledRef.current = flags.governmentsEnabled;
        marketplaceEnabledRef.current = flags.marketplaceEnabled;
    }, []);

    const registerSubsetFetcher = useCallback((subset: string, fetcher: FetchDataSubset) => {
        subsetFetchersRef.current.set(subset, fetcher);
        return () => {
            // Guard against the unregister fn firing after the same subset
            // re-registered (rare, but possible during HMR / strict-mode double-mount).
            const current = subsetFetchersRef.current.get(subset);
            if (current === fetcher) subsetFetchersRef.current.delete(subset);
        };
    }, []);

    const registerSliceSetter = useCallback((key: string, setter: SliceSetter) => {
        sliceSettersRef.current.set(key, setter);
        return () => {
            const current = sliceSettersRef.current.get(key);
            if (current === setter) sliceSettersRef.current.delete(key);
        };
    }, []);

    const applyStateData = useCallback((data: any) => {
        if (!data) return;
        for (const setter of sliceSettersRef.current.values()) {
            try { setter(data); }
            catch (e) { console.error('[DataCore] slice setter threw', e); }
        }
    }, []);

    const registerTableHandler = useCallback((table: string, subset: string) => {
        tableHandlersRef.current.push([table, subset]);
        return () => {
            const idx = tableHandlersRef.current.findIndex(([t, s]) => t === table && s === subset);
            if (idx !== -1) tableHandlersRef.current.splice(idx, 1);
        };
    }, []);

    const value: DataCoreContextValue = {
        rpcAction,
        simpleAction,
        realtimeConnected,
        notifyDbConnected,
        registerFetchDataSubset,
        registerFeatureFlags,
        registerRealtimeAuth,
        registerSubsetFetcher,
        registerSliceSetter,
        applyStateData,
        registerTableHandler,
    };

    return <DataCoreContext value={value}>{children}</DataCoreContext>;
};

export const useDataCore = (): DataCoreContextValue => {
    const ctx = use(DataCoreContext);
    if (!ctx) throw new Error('useDataCore must be used within a DataCoreProvider');
    return ctx;
};
