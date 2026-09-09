
import { noteBuildId } from '../lib/buildUpdate';
import type { BanNotice } from '../types';

const API_URL = '/api';

class ApiService {
    private token: string | null = null;

    constructor() {
        // Restore token from storage if available. Its absence no longer means "logged out" —
        // a cookie session has nothing here by design — so boot proceeds either way and the
        // server decides.
        if (typeof window !== 'undefined') {
            this.token = localStorage.getItem('myrsi_auth_token');
            if (this.token) this.scheduleCookieProbe();
        }
    }

    private getHeaders(): HeadersInit {
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
        };
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        return headers;
    }

    /**
     * Every server call goes through here so the deployment's build id is observed on responses
     * the app already makes. That is the whole update-detection mechanism: no poll, no timer,
     * no extra request — and a tab nobody is using never asks, which is correct.
     *
     * Wrapping fetch rather than adding a /healthz poll is also what keeps the service worker
     * out of it: api/sw.ts skips /api/ entirely, so these responses are never served from a
     * cache with a stale header.
     */
    private async trackedFetch(input: string, init?: RequestInit): Promise<Response> {
        // `same-origin` so the HttpOnly session cookie is attached. Explicit rather than relying
        // on the default, which differs by browser age and would silently drop the credential.
        const response = await fetch(input, { ...init, credentials: 'same-origin' });
        noteBuildId(response.headers.get('X-Build-Id'));
        // A successful request that carried NO Authorization header can only have been
        // authenticated by the cookie. Learning it HERE rather than only from the probe matters:
        // the probe is scheduled solely when a localStorage token exists, so a fully migrated,
        // cookie-only page load never scheduled one and `cookieProven` stayed false for the life
        // of the page — which silently disabled the 401 recovery redirect below for exactly the
        // population this migration creates.
        // COOKIE PROOF MUST COME FROM A REQUEST THAT COULD NOT HAVE SUCCEEDED WITHOUT
        // A SESSION. noteCookieAuthWorked DELETES the localStorage token, so inferring
        // it from any 200 was the trap this file's own comment describes: several
        // surfaces answer 200 to an anonymous caller — `target=config` and
        // `target=manifest` are pre-auth boot payloads, `auth:*` are PUBLIC_ACTIONS in
        // the dispatcher, and `target=initial-state` has an unauthenticated variant. On
        // a deployment where the cookie does NOT stick (an operator on plain HTTP whose
        // browser refused it, a proxy stripping Set-Cookie) the fallback token was
        // therefore thrown away on the strength of a request that proved nothing, and
        // the member re-authenticated on every page load.
        //
        // `target=state` is the narrow choice: it is session-required with no anonymous
        // variant, and the dashboard issues one on every load, so proof still arrives
        // immediately in the real flow.
        if (response.ok && !this.token && /[?&]target=state\b/.test(input)) this.noteCookieAuthWorked();
        // A BAN OBSERVED ON ANY REQUEST, not just a mutation.
        //
        // rpc() checks this too, but rpc() is the MUTATION path. Every read helper below
        // routes its failures through handleResponseError, which handles 401 only, so a
        // 403 ORG_BANNED from api/query.ts was discarded as a generic fetch error and
        // banNotice stayed null. A member who is watching and not clicking — a tactical
        // board open, the activity heartbeat idle because they have not touched the
        // mouse in five minutes — was never told, so the client never tore its realtime
        // channel down and kept receiving broadcast CONTENT (op-board elements,
        // system_broadcast text) on a subscription that was authorized before the ban.
        //
        // The server-side predicate (private.rt_is_live_member) refuses a banned member
        // at JOIN time and re-runs per PostgREST read, so reads and postgres_changes stop
        // immediately either way — but an ALREADY-JOINED broadcast channel is not
        // re-authorized on a timer, and the realtime JWT runs 8 hours (lib/auth.ts). This
        // is what closes that window, which makes it load-bearing rather than cosmetic.
        //
        // Placed in trackedFetch because it is the one funnel every read AND write goes
        // through; noteOrgBanned is one-shot, and clone() leaves the caller's body unread.
        if (response.status === 403) {
            try {
                const body = await response.clone().json();
                if (body?.code === 'ORG_BANNED') this.noteOrgBanned();
            } catch { /* not JSON, or already consumed — a plain 403 is not a ban signal */ }
        }
        return response;
    }

    /**
     * True once a request has been proven to authenticate on the cookie ALONE.
     *
     * Until that is proven, the token stays in localStorage. Dropping it eagerly would be a trap:
     * if the cookie does not stick on this deployment — an operator on plain HTTP whose browser
     * refused it, a proxy stripping Set-Cookie — an in-memory-only token is gone on the next page
     * load, so the user would re-authenticate on EVERY refresh. Keeping it means the fallback
     * survives a reload, and the localStorage population still drains within one login cycle.
     */
    private cookieProven = false;

    public setToken(token: string) {
        this.token = token;
        // Still written, deliberately. See cookieProven — this is removed only once the cookie
        // is proven to work, never speculatively.
        localStorage.setItem('myrsi_auth_token', token);
        this.scheduleCookieProbe();
    }

    /**
     * Called after a successful authenticated request that carried NO Authorization header: the
     * cookie must therefore be what authenticated it. At that point the localStorage copy is
     * pure XSS surface with no remaining job, so it goes.
     */
    public noteCookieAuthWorked() {
        if (this.cookieProven) return;
        this.cookieProven = true;
        try { localStorage.removeItem('myrsi_auth_token'); } catch { /* storage blocked */ }
    }

    private cookieProbePending = false;

    /**
     * Prove — once per session — that the cookie alone authenticates, then drop the localStorage
     * copy of the token.
     *
     * Deliberately a RAW fetch with no Authorization header and no `handleResponseError`: the
     * point is to learn whether the COOKIE works, so sending the header would answer the wrong
     * question, and routing a probe 401 through the error handler would log the user out for
     * failing an experiment.
     *
     * Every non-200 is INCONCLUSIVE, not proof of failure. In particular a 401 here can mean
     * force-logout or a revocation watermark rather than "the cookie was not sent". On anything
     * but a 200 the token simply stays in localStorage and the header path keeps working.
     */
    private scheduleCookieProbe() {
        if (this.cookieProven || this.cookieProbePending || typeof window === 'undefined') return;
        this.cookieProbePending = true;
        void (async () => {
            try {
                const response = await fetch(`${API_URL}/query?target=state&subset=main`, {
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                });
                if (response.ok) this.noteCookieAuthWorked();
            } catch { /* offline or blocked — stay on the header path */ } finally {
                this.cookieProbePending = false;
            }
        })();
    }

    private logoutRedirectPending = false;

    /**
     * Called once when the server first answers 403 ORG_BANNED — i.e. the caller was
     * banned WHILE this tab was open.
     *
     * ban:place deliberately does NOT revoke sessions (it would 401 the member above
     * the ban gate and kill the appeal flow — see api/actions/bans.ts), so nothing
     * else tells a live tab that its session just changed meaning. Without this the
     * tab keeps running against a server that refuses everything, showing generic
     * "action failed" toasts and no explanation.
     *
     * Deliberately NOT a page reload: a reload races the very requests that produced
     * this signal. SessionContext registers a handler that fetches the notice through
     * ban:my_notice — which IS reachable while banned — and flips the app to
     * BannedView in place.
     */
    private orgBannedHandler: (() => void) | null = null;
    private orgBannedNotified = false;

    public onOrgBanned(handler: () => void) {
        this.orgBannedHandler = handler;
    }

    /** One-shot: a banned tab makes many failing calls, and this must fire once. */
    private noteOrgBanned() {
        if (this.orgBannedNotified) return;
        this.orgBannedNotified = true;
        try { this.orgBannedHandler?.(); } catch { /* never let the notifier break the caller */ }
    }

    private handleResponseError(status: number) {
        if (status === 401) {
            console.warn("Session expired or unauthorized. Clearing session.");
            // "Did we believe we had a session?" — asked of the IN-MEMORY token, not of
            // localStorage. Once the cookie is proven and the localStorage copy is removed, a
            // localStorage sentinel is permanently false, so this redirect would never fire
            // again: a user whose 24-hour session expired would sit on a dead dashboard
            // throwing fetch errors with no route back to the login screen. `cookieProven`
            // counts too, because a cookie session has nothing in storage by design.
            const hadSession = !!this.token || this.cookieProven;
            localStorage.removeItem('myrsi_auth_token');
            localStorage.removeItem('myrsi_user');
            this.token = null;
            this.cookieProven = false;
            // Only reload if we actually cleared a session — prevents an infinite reload loop
            // when the user is already logged out and initial-state returns 401.
            if (typeof window !== 'undefined' && hadSession && !this.logoutRedirectPending) {
                this.logoutRedirectPending = true;
                window.location.replace('/');
            }
        }
    }

    async getInitialState(): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=initial-state`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error('Failed to fetch initial state');
        }
        return response.json();
    }

    async getState(): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error('Failed to fetch state');
        }
        return response.json();
    }

    async getStateSubset(subset: string): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state&subset=${subset}`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error(`Failed to fetch state subset: ${subset}`);
        }
        return response.json();
    }

    async getUserDetail(userId: number): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state&subset=user_detail&id=${userId}`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error(`Failed to fetch user detail: ${userId}`);
        }
        return response.json();
    }

    /** Realtime slice fetch: lite roster rows for the given user ids only. */
    async getUsersSlice(userIds: number[]): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state&subset=users_slice&ids=${userIds.join(',')}`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error(`Failed to fetch users slice: ${userIds.join(',')}`);
        }
        return response.json();
    }

    /** Realtime slice fetch: a single-row subset by id (operation_slice,
     *  warrant_slice, bulletin_slice, wiki_page_slice, ...). */
    async getStateSubsetWithId(subset: string, id: string): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state&subset=${subset}&id=${encodeURIComponent(id)}`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error(`Failed to fetch ${subset}: ${id}`);
        }
        return response.json();
    }

    /** Realtime slice fetch: one list-shaped operation (null = absent/not visible). */
    async getOperationSlice(operationId: string): Promise<any> {
        return this.getStateSubsetWithId('operation_slice', operationId);
    }

    /** Realtime slice fetch: operation templates only (not the ops list). */
    async getOperationTemplates(): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state&subset=operation_templates`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error('Failed to fetch operation templates');
        }
        return response.json();
    }

    async getServiceRequest(id: string): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/query?target=state&subset=request_detail&id=${id}`, {
            headers: this.getHeaders()
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            throw new Error(`Failed to fetch request detail: ${id}`);
        }
        return response.json();
    }

    // Server half of the OAuth login-CSRF defense: mint the HttpOnly nonce
    // cookie BEFORE redirecting to Discord. Same-origin fetch, so the cookie is
    // set on our domain and replayed on the discord_callback POST. Throws on
    // failure so the caller can abort the redirect (fail-closed).
    async beginOAuth(nonce: string): Promise<void> {
        const response = await this.trackedFetch(`${API_URL}/services?target=auth&action=auth:begin_oauth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'auth:begin_oauth', payload: { nonce } }),
        });
        if (!response.ok) throw new Error('Failed to begin OAuth handshake');
    }

    /**
     * A banned member gets a SUCCESS shape, not an error: the server mints an ordinary
     * session token so they can read their own notice and appeal once. It arrives with
     * NO user object, so SessionContext must branch on `banned` FIRST — the
     * non-new-user branch below it dereferences user.role and would throw.
     */
    async discordCallback(code: string, state: string | null, redirectUri: string): Promise<{ user: any, isNewUser: boolean, banned?: boolean, banNotice?: BanNotice | null, adminSetupToken?: string, identityToken?: string, verificationCode?: string }> {
        // Explicitly send action in query param to bypass auth middleware logic if body parsing fails
        const response = await this.trackedFetch(`${API_URL}/services?target=auth&action=auth:discord_callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'auth:discord_callback', // Also include in body for redundancy
                payload: { code, state, redirectUri }
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            console.error("Auth Error Details:", error);
            throw new Error(error.message || 'Failed to authenticate with Discord');
        }

        // Unwrap RPC response structure { success: true, data: { ... } }
        const responseBody = await response.json();
        const data = responseBody.data;

        if (data && data.token) {
            this.setToken(data.token);
        }

        return data;
    }

    async finalizeUserSetup(userData: { discordId: string, name: string, avatarUrl: string, rsiHandle: string, verificationCode?: string, isAdmin?: boolean, adminSetupToken?: string, identityToken?: string, skipVerification?: boolean }): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/services?target=auth&action=auth:finalize_setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'auth:finalize_setup',
                payload: userData
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to finalize user setup');
        }

        // Unwrap RPC response structure { success: true, data: { ... } }
        const responseBody = await response.json();
        const data = responseBody.data;

        if (data && data.token) {
            this.setToken(data.token);
        }

        // Remove token from user object returned to UI (cleanliness)
        const { token, ...user } = data;
        return user;
    }

    async rpc(action: string, payload: any): Promise<any> {
        const response = await this.trackedFetch(`${API_URL}/services`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ action, payload }),
        });

        if (!response.ok) {
            this.handleResponseError(response.status);
            let message = `RPC action ${action} failed`;
            let requestId: string | undefined;
            let code: string | undefined;
            try {
                const error = await response.json();
                if (error.message) message = error.message;
                if (typeof error.requestId === 'string') requestId = error.requestId;
                if (typeof error.code === 'string') code = error.code;
            } catch {
                message = response.statusText || message;
            }
            // The server-side ban gate answers 403 ORG_BANNED. Both halves are checked:
            // the code alone would let any handler that happened to return that string
            // trip the screen, and 403 alone is an ordinary permission denial.
            if (response.status === 403 && code === 'ORG_BANNED') this.noteOrgBanned();
            // Surface the server-side requestId so users can quote it when
            // reporting issues; ops can grep server logs for [${requestId}].
            const err = new Error(requestId ? `${message} (ref: ${requestId})` : message);
            if (requestId) (err as Error & { requestId?: string }).requestId = requestId;
            // Machine-readable alongside the human message, so a caller can branch on
            // the cause instead of matching on prose.
            if (code) (err as Error & { code?: string }).code = code;
            throw err;
        }

        if (response.headers.get('content-type')?.includes('application/json')) {
            return response.json();
        }
    }

    // --- First-run onboarding ---

    /** Pre-auth preflight status (booleans only) for the setup wizard. */
    async preflight(): Promise<{ dbConnected: boolean; adminExists: boolean; discordConfigured: boolean; realtimeEnabled: boolean; secretsEncrypted: boolean; sessionSecretStrong: boolean; setupCompleted: boolean; setupCodeExists: boolean } | undefined> {
        const res = await this.rpc('system:preflight', {});
        return res?.data;
    }

    /** Validate + consume the admin claim code (after Discord sign-in) → admin grant. */
    async redeemSetupCode(discordId: string, code: string, identityToken?: string): Promise<{ adminSetupToken?: string }> {
        const res = await this.rpc('auth:redeem_setup_code', { discordId, code, identityToken });
        return (res?.data || {}) as { adminSetupToken?: string };
    }

    /** Mark first-run setup complete (final wizard screen dismissed). */
    async completeSetup(): Promise<void> {
        await this.rpc('system:complete_setup', {});
    }

    /** Streamed org-data import: POST the raw NDJSON; onEvent fires per progress
     *  event (start/phase/table/warning/done/error) as the server emits it.
     *  `mergeImportedUserId` is the export user.id the admin mapped to themselves
     *  (the server re-anchors the admin onto it). A 'reauth' event carries a fresh
     *  session token (the merge may have changed the admin's id) — swapped in here
     *  transparently before it reaches onEvent. */
    async importOrgStream(ndjson: string, onEvent: (evt: any) => void, mergeImportedUserId?: number): Promise<void> {
        const headers: Record<string, string> = { 'Content-Type': 'application/x-ndjson' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
        const qs = mergeImportedUserId != null ? `?mergeUserId=${encodeURIComponent(String(mergeImportedUserId))}` : '';
        const response = await this.trackedFetch(`${API_URL}/admin/import-stream${qs}`, { method: 'POST', headers, body: ndjson });
        if (!response.ok || !response.body) {
            this.handleResponseError(response.status);
            let message = 'Import failed';
            try { const e = await response.json(); if (e.error) message = e.error; } catch { /* non-json error body */ }
            throw new Error(message);
        }
        const emit = (raw: string) => {
            let evt: any;
            try { evt = JSON.parse(raw); } catch { return; }
            // Merge re-anchor: adopt the re-issued token before surfacing the event
            // so the next call (e.g. completeSetup / refreshUser) is authenticated.
            if (evt && evt.type === 'reauth' && typeof evt.token === 'string') this.setToken(evt.token);
            onEvent(evt);
        };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) emit(line);
            }
        }
        const tail = buffer.trim();
        if (tail) emit(tail);
    }

    /** Upload an image for a feature (branding, rank, wiki, ...). Posts the raw bytes; the
     *  server checks the signed-in user's permission for that feature, re-encodes the image,
     *  and returns a URL to store (public features) plus the object key + visibility. */
    async uploadOrgMedia(file: File, feature: string): Promise<{ url: string | null; key: string; visibility: 'public' | 'private' }> {
        const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
        const response = await this.trackedFetch(`${API_URL}/org/upload?for=${encodeURIComponent(feature)}`, {
            method: 'POST',
            headers,
            body: file,
        });
        if (!response.ok) {
            this.handleResponseError(response.status);
            let message = 'Upload failed';
            try { const e = await response.json(); if (e.message) message = e.message; } catch { /* non-json error body */ }
            throw new Error(message);
        }
        const data = await response.json();
        return { url: data.url ?? null, key: data.key, visibility: data.visibility };
    }
}

export default new ApiService();
