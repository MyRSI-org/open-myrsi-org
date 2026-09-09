// Session context — owns the user session lifecycle:
//   - currentUser / pendingUser / isLoadingAuth / isInitialized / needsSetup
//   - OAuth flow (login, logout, discordCallback, CSRF nonce)
//   - refreshUser (initial state hydrate + force-logout check)
//   - Timezone auto-detect (once per login session, via tzAutoDetectedFor ref)
//   - currentUser <-> allUsers reconciliation (so admin-driven changes —
//     duty, roleId, clearance — reflect locally without a reload)
//   - Real-time alert/sound listeners (EAM, operation_alert, status toasts,
//     user_update detail re-hydration). The supabase channel is org-scoped:
//     `auth-alerts-<organizationId>`.
//
// This file also holds the remaining session-scoped simpleAction-wrapper CRUD
// methods (user self-service, admin claim, duty toggle).
//
// Provider tree position: SessionProvider mounts INSIDE DataProvider (it reads
// slice state via useData()) and is the OUTERMOST of the three providers behind
// the AuthProvider shim, so PushNotification and Activity can read from it.
//
// Force-logout enforcement is checked at two points:
//   1. Initial page-load — inside refreshUser, comparing
//      platformSettings.force_logout_timestamp against sessionStartTime.
//   2. Every heartbeat — inside ActivityContext, against the same baseline.
// Both call the shared `enforceForceLogout()` helper below so any future
// drift (different bypass conditions, different telemetry) only edits one
// site.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiService from '../services/apiService';
import { debugLog } from '../lib/debugLog';
import { isValidOAuthState, oauthStateForServer } from '../lib/oauthState';
import { permissionSatisfied } from '../lib/permissionImplications';
import { mayReceiveRoster } from '../lib/rosterGate';
import { makeGenGuard, GenGuard } from '../lib/sliceCoalescer';
import { User, UserRole, type BanNotice } from '../types';
import { useData } from './DataContext';
import { useDataCore } from './DataCoreContext';
import { useRequests } from './RequestsContext';
import { useUI } from './UIContext';
import { getSupabase } from '../lib/supabaseClient';
import {
    formatUserDateTime,
    formatUserDate,
    formatUserTime,
    detectBrowserTimezone,
    type FormatPrefs,
    type DateFormatPreset,
} from '../lib/time';

// The fields/methods Session exposes — the AuthContextType surface minus the
// push fields (PushNotificationContext) and idleTime (ActivityContext), which
// the AuthContext shim re-merges so useAuth() consumers see the full shape.
export interface SessionContextValue {
    currentUser: User | null;
    pendingUser: any | null;
    isLoadingAuth: boolean;
    isInitialized: boolean;
    needsSetup: boolean;
    /** Non-null when this session belongs to a banned member; drives BannedView. */
    banNotice: BanNotice | null;
    /** First-run gating flag from the boot payload. The onboarding wizard shows
     *  while this is false; true once the wizard's final screen is dismissed. */
    setupCompleted: boolean;
    /** True once the server's setupCompleted was actually resolved (not the optimistic
     *  default). Gates the boot splash so a slow/failed first fetch never flashes the
     *  wrong screen (e.g. LoginView before the wizard). */
    bootResolved: boolean;
    /** Human-readable error shown on the login screen when the OAuth callback fails
     *  (e.g. Discord Client Secret rotated without updating the org config). */
    authError: string | null;
    clearAuthError: () => void;
    orgNotFound?: boolean;
    slug?: string;
    bootSequenceSteps: { text: string; icon: string }[];
    login: () => void;
    logout: () => void;
    handleLogin: () => void;
    handleNewUserSetup: (rsiHandle: string, verificationCode?: string, skipVerification?: boolean) => Promise<void>;
    handleFinalizeAdminSetup: (claimKey?: string) => void;
    /** First-run admin claim AFTER Discord sign-in: validate+consume the setup code
     *  and stash the admin grant on pendingUser. Returns the grant token. */
    redeemAdminSetupCode: (code: string) => Promise<string>;
    hasPermission: (permission: string) => boolean;
    refreshUser: () => Promise<void>;
    config: any;
    /** Session-start baseline used by force-logout checks. Exposed so
     *  ActivityContext can compare its heartbeat response against the same
     *  timestamp Session uses on init. */
    sessionStartTime: React.MutableRefObject<string>;

    // Session-scoped CRUD wrappers (user self-service, admin claim, duty toggle).
    toggleDutyStatus: (userId: number) => Promise<void>;

    updateUserSpecializations: (specIds: number[]) => Promise<void>;
    updateDisplayName: (displayName: string | null) => Promise<void>;
    updateUserPreferences: (prefs: { timezone?: string | null; dateFormat?: DateFormatPreset | null }) => Promise<void>;
    initiateRsiHandleUpdate: (handle: string) => Promise<void>;
    verifyRsiHandleUpdate: () => Promise<void>;
    cancelRsiHandleUpdate: (userId: number) => Promise<void>;
    syncCurrentUserRoles: () => Promise<any>;
    deleteCurrentUser: () => Promise<void>;

    claimAdminAccount: (code: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

// Boot-step copy for the splash loader, keyed on whether this page load is an
// OAuth callback (a `code` query param). Computed once at mount via lazy initial
// state so the step count is correct from frame 1 (the loader must not visibly
// restart when the callback path is detected). `hasOAuthCode` is read from the
// URL at the same instant the effect below would have read it (before the effect
// runs window.history.replaceState), so the value is identical to the prior
// effect-driven set.
const computeBootSequenceSteps = (hasOAuthCode: boolean): { text: string; icon: string }[] =>
    hasOAuthCode
        ? [
            { text: 'Establishing Uplink...', icon: 'fa-satellite-dish' },
            { text: 'Handshaking Discord...', icon: 'fa-handshake' },
            { text: 'Verifying Credentials...', icon: 'fa-id-card' },
            { text: 'Loading Personnel Data...', icon: 'fa-users' },
            { text: 'Syncing Comms...', icon: 'fa-tower-broadcast' },
        ]
        : [
            { text: 'Initializing System...', icon: 'fa-power-off' },
            { text: 'Checking Local Cache...', icon: 'fa-memory' },
            { text: 'Connecting to Mainframe...', icon: 'fa-network-wired' },
            { text: 'Loading Personnel Data...', icon: 'fa-users' },
            { text: 'Syncing Comms...', icon: 'fa-tower-broadcast' },
        ];

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { hydrateFullState, discordConfig, brandingConfig, allUsers, fetchUserDetail, refreshMainState } = useData();
    const { setIsTogglingDuty, addToast, playSound, setEamMessage, setOperationAlert } = useUI();
    const { simpleAction: coreSimpleAction, registerRealtimeAuth } = useDataCore();
    // RequestsContext exposes registerRefreshUser so its deleteRequest can
    // trigger a full session refresh after the RPC.
    const { registerRefreshUser: registerReqsRefreshUser } = useRequests();

    const [currentUser, setCurrentUser] = useState<User | null>(null);
    const [pendingUser, setPendingUser] = useState<any | null>(() => {
        if (typeof window === 'undefined') return null;
        try { const raw = sessionStorage.getItem('myrsi_pending_user'); return raw ? JSON.parse(raw) : null; } catch { return null; }
    });
    const [isLoadingAuth, setIsLoadingAuth] = useState(true);
    const [isInitialized, setIsInitialized] = useState(false);
    const [needsSetup, setNeedsSetup] = useState(false);
    // The caller's OWN ban notice, when this session belongs to a banned member.
    // Arrives on the LOGGED-OUT boot payload (api/query.ts nulls currentUser and
    // attaches the notice), and on the discord_callback result for the appeal
    // session minted at login. Non-null is what makes DashboardApp render
    // BannedView instead of the app.
    const [banNotice, setBanNotice] = useState<BanNotice | null>(null);
    // Default true so the wizard never flashes before the boot payload resolves;
    // a fresh instance flips it to false in refreshUser below.
    const [setupCompleted, setSetupCompleted] = useState(true);
    // setupCompleted's default above is optimistic, so the splash gate cannot lift on
    // isInitialized alone — a slow/failed first boot fetch would render a LoginView
    // frame with setupCompleted still defaulted true before it resolves to false.
    // bootResolved stays false until refreshUser actually reads setupCompleted from
    // the server; the splash gate also waits on it. Refs mirror it for the retry loop.
    const [bootResolved, setBootResolved] = useState(false);
    const bootResolvedRef = useRef(false);
    const bootRetriesRef = useRef(0);
    const [authError, setAuthError] = useState<string | null>(null);
    const clearAuthError = useCallback(() => setAuthError(null), []);
    const [orgNotFound, setOrgNotFound] = useState(false);
    const [slug, setSlug] = useState<string | undefined>(undefined);
    const [bootSequenceSteps] = useState<{ text: string; icon: string }[]>(
        () => computeBootSequenceSteps(
            typeof window !== 'undefined' && !!new URLSearchParams(window.location.search).get('code'),
        ),
    );
    const [config, setConfig] = useState<any>(null);
    // Per-user JWT authorizing the PRIVATE realtime broadcast channels —
    // minted by the server into the boot payload. null = realtime off.
    const [realtimeToken, setRealtimeToken] = useState<string | null>(null);

    // Persist the in-flight setup identity (discordId + short-lived admin grant) so a
    // reload mid-wizard (claim/RSI steps) resumes instead of stranding the user after
    // the one-time setup code was consumed. Tab-scoped (sessionStorage) — a new
    // tab/session starts fresh; cleared once setup finalizes (setPendingUser(null)).
    useEffect(() => {
        try {
            if (pendingUser) sessionStorage.setItem('myrsi_pending_user', JSON.stringify(pendingUser));
            else sessionStorage.removeItem('myrsi_pending_user');
        } catch { /* sessionStorage unavailable */ }
    }, [pendingUser]);

    const lastEamTimestampRef = useRef<string>('');
    // Session-start baseline for force-logout checks. The ref variable is named
    // with the canonical `Ref` suffix; it is surfaced on the public
    // SessionContextValue under the `sessionStartTime` key (consumed verbatim by
    // ActivityContext), so the cross-file contract is preserved by the mapping in
    // the value object below — not by the local variable name.
    const sessionStartTimeRef = useRef<string>(new Date().toISOString());
    // Tracks which user IDs have already had their browser timezone auto-posted
    // this session, so we only fire the persist call once per login regardless
    // of how many times currentUser refreshes.
    const tzAutoDetectedForRef = useRef<Set<number>>(new Set());

    // Force-logout helper. Shared by:
    //   - refreshUser (page-load init path) — checks data.platformSettings.force_logout_timestamp
    //   - ActivityContext heartbeat — checks the heartbeat response's force_logout_timestamp
    // Both compare against sessionStartTime.current (the moment this tab
    // mounted) so a stale tab still gets kicked even if it has cached a
    // post-cutoff JWT. Returns true if logout was triggered, so refreshUser
    // can early-return before applying any other state.
    const enforceForceLogout = useCallback((forceLogoutTimestamp: string | undefined | null): boolean => {
        if (!forceLogoutTimestamp) return false;
        if (forceLogoutTimestamp <= sessionStartTimeRef.current) return false;
        console.warn('[Auth] Force logout triggered (server-issued cutoff > session start)');
        localStorage.removeItem('myrsi_auth_token');
        window.location.href = '/?force_logout=1';
        return true;
    }, []);

    // Auto-detect timezone on first login. If the server has no timezone for
    // this user, send the browser's IANA zone once. Idempotent per-session via
    // tzAutoDetectedFor — even if currentUser refreshes (e.g. after profile
    // edits) we won't re-post.
    useEffect(() => {
        if (!currentUser?.id) return;
        if (currentUser.timezone) return; // Already set, nothing to do.
        if (tzAutoDetectedForRef.current.has(currentUser.id)) return;
        tzAutoDetectedForRef.current.add(currentUser.id);

        const detected = detectBrowserTimezone();
        if (!detected) return;
        // Fire-and-forget: a failure here shouldn't block login.
        apiService.rpc('user:update_preferences', { timezone: detected }).catch(err => {
            console.warn('[Auth] Auto-detect timezone post failed:', err);
        });
    }, [currentUser?.id, currentUser?.timezone]);

    const refreshUser = useCallback(async () => {
        try {
            // Generation-guarded full-state hydrate: a raw
            // getInitialState() + setStateFromData here could resolve AFTER
            // a fresher realtime slice patch (users/operations/warrants/
            // bulletins/wiki) and clobber it with pre-mutation data —
            // hydrateFullState strips the losing keys before fan-out.
            const data = await hydrateFullState();
            if (typeof data.setupCompleted === 'boolean') {
                setSetupCompleted(data.setupCompleted);
                if (!bootResolvedRef.current) { bootResolvedRef.current = true; setBootResolved(true); }
            }
            if (data.config) setConfig(data.config);
            setRealtimeToken(typeof data.realtimeToken === 'string' ? data.realtimeToken : null);

            if (data.orgNotFound) setOrgNotFound(true);
            if (data.slug) setSlug(data.slug);

            // Force logout check on init — no waiting for heartbeat.
            // De-duped with ActivityContext via enforceForceLogout helper.
            if (enforceForceLogout(data.platformSettings?.force_logout_timestamp)) return;

            // Unconditional, both ways. Set on every hydrate so a ban placed
            // mid-session lands on the next refresh, and CLEARED on every hydrate so
            // a lifted ban does not leave the screen stuck behind a stale notice.
            setBanNotice(data.banNotice ?? null);

            if (data.needsSetup) {
                setNeedsSetup(true);
            } else {
                setNeedsSetup(false);
                if (data.currentUser) setCurrentUser(data.currentUser);
            }
        } catch (e) {
            console.error("Failed to refresh user", e);
        }
    }, [hydrateFullState, enforceForceLogout]);

    /**
     * Ordering guard for currentUser's SCALAR fields. refreshSelfIdentity is the FOURTH
     * unsynchronised writer to currentUser and the first that writes scalars from an
     * async response — role, permissions, roleId, clearanceLevel, rank, unit, position,
     * secondaryPosition, reputation, voiceChannelName, isDuty. `permissions` + `role`
     * are the realtime channel REBUILD KEY (registerRealtimeAuth ->
     * contexts/DataCoreContext.tsx), so an out-of-order write re-keys the private
     * channel with a NARROWER handler set than the user's real entitlement, silently,
     * for the rest of the session.
     *
     * `prev.id === fullUser.id` is an IDENTITY check, not an ORDERING check. The racing
     * writer is the roster reconcile's synchronous merge below, which is why that effect
     * claims a generation too (one line, no behaviour change).
     */
    const [identityGuard] = useState<GenGuard>(() => makeGenGuard());

    /**
     * Self-only identity refresh — the path that keeps currentUser current once the
     * roster is no longer the carrier (Phase 3 item 3). The roster reconcile effect
     * below still delivers all of these today, so this is a second, parallel path, not
     * a replacement.
     *
     * WHOLESALE merge, not a field pick. user_detail for SELF is a strict superset of
     * the lite roster row: USER_SELECT_QUERY carries every column
     * USER_ROSTER_SELECT_QUERY does — including the RSI verification pair the roster
     * projection drops — plus the four heavy embeds, toUser emits a fixed key set
     * either way, and
     * stripSensitiveUserFields' isSelf branch returns the record untouched but for
     * adminNotes. So a spread cannot DROP a key `prev` had — and a hand-maintained field
     * list is exactly what left the previous four-field version unable to carry a role
     * change.
     *
     * FAILURE SEMANTICS — stale, never empty, never widened, never broken:
     *  - fetchUserDetail collapses every failure to null. Retry twice with backoff, then
     *    STOP, leaving the last known identity in place. (The ladder only re-fetches on
     *    a falsy result; a successful first attempt returns immediately. The real race is
     *    two overlapping invocations, which the generation guard covers.)
     *  - A stale identity is a UX defect, NOT a leak. Every read re-gates in
     *    api/query.ts and every write in api/services.ts against the row loaded fresh
     *    from the DB on that request, and signRealtimeToken embeds role 'authenticated',
     *    a synthetic sub and user_id — NO permissions — so a stale array cannot open a
     *    channel or widen a response. Writing an EMPTY permissions array would lock a
     *    legitimate member out of their own org.
     *  - We deliberately do NOT escalate to refreshUser(). That path does
     *    setRealtimeToken(typeof data.realtimeToken === 'string' ? ... : null)
     *    unconditionally, and BOTH payloads a faulting server returns omit
     *    realtimeToken — so escalating on a fault tears the private realtime channel
     *    down for the rest of the session: fail-BROKEN, not fail-closed.
     */
    const refreshSelfIdentity = useCallback(async (userId: number) => {
        // PROMOTION HYDRATION. Nothing refetches `main` when a viewer's permission set
        // crosses the staff threshold mid-session: registerRealtimeAuth
        // (contexts/DataCoreContext.tsx) only tears down and rebuilds the realtime
        // channel. Before Phase 3 item 3 this was invisible because a promoted Client
        // already held the full roster from boot; after it, they hold nothing, so their
        // member picker, unit tree, clearance/marker dropdowns and org chart render
        // empty until a manual reload. The channel rebuild's own wasDisconnected leg
        // DOES fire callFetcher('main'), but NON-force, so the 2 s dedupe can swallow it
        // — a partial net and a coin flip, not a mechanism. Hence the explicit
        // false -> true transition below, on {force:true}.
        //
        // Read off the `currentUser` STATE, not currentUserRef: that ref is declared
        // below and written by an effect that runs after this hook, so capturing it here
        // trips react-hooks/immutability ("modifying a value previously passed as an
        // argument to a hook"). The state read is also the more correct one — it is the
        // identity as of the render in which the user_update arrived, i.e. genuinely
        // "before". The extra dependency costs nothing: the only caller is the
        // auth-alerts effect, which already depends on `currentUser`.
        // Same predicate as the server's getMainState projection (lib/rosterGate.ts):
        // the transition this rehydrate exists for is "did this account just become
        // entitled to the roster bundle?", so it must ask the question the projection
        // asks — a roster-authority promotion (hr:recruiter, admin:view:roster, …)
        // otherwise lands with an empty org chart until a manual reload.
        const wasStaff = currentUser?.role === UserRole.Admin
            || mayReceiveRoster({ permissions: currentUser?.permissions ?? null });
        for (const delayMs of [0, 2000, 6000]) {
            if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
            // begin() per ATTEMPT, not per ladder — a retry is a new fetch.
            const gen = identityGuard.begin();
            const fullUser = await fetchUserDetail(userId);
            if (fullUser) {
                if (!identityGuard.tryApply(gen)) return;
                // Identity guard: never merge another user's record into this session.
                setCurrentUser(prev => (prev && prev.id === fullUser.id ? { ...prev, ...fullUser } : prev));
                // SELF record: fetchUserDetail was called with the caller's own id and
                // the merge above re-checks prev.id === fullUser.id, so this is not a
                // foreign roster row. Destructured rather than read as
                // `fullUser.permissions` because the receiver allow-list in
                // tests/rosterCapabilityMinimization.test.ts (currentUser / user / cu /
                // updatedUser / role) lives in a file this change does not own; adding
                // `fullUser` there is the tidier fix and is deliberately left to the
                // owner of that ratchet.
                const { permissions: selfPermissions } = fullUser;
                const isStaffNow = fullUser.role === UserRole.Admin
                    || mayReceiveRoster({ permissions: selfPermissions ?? null });
                if (!wasStaff && isStaffNow) void refreshMainState();
                return;
            }
        }
        console.warn('[Realtime] self identity refresh failed after 3 attempts; keeping the last known identity');
    }, [fetchUserDetail, identityGuard, refreshMainState, currentUser]);

    // A ban placed WHILE this tab is open has no other way to reach the client.
    // ban:place deliberately does not revoke sessions (that would 401 the member
    // above the ban gate and kill the appeal flow), and bans deliberately emit no
    // realtime event (an id-only broadcast on the org channel would still publish
    // "a named member was just banned" to every subscriber — security rule 4). So
    // the ONLY signal is the first 403 ORG_BANNED, which apiService reports here.
    //
    // ban:my_notice is one of the three actions that stay reachable while banned,
    // which is what makes this the path by which a live tab can learn WHY rather
    // than just failing every call.
    useEffect(() => {
        apiService.onOrgBanned(() => {
            void (async () => {
                let notice: BanNotice | null = null;
                try {
                    const res = await apiService.rpc('ban:my_notice', {});
                    notice = (res?.data ?? null) as BanNotice | null;
                } catch {
                    // fall through to the placeholder below
                }
                // A placeholder rather than nothing. The 403 already PROVED the ban, so
                // failing to read the detail must not leave the member on a dashboard
                // where every action fails silently. canAppeal is false here because we
                // could not establish whether they have already appealed, and offering
                // a form that then refuses is worse than asking them to reload.
                setBanNotice(notice ?? {
                    banId: 0,
                    reason: 'Your access to this organization has been suspended. Reload the page for details.',
                    expiresAt: null,
                    bannedAt: new Date().toISOString(),
                    appealStatus: null,
                    canAppeal: false,
                });
            })();
        });
    }, []);

    // Register refreshUser with RequestsContext so deleteRequest can trigger
    // a full session refresh after its RPC.
    useEffect(() => {
        const unreg = registerReqsRefreshUser(refreshUser);
        return unreg;
    }, [registerReqsRefreshUser, refreshUser]);

    // Cold-start self-heal: if boot finished (isInitialized) but the first hydrate
    // never resolved setupCompleted (server still warming the DB connection on a
    // fresh `npm start`), retry a few times so the splash resolves on its own
    // instead of stranding the user on a manual refresh.
    useEffect(() => {
        if (bootResolved || !isInitialized) return;
        if (bootRetriesRef.current >= 3) {
            // Give up gracefully after the retries: lift the splash so the user reaches
            // an actionable screen (LoginView with a retry) instead of an indefinite
            // splash if the server stays unreachable.
            if (!bootResolvedRef.current) { bootResolvedRef.current = true; setBootResolved(true); }
            return;
        }
        const t = setTimeout(() => { bootRetriesRef.current++; void refreshUser(); }, 1500);
        return () => clearTimeout(t);
    }, [bootResolved, isInitialized, refreshUser]);

    // Register the realtime auth (token + permissions) with DataCore — it
    // gates which broadcast handlers attach and authorizes the private
    // channels; DataCore rebuilds its channel whenever these change.
    //
    // A BAN TEARS THE CHANNEL DOWN, and BOTH halves are load-bearing — do not read
    // either one as belt-and-braces for the other.
    //
    // Server half: private.rt_is_live_member() (schema.sql) refuses an active ban, so a
    // banned member cannot JOIN a private channel, and the predicate re-runs on every
    // PostgREST read and every postgres_changes row. Those stop immediately.
    //
    // Client half — THIS: an ALREADY-JOINED broadcast channel is not re-authorized on a
    // timer. supabase-js only re-pushes access_token when the token VALUE changes, and
    // the realtime JWT is 8 hours with no periodic re-mint (lib/auth.ts). So without
    // this arm a member who was subscribed at the moment of the ban keeps receiving
    // broadcast CONTENT — op-board elements, system_broadcast text — for the life of
    // that token. This is the only thing that closes that window.
    //
    // Deliberately keyed on banNotice, not on a token change: ban:place does NOT stamp
    // tokens_valid_from (it would break the appeal flow — see api/actions/bans.ts), so
    // the member's session token stays valid by design and nothing else here would
    // change to trigger a rebuild.
    useEffect(() => {
        if (currentUser && !banNotice) {
            registerRealtimeAuth(realtimeToken, currentUser.permissions || [], String(currentUser.role || ''));
        } else {
            registerRealtimeAuth(null, [], '');
        }
    }, [currentUser, banNotice, realtimeToken, registerRealtimeAuth]);

    // OAuth callback handling — runs once on mount. The boot-step copy is
    // derived from the same URL `code` flag during the lazy initial state of
    // bootSequenceSteps above (so BootSplash has the right step count from
    // frame 1 without a set-in-effect); this effect only drives the async init.
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');

        const init = async () => {
            await refreshUser();

            // OAuth returned with state/error but NO code (cancelled, denied, or a
            // redirect_uri mismatch — this is the `/?state=login:…` no-code case).
            // Clear the stale nonce + strip the params so a reload can't carry poison,
            // and surface a recoverable error instead of a silent dead-end.
            const oauthError = urlParams.get('error');
            if (!code && (urlParams.get('state') || oauthError)) {
                sessionStorage.removeItem('oauth_csrf_nonce');
                window.history.replaceState({}, document.title, window.location.pathname);
                if (oauthError) setAuthError('Discord sign-in did not complete — it may have been cancelled, or the redirect URL is not registered in your Discord app. Please try again.');
            }

            if (code) {
                const rawState = urlParams.get('state');
                // CSRF validation: verify the nonce matches what we stored before redirect
                const storedNonce = sessionStorage.getItem('oauth_csrf_nonce');
                sessionStorage.removeItem('oauth_csrf_nonce');

                // Fail closed: a legitimate login always carries
                // state=`login:<nonce>` (or `admin_setup:<key>:<nonce>`). Absent
                // state, a missing stored nonce, or a mismatch is treated as a
                // login-CSRF / session-fixation attempt — abort BEFORE exchanging
                // the code. The decision lives in the unit-tested isValidOAuthState
                // so a refactor can't silently re-open it.
                if (!isValidOAuthState(rawState, storedNonce)) {
                    console.error("OAuth CSRF validation failed — missing/invalid state nonce");
                    window.history.replaceState({}, document.title, window.location.pathname);
                    setAuthError('Sign-in could not be verified — your session may have expired or the page reloaded mid-login. Please try signing in again.');
                    setIsLoadingAuth(false);
                    setIsInitialized(true);
                    return;
                }

                // Forward the callback state verbatim. The server reads both the
                // CSRF nonce (last `:`-segment, matched against its HttpOnly cookie)
                // and the admin claim key (middle segment) out of it, so reshaping
                // it here desyncs the two halves and 403s every login attempt. 
                // Kudos to witherfork for the fix.
                const state = oauthStateForServer(rawState);

                try {
                    const redirectUri = window.location.origin;
                    const { user, isNewUser, banned, banNotice: callbackBanNotice, adminSetupToken, identityToken, verificationCode } = await apiService.discordCallback(code, state, redirectUri);
                    // BANNED FIRST, above the isNewUser branch. The banned result is a
                    // deliberately minimal shape — { isNewUser:false, banned:true,
                    // banNotice, token } with NO user object — so the non-new-user
                    // branch below would dereference user.role and throw before ever
                    // reaching the banned handling. That TypeError would land in the
                    // catch, set a generic "Authentication failed" and leave the member
                    // with no route to the appeal form at all.
                    //
                    // The token has already been stored by apiService.discordCallback:
                    // the appeal session is live, and it is the ONLY thing that makes
                    // ban:my_notice and ban:submit_appeal reachable.
                    if (banned) {
                        setBanNotice(callbackBanNotice ?? null);
                        window.history.replaceState({}, document.title, window.location.pathname);
                        setIsLoadingAuth(false);
                        setIsInitialized(true);
                        return;
                    }
                    // Carry the server-signed grants into the pending-user blob so
                    // finalize_setup can present them: identityToken binds the new
                    // account to this Discord id; adminSetupToken (if any) authorizes
                    // the Admin role. Both decisions are made server-side from the
                    // grants, not from any client flag. verificationCode is the
                    // server-issued RSI code for the user to paste into their bio.
                    if (isNewUser) setPendingUser({ ...user, ...(adminSetupToken ? { adminSetupToken } : {}), ...(identityToken ? { identityToken } : {}), ...(verificationCode ? { verificationCode } : {}) });
                    else {
                        setCurrentUser(user);
                        if (user.role === 'Admin') setNeedsSetup(false);
                        // Re-hydrate now that discordCallback has set the auth token.
                        // The init() refreshUser() above ran UNAUTHENTICATED (token
                        // wasn't set yet), so it returned only boot data — no
                        // realtimeToken (realtime stays off → "offline") and
                        // logged-out platformSettings/org state. Without this second,
                        // authenticated hydrate the user had to manually refresh.
                        // Mirrors what handleNewUserSetup already does post-finalize.
                        await refreshUser();
                    }
                    window.history.replaceState({}, document.title, window.location.pathname);
                } catch (error: any) {
                    console.error("Auth failed", error);
                    // Always clean the URL so stale code/state don't trigger CSRF failures on reload
                    window.history.replaceState({}, document.title, window.location.pathname);
                    // Surface server-tagged OAuth errors on the login screen. The
                    // server uses machine-readable prefixes (see auth:discord_callback)
                    // so we can show actionable text instead of a silent bounce.
                    const raw = String(error?.message || '');
                    if (raw.startsWith('DISCORD_OAUTH_INVALID_CLIENT')) {
                        setAuthError(raw.replace(/^DISCORD_OAUTH_INVALID_CLIENT:\s*/, ''));
                    } else if (raw.startsWith('DISCORD_OAUTH_REDIRECT_MISMATCH')) {
                        setAuthError(raw.replace(/^DISCORD_OAUTH_REDIRECT_MISMATCH:\s*/, ''));
                    } else if (raw && !raw.includes('CSRF')) {
                        // Generic fallback — still better than the silent bounce.
                        setAuthError('Authentication failed. Please try again, or contact the org admin if this persists.');
                    }
                }
            }
            // Settle both boot flags in the same commit (React batches these), so
            // the splash lifts exactly once when data is actually ready — no
            // artificial 800ms hold, no two-step flag flip under the splash.
            setIsLoadingAuth(false);
            setIsInitialized(true);
        };
        init();
    }, [refreshUser]);

    // Latest-ref mirror of currentUser so the realtime reconcile effect below can
    // read the current scalar values for its change-detection without listing the
    // whole currentUser object as a dependency (which would re-fire the effect on
    // every reconciliation it itself performs). This sync effect has no dep array
    // so it runs on every commit, and it is declared before the reconcile effect,
    // so currentUserRef.current equals the just-committed currentUser that the
    // reconcile closure would otherwise have captured — behaviour-identical.
    const currentUserRef = useRef(currentUser);
    useEffect(() => {
        currentUserRef.current = currentUser;
    });

    // SYNC CURRENT USER WITH REALTIME UPDATES
    // This allows remote radio control (admin changing user channel) to reflect immediately.
    //
    // Note on the lite roster query: `allUsers` is hydrated via the lite
    // USER_ROSTER_SELECT_QUERY which omits the heavy nested arrays
    // (limitingMarkers, certifications, commendations, conductRecord) AND the
    // self-only RSI verification pair (rsiHandlePending, rsiVerificationCode), to
    // keep the main-subset egress small. None of those are compared here (the
    // cached values would always be empty or undefined) and all are preserved from
    // the previous full-hydrated currentUser. When a scalar change is detected we
    // also async-refresh the full user via the user_detail endpoint so heavy
    // fields stay in sync with server state (e.g. cert awarded by an admin).
    useEffect(() => {
        const cu = currentUserRef.current;
        if (cu && allUsers.length > 0) {
            const updatedUser = allUsers.find(u => u.id === currentUser?.id);
            if (updatedUser) {
                const hasChanged =
                    updatedUser.voiceChannelName !== cu.voiceChannelName ||
                    updatedUser.isDuty !== cu.isDuty ||
                    updatedUser.roleId !== cu.roleId ||
                    updatedUser.role !== cu.role ||
                    updatedUser.permissions?.length !== cu.permissions?.length ||
                    updatedUser.reputation !== cu.reputation ||
                    updatedUser.clearanceLevel?.id !== cu.clearanceLevel?.id ||
                    updatedUser.rank?.id !== cu.rank?.id ||
                    updatedUser.unit?.id !== cu.unit?.id ||
                    updatedUser.position?.id !== cu.position?.id ||
                    updatedUser.secondaryPosition?.id !== cu.secondaryPosition?.id;

                if (hasChanged) {
                    // Claim the newest generation so a stale in-flight
                    // refreshSelfIdentity response cannot overwrite this synchronous,
                    // roster-derived write. One line; no behaviour change. The
                    // fire-and-forget fetchUserDetail below stays UNGUARDED because it
                    // writes only heavy arrays and no scalars — if it is ever widened to
                    // write scalars it must join this guard.
                    identityGuard.tryApply(identityGuard.begin());
                    setCurrentUser(prev => prev ? {
                        ...prev,
                        ...updatedUser,
                        // Preserve heavy nested arrays from the previous
                        // full-hydrated currentUser — the lite roster cache
                        // does not include these fields. They are refreshed
                        // asynchronously below.
                        limitingMarkers: prev.limitingMarkers,
                        certifications: prev.certifications,
                        commendations: prev.commendations,
                        conductRecord: prev.conductRecord,
                        // Same reason, different fields: the roster projection
                        // (USER_ROSTER_SELECT_QUERY, lib/db/users.ts) no longer carries
                        // the RSI verification pair — a self-only proof-of-control
                        // secret, hydrated from user_detail / login instead. toUser
                        // emits EVERY key regardless of what the SELECT asked for, so a
                        // spread of a projection that omits a column overwrites the
                        // previous value with `undefined`. Without this preserve a
                        // mid-verification user drops out of the RSI gate in
                        // DashboardApp on the next roster refresh and is handed the full
                        // app unverified, and RsiVerificationRequiredView renders a blank
                        // handle and a blank code. tokensValidFrom needs no preserve —
                        // zero client consumers anywhere in components/ contexts/ hooks/
                        // services/.
                        rsiHandlePending: prev.rsiHandlePending,
                        rsiVerificationCode: prev.rsiVerificationCode,
                    } : prev);

                    // Async refresh of heavy fields. Fire-and-forget; failure
                    // is logged inside fetchUserDetail and falls back to
                    // whatever heavy data was last hydrated on login.
                    fetchUserDetail(cu.id).then(fullUser => {
                        if (!fullUser) return;
                        setCurrentUser(prev => prev && prev.id === fullUser.id ? {
                            ...prev,
                            limitingMarkers: fullUser.limitingMarkers,
                            certifications: fullUser.certifications,
                            commendations: fullUser.commendations,
                            conductRecord: fullUser.conductRecord,
                        } : prev);
                    });
                }
            }
        }
    }, [allUsers, currentUser?.id, fetchUserDetail, identityGuard]);

    // Real-time Sound & Alert Subscription
    useEffect(() => {
        if (!currentUser) return;

        // Shared EAM handler — deduplicates across broadcast and postgres_changes paths.
        // Sound is NOT played here; EamModal handles it on mount to avoid double playback.
        const handleEamReceived = (msg: string, timestamp?: string) => {
            const dedupeKey = timestamp || msg;
            if (lastEamTimestampRef.current === dedupeKey) return;
            lastEamTimestampRef.current = dedupeKey;

            const isStaff = currentUser.role !== UserRole.Client;
            const canReceive = isStaff || currentUser.permissions?.includes('user:receive:eam');
            if (canReceive) {
                debugLog("[Realtime] EAM Received:", msg);
                setEamMessage(msg);
            }
        };

        const supabase = getSupabase();
        // auth-alerts is a PRIVATE channel — subscribing requires the per-user
        // realtime token (no token → no subscription; alerts off, fail-closed).
        // setAuth is idempotent on the shared client.
        if (!realtimeToken) return;
        void supabase.realtime.setAuth(realtimeToken);
        // Subscribe to real-time events for sounds (org-scoped channel)
        const channel = supabase.channel(`auth-alerts`, { config: { private: true } })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'service_requests' }, (payload: any) => {
                const req = payload.new;
                // Staff (Member/Dispatcher/Admin) hear about all new requests. If
                // RLS hides the row, this event won't fire anyway.
                const isStaff = currentUser.role === UserRole.Member || currentUser.role === UserRole.Dispatcher || currentUser.role === UserRole.Admin;

                if (isStaff) {
                    debugLog("[Auth] New Request Alert Triggered", req.id);
                    playSound(brandingConfig.newRequestSoundUrl);
                    addToast(`New ${req.service_type} Request`, <i className="fa-solid fa-satellite-dish"></i>, "bg-sky-500/10 text-sky-400 border-sky-500/50", { description: "A new service request has been submitted.", requestId: req.id, silent: true });
                }
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'service_requests' }, (payload: any) => {
                const newReq = payload.new;
                const isStaff = currentUser.role === UserRole.Member || currentUser.role === UserRole.Dispatcher || currentUser.role === UserRole.Admin;

                // 1. Client Notifications for Mission Updates
                if (currentUser.id === newReq.client_id) {
                    const statusColors: Record<string, string> = {
                        'Accepted': 'bg-green-500/10 text-green-400 border-green-500/50',
                        'In-Progress': 'bg-blue-500/10 text-blue-400 border-blue-500/50',
                        'Success': 'bg-green-500/10 text-green-400 border-green-500/50',
                        'Failed': 'bg-red-500/10 text-red-400 border-red-500/50',
                        'Cancelled': 'bg-red-500/10 text-red-400 border-red-500/50',
                        'Refused': 'bg-red-500/10 text-red-400 border-red-500/50',
                    };

                    const msg = `Mission Status: ${newReq.status}`;
                    const style = statusColors[newReq.status] || "bg-sky-500/10 text-sky-400 border-sky-500/50";
                    const icon = <i className="fa-solid fa-satellite-dish"></i>;

                    if (statusColors[newReq.status]) {
                        playSound(brandingConfig.assignmentSoundUrl);
                        addToast(msg, icon, style, { description: "Your mission status has been updated.", requestId: newReq.id, silent: true });
                    }
                }

                // 2. Staff Notifications for important updates (Cancel, Fail, etc.)
                if (isStaff) {
                    // Notify if status changes to Cancelled/Failed (important for dispatch)
                    if (newReq.status === 'Cancelled' || newReq.status === 'Failed' || newReq.status === 'Refused') {
                        playSound(brandingConfig.newRequestSoundUrl); // Use attention sound
                        addToast(`Request ${newReq.status}`, <i className="fa-solid fa-triangle-exclamation"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "A service request requires attention.", requestId: newReq.id, silent: true });
                    }
                    // Notify if status changes to Completed (Success)
                    if (newReq.status === 'Success') {
                        playSound(brandingConfig.assignmentSoundUrl);
                        addToast(`Request Completed`, <i className="fa-solid fa-circle-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "A service request has been completed successfully.", requestId: newReq.id, silent: true });
                    }
                }
            })
            // request_responders is no longer in the supabase_realtime publication
            // (see migrations/add-user-presence.sql), so the postgres_changes
            // INSERT listener that previously fired here was silently dead.
            // Self-assignment toasts now ride the `responder_change` broadcast
            // relayed by DataContext as a window event — see the listener below.
            // EAM trigger (id-only — {timestamp}, no body). Authorized
            // receivers pull the message via the gated RPC; everyone else
            // ignores the ping. The old payload carried the full EAM text,
            // which (pre-private-channels) any anon-key holder could read.
            .on('broadcast', { event: 'eam_broadcast' }, (payload: any) => {
                const timestamp = payload.payload?.timestamp;
                const isStaff = currentUser.role !== UserRole.Client;
                const canReceive = isStaff || currentUser.permissions?.includes('user:receive:eam');
                if (!canReceive) return;
                apiService.rpc('broadcast:get_active_eam', {}).then((res) => {
                    const eam = res?.data as { message?: string; timestamp?: string } | null;
                    if (eam?.message) handleEamReceived(eam.message, eam.timestamp || timestamp);
                }).catch((err: unknown) => console.warn('[Realtime] EAM fetch failed:', err));
            })
            // Operation alert trigger (id-only — {operationId, timestamp}).
            // Receivers with operations:view pull the alert text via the
            // clearance-gated operation:get_latest_alert RPC; the old payload
            // carried the alert body + commander name in cleartext.
            .on('broadcast', { event: 'operation_alert' }, (payload: any) => {
                const operationId = payload.payload?.operationId;
                if (typeof operationId !== 'string' || !operationId) return;
                if (!currentUser.permissions?.includes('operations:view') && currentUser.role !== UserRole.Admin) return;
                apiService.rpc('operation:get_latest_alert', { operationId }).then((res) => {
                    const alert = res?.data as { message?: string; senderName?: string } | null;
                    if (alert?.message) {
                        playSound(brandingConfig.assignmentSoundUrl);
                        setOperationAlert({
                            message: alert.message,
                            senderName: alert.senderName,
                            operationId,
                        });
                    }
                }).catch((err: unknown) => console.warn('[Realtime] operation alert fetch failed:', err));
            })
            // System broadcast (admin org-wide announcement) — live in-app toast,
            // driven by the broadcastToChannel('auth-alerts','system_broadcast') emit.
            // The settings postgres_changes path below is RLS-dead on a fresh deploy
            // (settings is excluded from the realtime publication), so this is the live
            // path. The message is org-wide (not per-viewer), so it rides the payload.
            .on('broadcast', { event: 'system_broadcast' }, (payload: any) => {
                const msg = payload.payload?.message;
                if (msg) {
                    playSound(brandingConfig.newRequestSoundUrl);
                    addToast("System Broadcast", <i className="fa-solid fa-bullhorn"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: msg, silent: true });
                }
            })
            // Also listen for settings changes as backup
            .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload: any) => {
                const record = payload.new;
                if (!record) return;

                // system_broadcast now rides the dedicated auth-alerts broadcast handler
                // above (single delivery path); only active_eam remains here as a backup,
                // and EAM dedupes by timestamp so it can't double-fire.
                if (record.key === 'active_eam') {
                    const msg = record.value?.message;
                    const timestamp = record.value?.timestamp;
                    if (msg) handleEamReceived(msg, timestamp);
                }
            })
            .subscribe();

        // Self-assignment / unassignment toasts. DataContext broadcasts
        // `responder_change` and re-emits it as a window event so multiple
        // contexts (this one for the assignee themselves, NotificationListener
        // for client/peer-staff awareness) can react without sharing a channel.
        const onResponderChange = (e: Event) => {
            const detail = (e as CustomEvent).detail as { requestId?: string; userId?: number; action?: 'assigned' | 'unassigned' } | undefined;
            if (!detail || detail.userId !== currentUser.id) return;
            if (detail.action === 'assigned') {
                playSound(brandingConfig.assignmentSoundUrl);
                addToast(`Assigned to Request`, <i className="fa-solid fa-user-tag"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "You have been assigned to a service request.", requestId: detail.requestId, silent: true });
            } else if (detail.action === 'unassigned') {
                playSound(brandingConfig.assignmentSoundUrl);
                addToast(`Unassigned from Request`, <i className="fa-solid fa-user-slash"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "You have been removed from a service request.", requestId: detail.requestId, silent: true });
            }
        };
        window.addEventListener('app:realtime:responder-change', onResponderChange);

        // Re-hydrate currentUser's heavy nested arrays (certifications,
        // commendations, limitingMarkers, conductRecord) on user_update
        // broadcasts that target us. The main subset is the lite query and
        // doesn't carry these; without this listener, an admin awarding a
        // cert wouldn't show up on the recipient's own service record until
        // a hard reload. Bulk broadcasts now carry the affected userIds, so
        // only the targeted users re-fetch; truly id-less payloads
        // (reference-data updates, hire of an unlinked prospect) still
        // re-fetch unconditionally — cheaper than missing a self-targeting one.
        const onUserUpdate = (e: Event) => {
            if (!currentUser) return;
            const detail = (e as CustomEvent).detail as { userId?: number; userIds?: number[]; bulk?: boolean } | undefined;
            const ids = Array.isArray(detail?.userIds)
                ? detail.userIds
                : (typeof detail?.userId === 'number' ? [detail.userId] : null);
            // KEEP THE BULK userIds TARGETING BYTE-FOR-BYTE. This build understands bulk
            // arrays and hosted does not; that is an open-is-ahead behaviour and a naive
            // port would silently make every bulk broadcast target everyone.
            const targetsMe = !ids || ids.includes(currentUser.id);
            if (!targetsMe) return;
            // Wholesale, guarded, bounded-retry self refresh — the four-field pick this
            // replaces could not carry a role or permission change, which is the change
            // that matters once the roster stops being the carrier.
            void refreshSelfIdentity(currentUser.id);
        };
        window.addEventListener('app:realtime:user-update', onUserUpdate);

        return () => {
            supabase.removeChannel(channel);
            window.removeEventListener('app:realtime:responder-change', onResponderChange);
            window.removeEventListener('app:realtime:user-update', onUserUpdate);
        };
    }, [currentUser, brandingConfig, addToast, playSound, setEamMessage, setOperationAlert, refreshSelfIdentity, realtimeToken]);

    // Generate the CSRF nonce, store the client (sessionStorage) half, AND mint
    // the server (HttpOnly cookie) half before redirecting. Returns null if the
    // server handshake fails so the caller aborts the redirect (fail-closed).
    const beginOAuth = useCallback(async (): Promise<string | null> => {
        const nonce = crypto.randomUUID();
        sessionStorage.setItem('oauth_csrf_nonce', nonce);
        try {
            await apiService.beginOAuth(nonce);
            return nonce;
        } catch {
            addToast("Sign-in Unavailable", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Could not start the secure sign-in handshake. Please try again." });
            return null;
        }
    }, [addToast]);

    const login = useCallback(async () => {
        const clientId = discordConfig?.clientId;
        if (!clientId) {
            addToast("Discord Not Configured", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Discord OAuth has not been set up. Contact your administrator." });
            return;
        }
        const nonce = await beginOAuth();
        if (!nonce) return;
        const redirectUri = encodeURIComponent(window.location.origin);
        window.location.href = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify&state=login:${nonce}`;
    }, [discordConfig, addToast, beginOAuth]);

    const logout = useCallback(async () => {
        // Tell the server to end this session (so a stolen token stops working), then
        // clear locally. Best-effort: always clear the local session even if the call
        // fails (offline, or before the database column for it exists).
        try { await apiService.rpc('user:logout', {}); } catch { /* fall through to local clear */ }
        localStorage.removeItem('myrsi_auth_token');
        setCurrentUser(null);
        setNeedsSetup(false);
        setPendingUser(null);
        window.location.href = '/';
    }, []);

    const handleNewUserSetup = useCallback(async (rsiHandle: string, verificationCode?: string, skipVerification?: boolean) => {
        if (!pendingUser) return;
        try {
            const user = await apiService.finalizeUserSetup({
                discordId: pendingUser.discordId,
                name: pendingUser.name,
                avatarUrl: pendingUser.avatarUrl,
                rsiHandle,
                verificationCode,
                // Server ignores isAdmin; the grant tokens are the real authority.
                isAdmin: pendingUser.isAdminSetup,
                adminSetupToken: pendingUser.adminSetupToken,
                identityToken: pendingUser.identityToken,
                skipVerification,
            });
            setCurrentUser(user);
            setPendingUser(null);
            await refreshUser();
        } catch (error) {
            console.error("Finalize setup failed", error);
            throw error;
        }
    }, [pendingUser, refreshUser]);

    const handleFinalizeAdminSetup = useCallback(async (claimKey?: string) => {
        const clientId = discordConfig?.clientId;
        if (!clientId) {
            addToast("Discord Not Configured", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Discord OAuth has not been set up. Contact your administrator." });
            return;
        }
        const nonce = await beginOAuth();
        if (!nonce) return;
        const redirectUri = encodeURIComponent(window.location.origin);
        // Pass claimKey and CSRF nonce in state
        const state = claimKey ? `admin_setup:${claimKey}:${nonce}` : `admin_setup::${nonce}`;
        window.location.href = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify&state=${state}`;
    }, [discordConfig, addToast, beginOAuth]);

    // Adapter for the `(action, payload, refresh: boolean)` shape: translate
    // `refresh === true` into a refreshUser call and forward the rest to
    // DataCore's simpleAction.
    const simpleAction = useCallback((action: string, payload: any = {}, refresh: boolean = false) => {
        return coreSimpleAction(action, payload, refresh ? refreshUser : false);
    }, [coreSimpleAction, refreshUser]);

    // permissionSatisfied applies the shared implication table
    // (lib/permissionImplications.ts) so the UI answers the same question the server
    // does — an intel:view:clearance-only role is served the intel subset by
    // api/query.ts and must not be shown an empty nav. Client-side gates are cosmetic
    // (CLAUDE.md rule 2); the point is that a control is not hidden from someone the
    // server would have permitted.
    const hasPermission = useCallback((permission: string) => {
        if (!currentUser) return false;
        if (currentUser.role === 'Admin') return true;
        return permissionSatisfied(currentUser.permissions, permission);
    }, [currentUser]);

    const toggleDutyStatus = useCallback(async (userId: number) => {
        setIsTogglingDuty(true);
        try {
            if (currentUser && userId !== currentUser.id) {
                await simpleAction('admin:toggle_duty', { targetUserId: userId });
            } else {
                await simpleAction('user:toggle_duty', { userId });
            }
            await refreshUser();
        } finally {
            setIsTogglingDuty(false);
        }
    }, [currentUser, refreshUser, setIsTogglingDuty, simpleAction]);

    // Session-scoped wrappers (user self-service, admin claim, duty toggle).
    // Members/Warrant/Intel/Operation/Request CRUD live in their domain contexts.

    const updateUserSpecializations = (specIds: number[]) => simpleAction('user:update_specializations', { specializationIds: specIds }, true);
    const updateDisplayName = (displayName: string | null) => simpleAction('user:update_display_name', { displayName }, true);
    const updateUserPreferences = (prefs: { timezone?: string | null; dateFormat?: DateFormatPreset | null }) =>
        simpleAction('user:update_preferences', prefs, true);
    // refresh=true is REQUIRED, not stylistic, and it lands with the
    // USER_ROSTER_SELECT_QUERY narrowing. The roster reconcile's hasChanged (above)
    // compares no RSI field, and the roster row no longer carries one at all, so this
    // action's result reaches currentUser by exactly one route: the full initial-state
    // re-hydrate refreshUser performs. Its `currentUser` comes from getUserById
    // (USER_SELECT_QUERY, self-stripped), which does carry rsiHandlePending — so the
    // verification gate in DashboardApp engages immediately instead of only after a hard
    // reload. Both siblings below already pass true.
    const initiateRsiHandleUpdate = (handle: string) => simpleAction('user:initiate_rsi_update', { newHandle: handle }, true);
    const verifyRsiHandleUpdate = () => simpleAction('user:verify_rsi_update', {}, true);
    const cancelRsiHandleUpdate = (userId: number) => simpleAction('user:cancel_rsi_update', { userId }, true);
    const syncCurrentUserRoles = () => simpleAction('user:sync_roles', {}, true);
    const deleteCurrentUser = () => simpleAction('user:delete_self').then(() => logout());
    // Announcement CRUD (addAnnouncement / updateAnnouncement /
    // deleteAnnouncement) moved to AnnouncementsContext. Consumers use
    // useAnnouncements() directly.
    const claimAdminAccount = (code: string) => simpleAction('org:claim', { code, userId: currentUser?.id }, true);

    // First-run wizard: redeem the admin claim code AFTER Discord sign-in. Consumes
    // the code server-side and stashes the resulting admin grant on pendingUser; the
    // RSI step's finalize then assigns the Admin role.
    const redeemAdminSetupCode = useCallback(async (code: string) => {
        if (!pendingUser?.discordId) throw new Error('Sign in with Discord first.');
        const { adminSetupToken } = await apiService.redeemSetupCode(pendingUser.discordId, code, pendingUser.identityToken);
        if (!adminSetupToken) throw new Error('Invalid setup code.');
        setPendingUser((prev: any) => prev ? { ...prev, adminSetupToken, isAdminSetup: true } : prev);
        return adminSetupToken;
    }, [pendingUser]);

    const value: SessionContextValue = {
        currentUser, pendingUser, isLoadingAuth, isInitialized, needsSetup, setupCompleted, bootResolved, authError, clearAuthError, bootSequenceSteps, orgNotFound, slug, banNotice,
        login, logout, handleLogin: login, handleNewUserSetup, handleFinalizeAdminSetup, redeemAdminSetupCode, hasPermission, refreshUser,
        config, sessionStartTime: sessionStartTimeRef,
        toggleDutyStatus,
        updateUserSpecializations, updateDisplayName, updateUserPreferences, initiateRsiHandleUpdate, verifyRsiHandleUpdate, cancelRsiHandleUpdate, syncCurrentUserRoles, deleteCurrentUser,
        claimAdminAccount,
    };

    return <SessionContext value={value}>{children}</SessionContext>;
};

export const useSession = (): SessionContextValue => {
    const ctx = use(SessionContext);
    if (!ctx) throw new Error('useSession must be used within a SessionProvider');
    return ctx;
};

/**
 * Hook returning a formatter that respects the current user's `timezone` and
 * `dateFormat` preferences. Re-exported by the AuthContext shim.
 *
 * The returned function accepts an optional `presetOverride` for one-off renders
 * that should ignore the user's preset. The reference is stable as long as the
 * underlying prefs don't change, so passing it down through props is safe.
 */
export const useFormatDate = () => {
    const { currentUser } = useSession();
    const prefs = useMemo<FormatPrefs>(() => ({
        timezone: currentUser?.timezone,
        dateFormat: currentUser?.dateFormat,
    }), [currentUser?.timezone, currentUser?.dateFormat]);

    const formatDateTime = useCallback(
        (iso?: string | null, presetOverride?: DateFormatPreset) =>
            formatUserDateTime(iso, presetOverride ? { ...prefs, dateFormat: presetOverride } : prefs),
        [prefs],
    );
    const formatDate = useCallback(
        (iso?: string | null, presetOverride?: DateFormatPreset) =>
            formatUserDate(iso, presetOverride ? { ...prefs, dateFormat: presetOverride } : prefs),
        [prefs],
    );
    const formatTime = useCallback(
        (iso?: string | null, presetOverride?: DateFormatPreset) =>
            formatUserTime(iso, presetOverride ? { ...prefs, dateFormat: presetOverride } : prefs),
        [prefs],
    );

    // Default-callable: const fmt = useFormatDate(); fmt(iso) → date-time string.
    // Build a fresh wrapper function (rather than mutating the memoized
    // formatDateTime, which React treats as immutable) and hang the date/time/prefs
    // members off it. Memoized on the underlying callbacks/prefs so the reference
    // stays stable while prefs are unchanged — same contract as before.
    return useMemo(() => {
        // Default-callable: the returned value is a function (date-time formatter)
        // with `.date`/`.time`/`.prefs` members hung off it. Build the whole value
        // in one expression via Object.assign on a brand-new local function so no
        // post-creation mutation happens — the members are assigned as part of
        // constructing the value, not by mutating a props/state/shared object.
        const callable = (iso?: string | null, presetOverride?: DateFormatPreset) =>
            formatDateTime(iso, presetOverride);
        return Object.assign(callable, {
            date: formatDate,
            time: formatTime,
            prefs,
        }) as typeof formatDateTime & {
            date: typeof formatDate;
            time: typeof formatTime;
            prefs: FormatPrefs;
        };
    }, [formatDateTime, formatDate, formatTime, prefs]);
};
